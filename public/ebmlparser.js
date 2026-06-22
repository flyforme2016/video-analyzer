'use strict';

/**
 * WebM/Matroska(EBML) 컨테이너 파서.
 * EBML 엘리먼트 트리와 주요 필드 주석을 반환한다.
 */
(function (global) {
  const MASTER = new Set([
    0x1a45dfa3, 0x18538067, 0x114d9b74, 0x4dbb, 0x1549a966, 0x1654ae6b,
    0xae, 0x1f43b675, 0x1254c367, 0x1043a770, 0x1920, 0x67c8, 0x61a7, 0x41e4,
  ]);

  const NAMES = {
    0x1a45dfa3: 'EBML',
    0x4286: 'DocType',
    0x4287: 'DocTypeReadVersion',
    0x42f7: 'EBMLVersion',
    0x42f2: 'EBMLReadVersion',
    0x42f3: 'EBMLMaxIDLength',
    0x42f9: 'EBMLMaxSizeLength',
    0x18538067: 'Segment',
    0x114d9b74: 'SeekHead',
    0x4dbb: 'Seek',
    0x53ab: 'SeekID',
    0x53ac: 'SeekPosition',
    0x1549a966: 'Info',
    0x2ad7b1: 'TimecodeScale',
    0x4489: 'Duration',
    0x7ba9: 'Title',
    0x1654ae6b: 'Tracks',
    0xae: 'TrackEntry',
    0xd7: 'TrackNumber',
    0x83: 'TrackType',
    0x86: 'CodecID',
    0x258688: 'CodecPrivate',
    0xe0: 'PixelWidth',
    0xba: 'PixelHeight',
    0x1f43b675: 'Cluster',
    0xe7: 'Timecode',
    0xa3: 'SimpleBlock',
    0xa7: 'Position',
    0xab: 'PrevSize',
    0x1254c367: 'Cues',
    0xbb: 'CuePoint',
    0xb3: 'CueTime',
  };

  const TYPE_LABELS = {
    EBML: 'EBML 헤더',
    Segment: '세그먼트(본문)',
    SeekHead: '시크 테이블',
    Info: '파일 정보',
    Tracks: '트랙 목록',
    TrackEntry: '트랙 엔트리',
    Cluster: '클러스터(프레임 묶음)',
    SimpleBlock: '심플 블록(프레임)',
    Cues: '큐 인덱스',
  };

  /**
   * ArrayBuffer를 파싱하여 최상위 EBML 엘리먼트 배열을 반환한다.
   * @param {ArrayBuffer} buffer 파싱할 WebM/Matroska 바이트
   * @returns {{boxes: Array<object>, truncated: boolean, byteLength: number}} 엘리먼트 트리
   */
  function parse(buffer) {
    const bytes = new Uint8Array(buffer);
    const boxes = parseElements(bytes, 0, bytes.length, 0);
    const truncated = boxes.some(markTruncated);
    return { boxes, truncated, byteLength: buffer.byteLength };
  }

  /**
   * 지정 범위의 EBML 엘리먼트들을 순차 파싱한다.
   * @param {Uint8Array} bytes 파일 바이트
   * @param {number} start 시작 오프셋
   * @param {number} end 종료 오프셋(미포함)
   * @param {number} depth 재귀 깊이
   * @returns {Array<object>} 엘리먼트 노드 배열
   */
  function parseElements(bytes, start, end, depth) {
    const boxes = [];
    let pos = start;
    let clusterCount = 0;
    while (pos < end && depth < 24) {
      const el = parseElement(bytes, pos, end, depth, clusterCount);
      if (!el) break;
      if (el.type === 'Cluster') clusterCount += 1;
      if (depth === 1 && el.type === 'Cluster' && clusterCount > 8) {
        boxes.push(makeSkipNode(pos, end - pos, `Cluster … (${clusterCount - 1}개 더 있음, 생략)`));
        break;
      }
      boxes.push(el);
      if (el.size <= 0) break;
      pos = el.end;
    }
    return boxes;
  }

  /**
   * 단일 EBML 엘리먼트를 파싱한다.
   * @param {Uint8Array} bytes 파일 바이트
   * @param {number} offset 시작 오프셋
   * @param {number} parentEnd 부모 종료 오프셋
   * @param {number} depth 깊이
   * @param {number} clusterCount 현재까지 Cluster 개수
   * @returns {object|null} 엘리먼트 노드
   */
  function parseElement(bytes, offset, parentEnd, depth, clusterCount) {
    if (offset >= parentEnd) return null;
    const idV = readVint(bytes, offset);
    if (!idV) return null;
    const id = idV.value;
    const idLen = idV.length;
    const sizeOff = offset + idLen;
    const sizeV = readVint(bytes, sizeOff);
    if (!sizeV) return null;
    const headerSize = idLen + sizeV.length;
    const bodyStart = offset + headerSize;
    let bodySize = sizeV.unknown ? parentEnd - bodyStart : sizeV.value;
    const end = Math.min(bodyStart + bodySize, bytes.length, parentEnd);
    const truncated = bodyStart + (sizeV.unknown ? 0 : bodySize) > bytes.length;
    const type = nameFor(id, idLen);
    const label = TYPE_LABELS[type] || '';

    const node = {
      type, size: end - offset, start: offset, end, headerSize,
      dataStart: bodyStart, dataEnd: end, label,
      fullbox: null, children: [], fields: [], hasChildren: false, truncated,
    };

    node.fields = headerFields(bytes, node, id, idLen, sizeV);

    if (MASTER.has(id) || MASTER.has(id | 0x10000000) || type === 'Segment' || type === 'Tracks' || type === 'Cluster' || type === 'EBML') {
      node.children = parseElements(bytes, bodyStart, end, depth + 1);
      node.hasChildren = node.children.length > 0;
      if (!node.hasChildren && !truncated) node.fields.push(...decodeLeaf(bytes, node, id));
    } else if (!truncated) {
      node.fields.push(...decodeLeaf(bytes, node, id));
    }
    return node;
  }

  /**
   * EBML 엘리먼트 헤더(ID + Size) 필드를 만든다.
   * @param {Uint8Array} bytes 바이트
   * @param {object} node 노드
   * @param {number} id 엘리먼트 ID
   * @param {number} idLen ID VINT 길이
   * @param {{value:number,length:number,unknown:boolean}} sizeV Size VINT
   * @returns {Array<object>} 필드 배열
   */
  function headerFields(bytes, node, id, idLen, sizeV) {
    const out = [
      field(node.start, idLen, 'element_id', `${hexId(id)} (${NAMES[id] || 'unknown'})`, bytes),
      field(node.start + idLen, sizeV.length, 'element_size',
        sizeV.unknown ? 'unknown (끝까지)' : `${sizeV.value} bytes`, bytes),
    ];
    return out;
  }

  /**
   * 리프 엘리먼트 페이로드를 디코드한다.
   * @param {Uint8Array} bytes 바이트
   * @param {object} node 노드
   * @param {number} id 엘리먼트 ID
   * @returns {Array<object>} 필드 배열
   */
  function decodeLeaf(bytes, node, id) {
    const len = node.dataEnd - node.dataStart;
    if (len <= 0) return [];
    const out = [];
    const name = NAMES[id] || 'data';
    if (id === 0x4286) {
      out.push(field(node.dataStart, len, name, readUtf8(bytes, node.dataStart, len), bytes));
    } else if (id === 0x86) {
      out.push(field(node.dataStart, len, name, readUtf8(bytes, node.dataStart, len), bytes));
    } else if ([0x83, 0xd7, 0xe0, 0xba, 0xe7, 0x2ad7b1, 0x53ac, 0xb3].includes(id)) {
      out.push(field(node.dataStart, Math.min(len, 8), name, String(readUint(bytes, node.dataStart, len)), bytes));
    } else if (id === 0x4489) {
      const scale = 1000000;
      const raw = readUint(bytes, node.dataStart, len);
      out.push(field(node.dataStart, len, name, `${raw} (timescale ${scale}) ≈ ${(raw / scale).toFixed(3)}s`, bytes));
    } else if (id === 0xa3) {
      out.push(field(node.dataStart, Math.min(len, 16), name, describeSimpleBlock(bytes, node.dataStart, len), bytes));
      if (len > 16) out.push(field(node.dataStart + 16, len - 16, 'frame_data', `… ${len - 16} bytes`, bytes));
    } else {
      out.push(field(node.dataStart, Math.min(len, 32), name, len > 32 ? `(${len} bytes)` : readHex(bytes, node.dataStart, len), bytes));
    }
    return out;
  }

  /**
   * SimpleBlock 선두 바이트를 요약 해석한다.
   * @param {Uint8Array} bytes 바이트
   * @param {number} off 시작 오프셋
   * @param {number} len 전체 길이
   * @returns {string} 요약 문자열
   */
  function describeSimpleBlock(bytes, off, len) {
    if (len < 4) return '(짧음)';
    const track = readVint(bytes, off);
    if (!track) return '(파싱 불가)';
    const flags = bytes[off + track.length + 2];
    const key = (flags & 0x80) ? 'keyframe' : 'delta';
    return `track VINT, timecode+flags, ${key}`;
  }

  /**
   * 생략 구간 노드를 만든다.
   * @param {number} start 시작 오프셋
   * @param {number} size 크기
   * @param {string} label 라벨
   * @returns {object} 노드
   */
  function makeSkipNode(start, size, label) {
    return {
      type: '…', size, start, end: start + size, headerSize: 0,
      dataStart: start, dataEnd: start + size, label,
      fields: [], children: [], hasChildren: false, truncated: true,
    };
  }

  /**
   * VINT로 읽은 ID를 스키마 이름으로 조회한다(마커 비트 보정 포함).
   * @param {number} id VINT 데이터 값
   * @param {number} idLen ID VINT 길이
   * @returns {string} 엘리먼트 이름 또는 hex
   */
  function nameFor(id, idLen) {
    if (NAMES[id]) return NAMES[id];
    const markers = [0, 0x80, 0x4000, 0x200000, 0x10000000];
    const alt = id | (markers[idLen] || 0);
    if (NAMES[alt]) return NAMES[alt];
    return hexId(alt);
  }

  /**
   * EBML VINT의 바이트 길이를 첫 옥텟으로 판별한다.
   * @param {number} first 첫 바이트
   * @returns {number} VINT 길이(1~8), 잘못되면 0
   */
  function vintLength(first) {
    if (first & 0x80) return 1;
    if (first & 0x40) return 2;
    if ((first & 0xf0) === 0x10) return 4;
    if (first & 0x20) return 3;
    if (first & 0x10) return 4;
    if (first & 0x08) return 5;
    if (first & 0x04) return 6;
    if (first & 0x02) return 7;
    if (first & 0x01) return 8;
    return 0;
  }

  /**
   * EBML 가변 정수(VINT)를 읽는다.
   * @param {Uint8Array} bytes 바이트
   * @param {number} offset 시작 오프셋
   * @returns {{value:number,length:number,unknown:boolean}|null} VINT 결과
   */
  function readVint(bytes, offset) {
    if (offset >= bytes.length) return null;
    const first = bytes[offset];
    if (first === 0) return null;
    const length = vintLength(first);
    if (!length) return null;
    const mask = (1 << (8 - length)) - 1;
    let value = first & mask;
    for (let i = 1; i < length; i++) {
      if (offset + i >= bytes.length) return null;
      value = (value << 8) | bytes[offset + i];
    }
    const dataBits = length * 7;
    const allOnes = value === (1 << dataBits) - 1;
    return { value, length, unknown: allOnes };
  }

  /**
   * 부호 없는 정수를 빅엔디안으로 읽는다.
   * @param {Uint8Array} bytes 바이트
   * @param {number} off 오프셋
   * @param {number} len 길이(1~8)
   * @returns {number} 정수값
   */
  function readUint(bytes, off, len) {
    let v = 0;
    for (let i = 0; i < len && off + i < bytes.length; i += 1) v = (v << 8) | bytes[off + i];
    return v;
  }

  /**
   * UTF-8 문자열을 읽는다.
   * @param {Uint8Array} bytes 바이트
   * @param {number} off 오프셋
   * @param {number} len 길이
   * @returns {string} 디코드된 문자열
   */
  function readUtf8(bytes, off, len) {
    try {
      return new TextDecoder().decode(bytes.subarray(off, off + len));
    } catch (e) {
      return readHex(bytes, off, len);
    }
  }

  /**
   * 엘리먼트 ID를 16진수 문자열로 포맷한다.
   * @param {number} id ID 값
   * @returns {string} 예: "0x1A45DFA3"
   */
  function hexId(id) {
    return '0x' + id.toString(16).toUpperCase();
  }

  /**
   * 절대 오프셋 기반 필드 주석을 생성한다.
   * @param {number} offset 오프셋
   * @param {number} length 길이
   * @param {string} name 이름
   * @param {string} value 값
   * @param {Uint8Array} bytes 바이트
   * @returns {object} 필드
   */
  function field(offset, length, name, value, bytes) {
    return { offset, length, name, value, hex: readHex(bytes, offset, length) };
  }

  /**
   * 바이트 범위를 hex 문자열로 변환한다.
   * @param {Uint8Array} bytes 바이트
   * @param {number} offset 오프셋
   * @param {number} length 길이
   * @returns {string} hex
   */
  function readHex(bytes, offset, length) {
    const parts = [];
    const end = Math.min(offset + length, bytes.length);
    for (let i = offset; i < end; i += 1) parts.push(bytes[i].toString(16).padStart(2, '0'));
    return parts.join(' ');
  }

  /**
   * 잘린 노드가 있는지 검사한다.
   * @param {object} box 노드
   * @returns {boolean} 잘림 여부
   */
  function markTruncated(box) {
    if (box.truncated) return true;
    return (box.children || []).some(markTruncated);
  }

  global.EbmlParser = { parse, NAMES };
})(typeof window !== 'undefined' ? window : globalThis);
