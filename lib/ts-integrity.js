'use strict';

const fs = require('fs');

const MAX_SCAN_BYTES = 64 * 1024 * 1024; // 무결성 스캔 상한(앞부분 64MB)

const STREAM_TYPES = {
  0x01: 'MPEG-1 Video', 0x02: 'MPEG-2 Video', 0x03: 'MPEG-1 Audio',
  0x04: 'MPEG-2 Audio', 0x0f: 'AAC', 0x11: 'AAC(LATM)', 0x1b: 'H.264',
  0x24: 'H.265', 0x81: 'AC-3', 0x87: 'E-AC-3',
};

/**
 * MPEG-TS/M2TS 파일을 스캔해 패킷 정합성·PAT/PMT·연속성 카운터를 검사한다.
 * @param {string} filePath TS 파일 경로
 * @returns {Promise<object>} 스캔 결과
 */
async function scanTsFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  const fileSize = stat.size;
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const readLen = Math.min(fileSize, MAX_SCAN_BYTES);
    const buf = Buffer.allocUnsafe(readLen);
    await fh.read(buf, 0, readLen, 0);
    const layout = detectLayout(buf);
    if (!layout) return { valid: false, fileSize };
    const scan = scanPackets(buf, layout);
    return { valid: true, fileSize, packetSize: layout.size, partial: readLen < fileSize, ...scan };
  } finally {
    await fh.close();
  }
}

/**
 * 전송 패킷 크기(188/192/204)와 첫 동기 위치를 탐지한다.
 * @param {Buffer} buf 파일 바이트
 * @returns {{size:number, start:number}|null} 레이아웃 또는 null
 */
function detectLayout(buf) {
  const sizes = [188, 192, 204];
  for (const size of sizes) {
    for (let start = 0; start <= 204 && start + size * 5 < buf.length; start += 1) {
      if (buf[start] !== 0x47) continue;
      let ok = true;
      for (let k = 1; k <= 5; k += 1) {
        if (buf[start + k * size] !== 0x47) { ok = false; break; }
      }
      if (ok) return { size, start };
    }
  }
  return null;
}

/**
 * 패킷을 순차 검사해 통계·오류를 집계한다.
 * @param {Buffer} buf 파일 바이트
 * @param {{size:number, start:number}} layout 패킷 레이아웃
 * @returns {object} 스캔 통계
 */
function scanPackets(buf, layout) {
  const pids = new Set();
  const programs = [];
  const pmtPids = new Set();
  const streams = [];
  const cc = new Map();
  let packets = 0;
  let syncErrors = 0;
  let teiCount = 0;
  let ccErrors = 0;
  let scrambled = 0;
  let hasPat = false;
  let hasPmt = false;

  let offset = layout.start;
  while (offset + layout.size <= buf.length) {
    if (buf[offset] !== 0x47) { syncErrors += 1; offset += 1; continue; }
    const b1 = buf[offset + 1];
    const b2 = buf[offset + 2];
    const b3 = buf[offset + 3];
    const tei = (b1 & 0x80) !== 0;
    const pusi = (b1 & 0x40) !== 0;
    const pid = ((b1 & 0x1f) << 8) | b2;
    const scrambling = (b3 & 0xc0) >> 6;
    const afc = (b3 & 0x30) >> 4;
    const ccVal = b3 & 0x0f;
    const hasPayload = (afc & 0x1) !== 0;
    let payloadOffset = offset + 4;
    if ((afc & 0x2) !== 0) payloadOffset = offset + 5 + buf[offset + 4];

    packets += 1;
    pids.add(pid);
    if (tei) teiCount += 1;
    if (scrambling) scrambled += 1;
    if (hasPayload) {
      const prev = cc.get(pid);
      if (prev !== undefined && ccVal !== prev && ccVal !== ((prev + 1) & 0x0f)) ccErrors += 1;
      cc.set(pid, ccVal);
    }

    if (pid === 0 && pusi && hasPayload) {
      hasPat = true;
      parsePat(buf, payloadOffset + 1 + buf[payloadOffset], programs, pmtPids);
    } else if (pmtPids.has(pid) && pusi && hasPayload) {
      const start = payloadOffset + 1 + buf[payloadOffset];
      if (parsePmt(buf, start, streams)) hasPmt = true;
    }
    offset += layout.size;
  }

  return {
    packets, pidCount: pids.size, programs, streams,
    syncErrors, teiCount, ccErrors, scrambled, hasPat, hasPmt,
  };
}

/**
 * PAT를 파싱해 프로그램·PMT PID를 수집한다.
 * @param {Buffer} buf 파일 바이트
 * @param {number} pos 테이블 시작 오프셋
 * @param {Array<object>} programs 프로그램 목록(출력)
 * @param {Set<number>} pmtPids PMT PID 집합(출력)
 * @returns {void}
 */
function parsePat(buf, pos, programs, pmtPids) {
  if (pos + 8 > buf.length || buf[pos] !== 0x00) return;
  const sectionLength = ((buf[pos + 1] & 0x0f) << 8) | buf[pos + 2];
  const end = Math.min(pos + 3 + sectionLength - 4, buf.length);
  let p = pos + 8;
  while (p + 4 <= end) {
    const programNumber = (buf[p] << 8) | buf[p + 1];
    const pid = ((buf[p + 2] & 0x1f) << 8) | buf[p + 3];
    if (programNumber !== 0 && !programs.some((x) => x.programNumber === programNumber)) {
      programs.push({ programNumber, pmtPid: pid });
      pmtPids.add(pid);
    }
    p += 4;
  }
}

/**
 * PMT를 파싱해 엘리멘터리 스트림을 수집한다.
 * @param {Buffer} buf 파일 바이트
 * @param {number} pos 테이블 시작 오프셋
 * @param {Array<object>} streams 스트림 목록(출력)
 * @returns {boolean} 파싱 성공 여부
 */
function parsePmt(buf, pos, streams) {
  if (pos + 12 > buf.length || buf[pos] !== 0x02) return false;
  const sectionLength = ((buf[pos + 1] & 0x0f) << 8) | buf[pos + 2];
  const programInfoLength = ((buf[pos + 10] & 0x0f) << 8) | buf[pos + 11];
  const end = Math.min(pos + 3 + sectionLength - 4, buf.length);
  let p = pos + 12 + programInfoLength;
  while (p + 5 <= end) {
    const streamType = buf[p];
    const esPid = ((buf[p + 1] & 0x1f) << 8) | buf[p + 2];
    const esInfoLength = ((buf[p + 3] & 0x0f) << 8) | buf[p + 4];
    if (!streams.some((s) => s.esPid === esPid)) {
      streams.push({ streamType, esPid, label: STREAM_TYPES[streamType] || `0x${streamType.toString(16)}` });
    }
    p += 5 + esInfoLength;
  }
  return true;
}

module.exports = { scanTsFile };
