'use strict';

const fs = require('fs');

/**
 * MP4 파일을 스트리밍 방식으로 스캔하고 비디오 샘플 인덱스를 추출한다.
 * 전체 파일을 메모리에 올리지 않는다.
 */

/**
 * 파일의 최상위 박스 목록을 헤더만 읽어 스캔한다.
 * @param {string} filePath MP4/MOV 파일 경로
 * @returns {Promise<{fileSize:number, boxes:Array<object>}>} 파일 크기와 박스 목록
 */
async function scanTopLevelBoxes(filePath) {
  const stat = await fs.promises.stat(filePath);
  const fileSize = stat.size;
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const boxes = [];
    let offset = 0;
    while (offset + 8 <= fileSize) {
      const hdr = Buffer.allocUnsafe(16);
      await fh.read(hdr, 0, 16, offset);
      let size = hdr.readUInt32BE(0);
      const type = hdr.toString('ascii', 4, 8);
      let headerSize = 8;
      if (size === 1) {
        size = Number(hdr.readBigUInt64BE(8));
        headerSize = 16;
      } else if (size === 0) {
        size = fileSize - offset;
      }
      if (size < headerSize) break;
      boxes.push({ type, offset, size, headerSize, end: offset + size });
      if (size <= 0) break;
      offset += size;
    }
    return { fileSize, boxes };
  } finally {
    await fh.close();
  }
}

/**
 * moov 박스 바이트를 파일에서 읽는다(앞 또는 끝에 위치).
 * @param {string} filePath 파일 경로
 * @param {Array<object>} boxes 최상위 박스 목록
 * @param {number} fileSize 파일 크기
 * @returns {Promise<Buffer|null>} moov 박스 페이로드+헤더 버퍼
 */
async function readMoovBox(filePath, boxes, fileSize) {
  const moov = boxes.find((b) => b.type === 'moov');
  if (!moov) return null;
  if (moov.end <= fileSize) {
    return readRange(filePath, moov.offset, moov.size);
  }
  const tailSize = Math.min(32 * 1024 * 1024, fileSize);
  const tail = await readRange(filePath, fileSize - tailSize, tailSize);
  const idx = tail.indexOf(Buffer.from('moov'));
  if (idx < 4) return null;
  const startInTail = idx - 4;
  const size = tail.readUInt32BE(startInTail);
  const absStart = fileSize - tailSize + startInTail;
  return readRange(filePath, absStart, size);
}

/**
 * moov 버퍼에서 비디오 트랙 샘플 목록과 avcC lengthSize를 추출한다.
 * @param {Buffer} moovBuf moov 박스 전체 바이트
 * @returns {{lengthSize:number, samples:Array<object>}|null} 샘플 인덱스
 */
function extractVideoSampleIndex(moovBuf) {
  const boxes = parseBoxesFlat(moovBuf, 0, moovBuf.length);
  const trak = findVideoTrak(boxes);
  if (!trak) return null;
  const stbl = findDescendantBox(trak, 'stbl');
  if (!stbl) return null;
  const stco = findDescendantBox(stbl, 'stco') || findDescendantBox(stbl, 'co64');
  const stsz = findDescendantBox(stbl, 'stsz');
  const stsc = findDescendantBox(stbl, 'stsc');
  const stss = findDescendantBox(stbl, 'stss');
  if (!stco || !stsz || !stsc) return null;

  const lengthSize = readAvcLengthSize(stbl);
  const sizes = readStsz(stsz.buf, stsz.dataStart);
  const chunks = readStco(stco);
  const stscEntries = readStsc(stsc.buf, stsc.dataStart);
  const keyframes = readStss(stss);

  const samples = buildSamples(chunks, stscEntries, sizes);
  samples.forEach((s, i) => {
    s.index = i + 1;
    s.keyframe = keyframes.has(i + 1);
  });
  return { lengthSize, samples };
}

/**
 * 샘플 목록을 파일에서 읽어 반환한다.
 * @param {string} filePath 파일 경로
 * @param {object} sample 샘플 객체(offset, size)
 * @returns {Promise<Buffer>} 샘플 바이트
 */
