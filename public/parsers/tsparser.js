'use strict';

/**
 * MPEG-TS / M2TS 컨테이너 파서.
 * 188/192/204바이트 전송 패킷을 스캔해 PAT·PMT·PID 통계를 트리로 반환한다.
 */
(function (global) {
  const MAX_PACKETS = 600000; // 스캔할 최대 패킷 수(대용량 보호)
  const MAX_PID_NODES = 64; // 트리에 표시할 최대 PID 수

  const STREAM_TYPES = {
    0x01: 'MPEG-1 Video', 0x02: 'MPEG-2 Video', 0x03: 'MPEG-1 Audio',
    0x04: 'MPEG-2 Audio', 0x0f: 'AAC (ADTS)', 0x11: 'AAC (LATM)',
    0x15: 'Metadata', 0x1b: 'H.264 (AVC)', 0x20: 'H.264 (MVC)',
    0x24: 'H.265 (HEVC)', 0x42: 'AVS', 0x81: 'AC-3', 0x82: 'DTS',
    0x83: 'Dolby TrueHD', 0x86: 'SCTE-35', 0x87: 'E-AC-3',
  };

  /**
   * TS 버퍼를 파싱하여 최상위 노드 배열을 반환한다.
   * @param {ArrayBuffer} buffer 파싱할 TS 바이트
   * @returns {{boxes: Array<object>, truncated: boolean, byteLength: number}} 트리와 메타정보
   */
  function parse(buffer) {
    const bytes = new Uint8Array(buffer);
    const layout = detectLayout(bytes);
    if (!layout) return { boxes: [], truncated: false, byteLength: buffer.byteLength };

    const scan = scanPackets(bytes, layout);
    const boxes = buildTree(bytes, layout, scan);
    return { boxes, truncated: scan.truncated, byteLength: buffer.byteLength };
  }

  /**
   * 전송 패킷 크기(188/192/204)와 첫 동기 바이트 위치를 탐지한다.
   * @param {Uint8Array} bytes 파일 바이트
   * @returns {{size:number, start:number}|null} 패킷 레이아웃 또는 null
   */
  function detectLayout(bytes) {
    const sizes = [188, 192, 204];
    for (const size of sizes) {
      for (let start = 0; start <= 204 && start + size * 5 < bytes.length; start += 1) {
        if (bytes[start] !== 0x47) continue;
        let ok = true;
        for (let k = 1; k <= 5; k += 1) {
          if (bytes[start + k * size] !== 0x47) { ok = false; break; }
        }
        if (ok) return { size, start };
      }
    }
    return null;
  }

  /**
   * 패킷을 순차 스캔하여 PID 통계·PAT·PMT를 수집한다.
   * @param {Uint8Array} bytes 파일 바이트
   * @param {{size:number, start:number}} layout 패킷 레이아웃
   * @returns {object} 스캔 결과
   */
  function scanPackets(bytes, layout) {
    const pids = new Map();
    const programs = []; // {programNumber, pmtPid, offset}
    const pmts = []; // {programNumber, pcrPid, streams, offset}
    const pmtPids = new Set();
    const cc = new Map();
    let packets = 0;
    let teiCount = 0;
    let ccErrors = 0;
    let scrambled = 0;
    let truncated = false;

    let offset = layout.start;
    while (offset + layout.size <= bytes.length) {
      if (bytes[offset] !== 0x47) { truncated = true; break; }
      if (packets >= MAX_PACKETS) { truncated = true; break; }
      const h = parseHeader(bytes, offset);
      packets += 1;
      tallyPid(pids, h);
      if (h.tei) teiCount += 1;
      if (h.scrambling) scrambled += 1;
      ccErrors += checkContinuity(cc, h);

      if (h.pid === 0 && h.pusi && h.hasPayload) {
        parsePat(bytes, h.payloadOffset, programs, pmtPids, offset);
      } else if (pmtPids.has(h.pid) && h.pusi && h.hasPayload && !pmts.some((p) => p.pid === h.pid)) {
        const pmt = parsePmt(bytes, h.payloadOffset, h.pid, offset);
        if (pmt) pmts.push(pmt);
      }
      offset += layout.size;
    }

    return { pids, programs, pmts, packets, teiCount, ccErrors, scrambled, truncated };
  }

  /**
   * 단일 패킷의 4바이트 헤더를 해석한다.
   * @param {Uint8Array} bytes 파일 바이트
   * @param {number} offset 패킷(동기 바이트) 시작 오프셋
   * @returns {object} 헤더 정보
   */
  function parseHeader(bytes, offset) {
    const b1 = bytes[offset + 1];
    const b2 = bytes[offset + 2];
    const b3 = bytes[offset + 3];
    const tei = (b1 & 0x80) !== 0;
    const pusi = (b1 & 0x40) !== 0;
    const pid = ((b1 & 0x1f) << 8) | b2;
    const scrambling = (b3 & 0xc0) >> 6;
    const afc = (b3 & 0x30) >> 4;
    const cc = b3 & 0x0f;
    const hasAdaptation = (afc & 0x2) !== 0;
    const hasPayload = (afc & 0x1) !== 0;
    let payloadOffset = offset + 4;
    if (hasAdaptation) {
      const afLen = bytes[offset + 4];
      payloadOffset = offset + 5 + afLen;
    }
    if (hasPayload && pusi && payloadOffset < bytes.length) {
      payloadOffset += 1 + bytes[payloadOffset]; // pointer_field
    }
    return { offset, tei, pusi, pid, scrambling, afc, cc, hasAdaptation, hasPayload, payloadOffset };
  }

  /**
   * PID 통계를 누적한다.
   * @param {Map<number,object>} pids PID 통계 맵
   * @param {object} h 패킷 헤더
   * @returns {void}
   */
  function tallyPid(pids, h) {
    let s = pids.get(h.pid);
    if (!s) { s = { pid: h.pid, count: 0, firstOffset: h.offset, scrambled: false }; pids.set(h.pid, s); }
    s.count += 1;
    if (h.scrambling) s.scrambled = true;
  }

  /**
   * 연속성 카운터(CC) 오류를 검출한다.
   * @param {Map<number,number>} cc PID별 마지막 CC 맵
   * @param {object} h 패킷 헤더
   * @returns {number} 오류면 1, 아니면 0
   */
  function checkContinuity(cc, h) {
    if (!h.hasPayload) return 0;
    const prev = cc.get(h.pid);
    cc.set(h.pid, h.cc);
    if (prev === undefined) return 0;
    if (h.cc === prev) return 0; // 중복 허용
    return h.cc === ((prev + 1) & 0x0f) ? 0 : 1;
  }

  /**
   * PAT(Program Association Table)를 파싱한다.
   * @param {Uint8Array} bytes 파일 바이트
   * @param {number} pos 페이로드(테이블) 시작 오프셋
   * @param {Array<object>} programs 프로그램 목록(출력)
   * @param {Set<number>} pmtPids PMT PID 집합(출력)
   * @param {number} pktOffset 패킷 오프셋(필드 참조용)
   * @returns {void}
   */
  function parsePat(bytes, pos, programs, pmtPids, pktOffset) {
    if (pos + 8 > bytes.length || bytes[pos] !== 0x00) return;
    const sectionLength = ((bytes[pos + 1] & 0x0f) << 8) | bytes[pos + 2];
    const end = pos + 3 + sectionLength - 4; // CRC 제외
    let p = pos + 8;
    while (p + 4 <= end && p + 4 <= bytes.length) {
      const programNumber = (bytes[p] << 8) | bytes[p + 1];
      const pid = ((bytes[p + 2] & 0x1f) << 8) | bytes[p + 3];
      if (programNumber !== 0) {
        if (!programs.some((x) => x.programNumber === programNumber)) {
          programs.push({ programNumber, pmtPid: pid, offset: pktOffset });
        }
        pmtPids.add(pid);
      }
      p += 4;
    }
  }

  /**
   * PMT(Program Map Table)를 파싱한다.
   * @param {Uint8Array} bytes 파일 바이트
   * @param {number} pos 페이로드(테이블) 시작 오프셋
   * @param {number} pid PMT PID
   * @param {number} pktOffset 패킷 오프셋(필드 참조용)
   * @returns {object|null} PMT 정보 또는 null
   */
  function parsePmt(bytes, pos, pid, pktOffset) {
    if (pos + 12 > bytes.length || bytes[pos] !== 0x02) return null;
    const sectionLength = ((bytes[pos + 1] & 0x0f) << 8) | bytes[pos + 2];
    const programNumber = (bytes[pos + 3] << 8) | bytes[pos + 4];
    const pcrPid = ((bytes[pos + 8] & 0x1f) << 8) | bytes[pos + 9];
    const programInfoLength = ((bytes[pos + 10] & 0x0f) << 8) | bytes[pos + 11];
    const end = pos + 3 + sectionLength - 4;
    let p = pos + 12 + programInfoLength;
    const streams = [];
    while (p + 5 <= end && p + 5 <= bytes.length) {
      const streamType = bytes[p];
      const esPid = ((bytes[p + 1] & 0x1f) << 8) | bytes[p + 2];
      const esInfoLength = ((bytes[p + 3] & 0x0f) << 8) | bytes[p + 4];
      streams.push({ streamType, esPid });
      p += 5 + esInfoLength;
    }
    return { pid, programNumber, pcrPid, streams, offset: pktOffset };
  }

  // ------- 트리 빌드 -------

  /**
   * 스캔 결과로 트리 노드 배열을 만든다.
   * @param {Uint8Array} bytes 파일 바이트
   * @param {{size:number, start:number}} layout 패킷 레이아웃
   * @param {object} scan 스캔 결과
   * @returns {Array<object>} 트리 노드 배열
   */
  function buildTree(bytes, layout, scan) {
    const boxes = [];
    const kindName = layout.size === 192 ? 'M2TS' : layout.size === 204 ? 'TS(204/FEC)' : 'MPEG-TS';
    boxes.push(makeLeaf('TS', layout.start, layout.size,
      `${kindName} · 패킷 ${layout.size}B · ${scan.packets.toLocaleString()}개 · PID ${scan.pids.size}종 · 프로그램 ${scan.programs.length}`,
      [
        field(layout.start, 1, 'sync_byte', '0x47', bytes),
        { offset: layout.start, length: 0, name: 'packet_size', value: `${layout.size} bytes`, hex: '' },
        { offset: layout.start, length: 0, name: 'packets', value: String(scan.packets), hex: '' },
        { offset: layout.start, length: 0, name: 'tei_packets', value: String(scan.teiCount), hex: '' },
        { offset: layout.start, length: 0, name: 'cc_errors', value: String(scan.ccErrors), hex: '' },
      ]));

    if (scan.programs.length) {
      const first = scan.programs[0];
      boxes.push(makeContainer('PAT', first.offset, layout.size, `PAT · 프로그램 ${scan.programs.length}개`,
        scan.programs.map((pr) => makeLeaf('PROG', pr.offset, 0,
          `프로그램 ${pr.programNumber} → PMT PID ${fmtPid(pr.pmtPid)}`,
          [{ offset: pr.offset, length: 0, name: 'program_number', value: String(pr.programNumber), hex: '' },
            { offset: pr.offset, length: 0, name: 'pmt_pid', value: fmtPid(pr.pmtPid), hex: '' }]))));
    }

    for (const pmt of scan.pmts) {
      boxes.push(makeContainer('PMT', pmt.offset, layout.size,
        `PMT(프로그램 ${pmt.programNumber}) · PCR PID ${fmtPid(pmt.pcrPid)} · ES ${pmt.streams.length}개`,
        pmt.streams.map((es) => makeLeaf('ES', pmt.offset, 0,
          `${STREAM_TYPES[es.streamType] || 'type 0x' + es.streamType.toString(16)} · PID ${fmtPid(es.esPid)}`,
          [{ offset: pmt.offset, length: 0, name: 'stream_type', value: `0x${es.streamType.toString(16)} (${STREAM_TYPES[es.streamType] || '알 수 없음'})`, hex: '' },
            { offset: pmt.offset, length: 0, name: 'elementary_pid', value: fmtPid(es.esPid), hex: '' }]))));
    }

    boxes.push(buildPidNode(bytes, scan));
    return boxes;
  }

  /**
   * PID 통계 컨테이너 노드를 만든다.
   * @param {Uint8Array} bytes 파일 바이트
   * @param {object} scan 스캔 결과
   * @returns {object} PID 컨테이너 노드
   */
  function buildPidNode(bytes, scan) {
    const sorted = Array.from(scan.pids.values()).sort((a, b) => b.count - a.count);
    const shown = sorted.slice(0, MAX_PID_NODES);
    const children = shown.map((s) => makeLeaf('PID', s.firstOffset, 0,
      `PID ${fmtPid(s.pid)}${pidRole(s.pid, scan)} · ${s.count.toLocaleString()}패킷${s.scrambled ? ' · 스크램블' : ''}`,
      [{ offset: s.firstOffset, length: 0, name: 'pid', value: fmtPid(s.pid), hex: '' },
        { offset: s.firstOffset, length: 0, name: 'packets', value: String(s.count), hex: '' }]));
    if (sorted.length > shown.length) {
      children.push(makeLeaf('…', 0, 0, `외 ${sorted.length - shown.length}개 PID 생략`, []));
    }
    return makeContainer('PIDS', 0, 0, `PID 통계 · ${scan.pids.size}종`, children);
  }

  /**
   * PID의 역할(PAT/PMT/PCR/null 등)을 라벨로 반환한다.
   * @param {number} pid PID 값
   * @param {object} scan 스캔 결과
   * @returns {string} 역할 라벨(접두 공백 포함)
   */
  function pidRole(pid, scan) {
    if (pid === 0) return ' (PAT)';
    if (pid === 0x1fff) return ' (null)';
    if (scan.programs.some((p) => p.pmtPid === pid)) return ' (PMT)';
    for (const pmt of scan.pmts) {
      if (pmt.pcrPid === pid) return ' (PCR)';
      const es = pmt.streams.find((e) => e.esPid === pid);
      if (es) return ` (${STREAM_TYPES[es.streamType] || 'ES'})`;
    }
    return '';
  }

  // ------- 헬퍼 -------

  /**
   * PID를 16진수/10진수 병기로 포맷한다.
   * @param {number} pid PID 값
   * @returns {string} 포맷 문자열
   */
  function fmtPid(pid) {
    return `0x${pid.toString(16).padStart(4, '0')} (${pid})`;
  }

  /**
   * 자식이 있는 컨테이너 노드를 생성한다.
   * @param {string} type 노드 타입 코드
   * @param {number} start 시작 오프셋
   * @param {number} size 바이트 길이
   * @param {string} label 라벨
   * @param {Array<object>} children 자식 노드 배열
   * @returns {object} 컨테이너 노드
   */
  function makeContainer(type, start, size, label, children) {
    return {
      type, size, start, end: start + size, headerSize: 0,
      dataStart: start, dataEnd: start + size,
      label, fields: [], children, hasChildren: children.length > 0, truncated: false,
    };
  }

  /**
   * 리프 노드를 생성한다(다른 파서와 동일한 트리 노드 형태).
   * @param {string} type 노드 타입 코드
   * @param {number} start 시작 오프셋
   * @param {number} size 바이트 길이
   * @param {string} label 라벨
   * @param {Array<object>} fields 필드 배열
   * @returns {object} 리프 노드
   */
  function makeLeaf(type, start, size, label, fields) {
    return {
      type, size, start, end: start + size, headerSize: 0,
      dataStart: start, dataEnd: start + size,
      label, fields, children: [], hasChildren: false, truncated: false,
    };
  }

  /**
   * 절대 오프셋 기반 필드 주석을 생성한다.
   * @param {number} offset 절대 오프셋
   * @param {number} length 바이트 길이
   * @param {string} name 필드 이름
   * @param {string} value 해석값
   * @param {Uint8Array} bytes 바이트 배열
   * @returns {{offset:number,length:number,name:string,value:string,hex:string}} 필드
   */
  function field(offset, length, name, value, bytes) {
    const parts = [];
    const end = Math.min(offset + length, bytes.length);
    for (let i = offset; i < end; i += 1) parts.push(bytes[i].toString(16).padStart(2, '0'));
    return { offset, length, name, value, hex: parts.join(' ') };
  }

  global.TsParser = { parse, detectLayout };
})(typeof window !== 'undefined' ? window : globalThis);
