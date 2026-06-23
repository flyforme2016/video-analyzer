'use strict';

const fs = require('fs');

const TAG_HEADER = 11;
const FLV_HEADER = 9;

/**
 * FLV 파일을 스트리밍 스캔해 헤더·태그·타임스탬프 정합성을 검사한다.
 * @param {string} filePath FLV 파일 경로
 * @returns {Promise<object>} 스캔 결과
 */
async function scanFlvFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  const fileSize = stat.size;
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const header = await readHeader(fh);
    if (!header.valid) return { valid: false, fileSize };

    const scan = await scanTags(fh, header.dataOffset, fileSize);
    return { valid: true, fileSize, ...header, ...scan };
  } finally {
    await fh.close();
  }
}

/**
 * FLV 9바이트 헤더를 읽는다.
 * @param {fs.promises.FileHandle} fh 파일 핸들
 * @returns {Promise<{valid:boolean,version:number,hasAudio:boolean,hasVideo:boolean,dataOffset:number}>} 헤더 정보
 */
async function readHeader(fh) {
  const buf = Buffer.allocUnsafe(FLV_HEADER);
  const { bytesRead } = await fh.read(buf, 0, FLV_HEADER, 0);
  if (bytesRead < FLV_HEADER || buf.toString('ascii', 0, 3) !== 'FLV') {
    return { valid: false, version: 0, hasAudio: false, hasVideo: false, dataOffset: FLV_HEADER };
  }
  const version = buf[3];
  const flags = buf[4];
  const dataOffset = buf.readUInt32BE(5);
  return {
    valid: true,
    version,
    hasAudio: (flags & 0x04) !== 0,
    hasVideo: (flags & 0x01) !== 0,
    dataOffset: dataOffset >= FLV_HEADER ? dataOffset : FLV_HEADER,
  };
}

/**
 * 태그 스트림을 순차 스캔하며 통계·타임스탬프 역전·PreviousTagSize 정합성을 수집한다.
 * @param {fs.promises.FileHandle} fh 파일 핸들
 * @param {number} start 첫 PreviousTagSize 시작 오프셋
 * @param {number} fileSize 파일 크기
 * @returns {Promise<object>} 태그 스캔 통계
 */
async function scanTags(fh, start, fileSize) {
  const counts = { audio: 0, video: 0, script: 0, keyframes: 0 };
  let offset = start + 4;
  let lastTimestamp = 0;
  let backwards = 0;
  let prevSizeMismatch = 0;
  let truncated = false;
  let badType = 0;
  const hdr = Buffer.allocUnsafe(TAG_HEADER);
  const prev = Buffer.allocUnsafe(4);

  while (offset + TAG_HEADER <= fileSize) {
    const { bytesRead } = await fh.read(hdr, 0, TAG_HEADER, offset);
    if (bytesRead < TAG_HEADER) { truncated = true; break; }
    const tagType = hdr[0];
    const dataSize = (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
    const ts = ((hdr[4] << 16) | (hdr[5] << 8) | hdr[6]) | (hdr[7] << 24);
    const bodyEnd = offset + TAG_HEADER + dataSize;
    if (bodyEnd + 4 > fileSize) { truncated = true; break; }

    if (tagType === 8) counts.audio += 1;
    else if (tagType === 9) counts.video += 1;
    else if (tagType === 18) counts.script += 1;
    else badType += 1;

    if (tagType === 9 && dataSize > 0) {
      const fb = Buffer.allocUnsafe(1);
      await fh.read(fb, 0, 1, offset + TAG_HEADER);
      const frameType = (fb[0] >> 4) & 0x0f;
      if (frameType === 1 || frameType === 4) counts.keyframes += 1;
    }

    const tsNorm = ts >>> 0;
    if (tagType !== 18 && tsNorm + 1 < lastTimestamp) backwards += 1;
    lastTimestamp = Math.max(lastTimestamp, tsNorm);

    await fh.read(prev, 0, 4, bodyEnd);
    const declaredPrev = prev.readUInt32BE(0);
    if (declaredPrev !== dataSize + TAG_HEADER) prevSizeMismatch += 1;

    offset = bodyEnd + 4;
  }

  const trailingBytes = Math.max(0, fileSize - offset);
  return {
    counts,
    lastTimestamp,
    backwards,
    prevSizeMismatch,
    truncated,
    badType,
    trailingBytes,
    parsedEnd: offset,
  };
}

module.exports = { scanFlvFile };