async function readSampleBytes(filePath, sample) {
  return readRange(filePath, sample.offset, sample.size);
}

/**
 * 파일의 지정 범위를 읽는다.
 * @param {string} filePath 파일 경로
 * @param {number} offset 시작 오프셋
 * @param {number} length 길이
 * @returns {Promise<Buffer>} 읽은 버퍼
 */
async function readRange(filePath, offset, length) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    await fh.read(buf, 0, length, offset);
    return buf;
  } finally {
    await fh.close();
  }
}

/**
 * stco/co64 + stsc + stsz로 샘플 절대 오프셋 목록을 만든다.
 * @param {Array<{offset:number}>} chunks 청크 오프셋
 * @param {Array<object>} stscEntries stsc 엔트리
 * @param {Array<number>} sizes 샘플 크기
 * @returns {Array<{offset:number,size:number}>} 샘플 배열
 */
function buildSamples(chunks, stscEntries, sizes) {
  const samples = [];
  let sampleIdx = 0;
  let stscIdx = 0;
  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx += 1) {
    const chunkNum = chunkIdx + 1;
    while (stscIdx + 1 < stscEntries.length && chunkNum >= stscEntries[stscIdx + 1].firstChunk) {
      stscIdx += 1;
    }
    const perChunk = stscEntries[stscIdx].samplesPerChunk;
    let pos = chunks[chunkIdx].offset;
    for (let j = 0; j < perChunk && sampleIdx < sizes.length; j += 1) {
      samples.push({ offset: pos, size: sizes[sampleIdx] });
      pos += sizes[sampleIdx];
      sampleIdx += 1;
    }
  }
  return samples;
}

/**
 * stsz 박스에서 샘플 크기 배열을 읽는다.
 * @param {Buffer} buf stsz 박스 버퍼
 * @param {number} dataStart 데이터 시작
 * @returns {Array<number>} 샘플 크기
 */
function readStsz(buf, dataStart) {
  const base = dataStart + 4;
  const count = buf.readUInt32BE(base + 4);
  const global = buf.readUInt32BE(base);
  if (global !== 0) return Array.from({ length: count }, () => global);
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(buf.readUInt32BE(base + 8 + i * 4));
  return out;
}

/**
 * stco/co64에서 청크 오프셋을 읽는다.
 * @param {object} stco stco/co64 박스 정보
 * @returns {Array<{offset:number}>} 청크 목록
 */
function readStco(stco) {
  const base = stco.dataStart + 4;
  const count = stco.buf.readUInt32BE(base);
  const is64 = stco.type === 'co64';
  const out = [];
  let p = base + 4;
  for (let i = 0; i < count; i += 1) {
    if (is64) {
      out.push({ offset: Number(stco.buf.readBigUInt64BE(p)) });
      p += 8;
    } else {
      out.push({ offset: stco.buf.readUInt32BE(p) });
      p += 4;
    }
  }
  return out;
}

/**
 * stsc 엔트리를 읽는다.
 * @param {Buffer} buf stsc 버퍼
 * @param {number} dataStart 데이터 시작
 * @returns {Array<object>} stsc 엔트리
 */
function readStsc(buf, dataStart) {
  const base = dataStart + 4;
  const count = buf.readUInt32BE(base);
  const out = [];
  let p = base + 4;
  for (let i = 0; i < count; i += 1) {
    out.push({
      firstChunk: buf.readUInt32BE(p),
      samplesPerChunk: buf.readUInt32BE(p + 4),
      sampleDescIdx: buf.readUInt32BE(p + 8),
    });
    p += 12;
  }
  return out;
}

/**
 * stss 키프레임 샘플 번호 집합을 읽는다.
 * @param {object|null} stss stss 박스
 * @returns {Set<number>} 1-based 키프레임 샘플 번호
 */
function readStss(stss) {
  const set = new Set();
  if (!stss) return set;
  const base = stss.dataStart + 4;
  const count = stss.buf.readUInt32BE(base);
  let p = base + 4;
  for (let i = 0; i < count; i += 1) {
    set.add(stss.buf.readUInt32BE(p));
    p += 4;
  }
  return set;
}

