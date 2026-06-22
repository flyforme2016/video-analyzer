'use strict';

const fs = require('fs');

/**
 * GIF 파일 구조를 스캔해 프레임·트레일러·잘림 여부를 반환한다.
 * @param {string} filePath GIF 파일 경로
 * @returns {Promise<object>} 스캔 결과
 */
async function scanGifFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  const bytes = new Uint8Array(await fs.promises.readFile(filePath));
  const fileSize = stat.size;

  if (bytes.length < 13 || readAscii(bytes, 0, 3) !== 'GIF') {
    return { valid: false, fileSize, reason: 'signature' };
  }

  const version = readAscii(bytes, 0, 6).slice(3);
  const packed = bytes[10];
  const gctFlag = (packed & 0x80) !== 0;
  const gctPow = (packed & 0x07) + 1;
  const gctColors = 1 << gctPow;
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);

  let pos = 13;
  if (gctFlag) pos += 3 * gctColors;

  let frames = 0;
  let gceCount = 0;
  let hasTrailer = false;
  let truncated = false;
  let badMarker = false;

  while (pos < bytes.length) {
    const marker = bytes[pos];
    if (marker === 0x3b) {
      hasTrailer = true;
      pos += 1;
      break;
    }
    if (marker === 0x21) {
      const block = parseExtension(bytes, pos);
      if (!block) { truncated = true; break; }
      if (bytes[pos + 1] === 0xf9) gceCount += 1;
      pos = block.end;
      continue;
    }
    if (marker === 0x2c) {
      const block = parseImage(bytes, pos, frames);
      if (!block) { truncated = true; break; }
      frames += 1;
      pos = block.end;
      continue;
    }
    badMarker = true;
    break;
  }

  if (!hasTrailer && !truncated && !badMarker && pos < bytes.length) truncated = true;
  const trailingBytes = hasTrailer ? Math.max(0, fileSize - pos) : null;

  return {
    valid: true,
    fileSize,
    version,
    width,
    height,
    frames,
    gceCount,
    hasTrailer,
    truncated,
    badMarker,
    trailingBytes,
    parsedEnd: pos,
  };
}

/**
 * GIF 확장 블록(0x21) 끝 오프셋을 계산한다.
 * @param {Uint8Array} bytes 파일 바이트
 * @param {number} start 시작 오프셋
 * @returns {{end:number}|null} 블록 종료 위치
 */
function parseExtension(bytes, start) {
  if (start + 2 >= bytes.length) return null;
  const label = bytes[start + 1];
  let pos = start + 2;
  if (label === 0xf9) {
    if (pos + 5 > bytes.length) return null;
    pos += 5;
    if (bytes[pos] === 0) pos += 1;
    return { end: pos };
  }
  if (pos >= bytes.length) return null;
  const blockSize = bytes[pos];
  pos += 1 + blockSize;
  const sub = skipSubBlocks(bytes, pos);
  return sub ? { end: sub } : null;
}

/**
 * GIF 이미지 디스크립터(0x2C) 블록 끝 오프셋을 계산한다.
 * @param {Uint8Array} bytes 파일 바이트
 * @param {number} start 시작 오프셋
 * @param {number} frameIdx 프레임 인덱스
 * @returns {{end:number, width:number, height:number}|null} 블록 종료 위치
 */
function parseImage(bytes, start, frameIdx) {
  if (start + 10 > bytes.length) return null;
  const iw = bytes[start + 5] | (bytes[start + 6] << 8);
  const ih = bytes[start + 7] | (bytes[start + 8] << 8);
  const packed = bytes[start + 9];
  const lctFlag = (packed & 0x80) !== 0;
  const lctPow = (packed & 0x07) + 1;
  const lctColors = 1 << lctPow;
  let pos = start + 10;
  if (lctFlag) pos += 3 * lctColors;
  if (pos >= bytes.length) return null;
  pos += 1;
  const sub = skipSubBlocks(bytes, pos);
  return sub ? { end: sub, width: iw, height: ih } : null;
}

/**
 * GIF 서브블록 체인을 건너뛴다.
 * @param {Uint8Array} bytes 파일 바이트
 * @param {number} pos 시작 오프셋
 * @returns {number|null} 체인 종료 직후 오프셋
 */
function skipSubBlocks(bytes, pos) {
  while (pos < bytes.length) {
    const size = bytes[pos];
    pos += 1;
    if (size === 0) return pos;
    pos += size;
    if (pos > bytes.length) return null;
  }
  return null;
}

/**
 * 바이트 범위를 ASCII 문자열로 읽는다.
 * @param {Uint8Array} bytes 바이트 배열
 * @param {number} start 시작 오프셋
 * @param {number} len 길이
 * @returns {string} ASCII 문자열
 */
function readAscii(bytes, start, len) {
  let s = '';
  for (let i = 0; i < len; i += 1) s += String.fromCharCode(bytes[start + i]);
  return s;
}

module.exports = { scanGifFile };