/**
 * stsd/avc1에서 NAL lengthSize를 읽는다(기본 4).
 * @param {object} stbl stbl 박스
 * @returns {number} lengthSize(1|2|4)
 */
function readAvcLengthSize(stbl) {
  const stsd = findDescendantBox(stbl, 'stsd');
  if (!stsd) return 4;
  const avc1 = findDescendantBox(stsd, 'avc1') || findDescendantBox(stsd, 'avc3');
  if (!avc1) return 4;
  const avcC = findDescendantBox(avc1, 'avcC');
  if (!avcC || avcC.dataStart + 4 >= avcC.buf.length) return 4;
  const len = (avcC.buf.readUInt8(avcC.dataStart + 4) & 0x03) + 1;
  return len === 1 || len === 2 || len === 4 ? len : 4;
}

/**
 * 비디오 트랙 trak 박스를 찾는다.
 * @param {Array<object>} boxes moov 하위 플랫 박스
 * @returns {object|null} trak
 */
function findVideoTrak(boxes) {
  const traks = boxes.filter((b) => b.type === 'trak');
  for (const trak of traks) {
    const hdlr = findDescendantBox(trak, 'hdlr');
    if (hdlr && hdlr.buf.toString('ascii', hdlr.dataStart + 8, hdlr.dataStart + 12) === 'vide') return trak;
  }
  return traks[0] || null;
}

/**
 * 하위 트리에서 타입으로 박스를 재귀 검색한다.
 * @param {object} parent 부모 박스
 * @param {string} type 박스 타입
 * @returns {object|null} 찾은 박스
 */
function findDescendantBox(parent, type) {
  for (const c of parent.children || []) {
    if (c.type === type) return c;
    const found = findDescendantBox(c, type);
    if (found) return found;
  }
  return null;
}

/**
 * 부모의 직접 자식 박스를 타입으로 찾는다.
 * @param {object} parent 부모 박스
 * @param {string} type 박스 타입
 * @returns {object|null} 자식 박스
 */
function findChildBox(parent, type) {
  return (parent.children || []).find((c) => c.type === type) || null;
}

/**
 * 버퍼 범위의 박스를 플랫 트리로 파싱한다.
 * @param {Buffer} buf 버퍼
 * @param {number} start 시작
 * @param {number} end 끝
 * @returns {Array<object>} 박스 트리
 */
function parseBoxesFlat(buf, start, end) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) size = end - offset;
    const boxEnd = Math.min(offset + size, end);
    const node = {
      type, offset, size, headerSize, end: boxEnd,
      dataStart: offset + headerSize, dataEnd: boxEnd,
      buf, children: [],
    };
    const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'avc1', 'avc3', 'hev1', 'hvc1', 'sinf']);
    if (containers.has(type) || type === 'avc1' || type === 'avc3' || type === 'hev1' || type === 'hvc1') {
      const childStart = fullBoxPayloadStart(type, node.dataStart);
      node.children = parseBoxesFlat(buf, childStart, boxEnd);
    }
    boxes.push(node);
    offset = boxEnd;
  }
  return boxes;
}

/**
 * FullBox 타입인지 판별한다.
 * @param {string} type 박스 4글자 타입
 * @returns {boolean} FullBox이면 true
 */
function isFullBox(type) {
  return ['mdhd', 'hdlr', 'stsd', 'stts', 'stsc', 'stsz', 'stco', 'co64', 'stss', 'ctts'].includes(type);
}

/**
 * FullBox 타입별 자식 파싱 시작 오프셋을 반환한다.
 * @param {string} type 박스 타입
 * @param {number} dataStart 데이터 시작 오프셋
 * @returns {number} 자식 박스 시작 오프셋
 */
function fullBoxPayloadStart(type, dataStart) {
  if (type === 'stsd') return dataStart + 8;
  if (isFullBox(type)) return dataStart + 4;
  return dataStart;
}

module.exports = {
  scanTopLevelBoxes,
  readMoovBox,
  extractVideoSampleIndex,
  readSampleBytes,
};
