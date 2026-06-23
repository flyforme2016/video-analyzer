'use strict';

/**
 * FLV(Flash Video) 컨테이너 파서.
 * 9바이트 헤더와 이후 태그(오디오/비디오/스크립트) 스트림을 트리·필드로 반환한다.
 */
(function (global) {
  const MAX_TAGS = 500; // 트리에 표시할 최대 태그 수(대용량 FLV 보호)

  const AUDIO_FORMATS = {
    0: 'Linear PCM(LE)', 1: 'ADPCM', 2: 'MP3', 3: 'Linear PCM(LE)',
    4: 'Nellymoser 16k', 5: 'Nellymoser 8k', 6: 'Nellymoser',
    7: 'G.711 A-law', 8: 'G.711 mu-law', 10: 'AAC', 11: 'Speex',
    14: 'MP3 8k', 15: 'Device-specific',
  };
  const AUDIO_RATES = { 0: '5.5kHz', 1: '11kHz', 2: '22kHz', 3: '44kHz' };
  const VIDEO_CODECS = {
    1: 'JPEG', 2: 'Sorenson H.263', 3: 'Screen Video', 4: 'VP6',
    5: 'VP6 alpha', 6: 'Screen Video 2', 7: 'AVC(H.264)', 12: 'HEVC(H.265)',
  };
  const FRAME_TYPES = {
    1: '키프레임', 2: '인터프레임', 3: 'disposable 인터', 4: '생성 키프레임', 5: '비디오 명령',
  };

  /**
   * FLV 버퍼 전체를 파싱하여 최상위 노드 배열을 반환한다.
   * @param {ArrayBuffer} buffer 파싱할 FLV 바이트
   * @returns {{boxes: Array<object>, truncated: boolean, byteLength: number}} 트리와 메타정보
   */
  function parse(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const boxes = [];
    if (bytes.length < 9 || readAscii(bytes, 0, 3) !== 'FLV') {
      return { boxes, truncated: false, byteLength: buffer.byteLength };
    }

    const header = parseHeader(bytes, view);
    boxes.push(header.node);

    const result = parseTags(bytes, view, header.dataOffset);
    boxes.push(...result.nodes);
    return { boxes, truncated: result.truncated, byteLength: buffer.byteLength };
  }

  /**
   * FLV 9바이트 헤더를 파싱한다.
   * @param {Uint8Array} bytes 파일 바이트
   * @param {DataView} view 파일 DataView
   * @returns {{node: object, dataOffset: number}} 헤더 노드와 본문 시작 오프셋
   */
  function parseHeader(bytes, view) {
    const version = bytes[3];
    const flags = bytes[4];
    const hasAudio = (flags & 0x04) !== 0;
    const hasVideo = (flags & 0x01) !== 0;
    const dataOffset = view.getUint32(5);
    const streams = [hasVideo ? '비디오' : null, hasAudio ? '오디오' : null].filter(Boolean).join('+') || '없음';
    const node = makeLeaf('FLV', 0, dataOffset, `FLV 헤더 (v${version}, ${streams})`, [
      field(0, 3, 'signature', '"FLV"', bytes),
      field(3, 1, 'version', String(version), bytes),
      field(4, 1, 'flags', `${describeFlags(flags)} (0x${flags.toString(16).padStart(2, '0')})`, bytes),
      field(5, 4, 'data_offset', `${dataOffset} (헤더 크기)`, bytes),
    ]);
    return { node, dataOffset: dataOffset >= 9 ? dataOffset : 9 };
  }

  /**
   * 헤더 이후 태그 스트림을 순차 파싱한다(표시 개수 제한).
   * @param {Uint8Array} bytes 파일 바이트
   * @param {DataView} view 파일 DataView
   * @param {number} start 첫 PreviousTagSize 시작 오프셋
   * @returns {{nodes: Array<object>, truncated: boolean}} 태그 노드 배열과 잘림 여부
   */
  function parseTags(bytes, view, start) {
    const nodes = [];
    let offset = start + 4; // 첫 PreviousTagSize(=0) 건너뜀
    let truncated = false;
    let shown = 0;
    const counts = { audio: 0, video: 0, script: 0, keyframes: 0 };
    let lastTimestamp = 0;

    while (offset + 11 <= bytes.length) {
      const parsed = parseTag(bytes, view, offset);
      if (!parsed) { truncated = true; break; }
      countTag(parsed, counts);
      lastTimestamp = Math.max(lastTimestamp, parsed.timestamp);
      if (shown < MAX_TAGS) {
        nodes.push(parsed.node);
        shown += 1;
      }
      if (parsed.truncated) { truncated = true; break; }
      offset = parsed.end + 4; // 태그 본문 + PreviousTagSize
    }

    const omitted = counts.audio + counts.video + counts.script - shown;
    if (omitted > 0) {
      nodes.push(makeLeaf('…', start, 0,
        `외 ${omitted}개 태그 생략 (표시 ${shown}/${counts.audio + counts.video + counts.script})`, []));
    }
    nodes.unshift(makeSummary(counts, lastTimestamp));
    return { nodes, truncated };
  }

  /**
   * 단일 FLV 태그(11바이트 헤더 + 본문)를 파싱한다.
   * @param {Uint8Array} bytes 파일 바이트
   * @param {DataView} view 파일 DataView
   * @param {number} offset 태그 시작 오프셋
   * @returns {object|null} 파싱 결과({node,end,type,timestamp,keyframe,truncated}) 또는 null
   */
  function parseTag(bytes, view, offset) {
    const tagType = bytes[offset];
    const dataSize = readU24(view, offset + 1);
    const timestamp = readU24(view, offset + 4) | (bytes[offset + 7] << 24);
    const bodyStart = offset + 11;
    const bodyEnd = bodyStart + dataSize;
    const truncated = bodyEnd > bytes.length;
    const end = Math.min(bodyEnd, bytes.length);

    const kindMap = { 8: 'audio', 9: 'video', 18: 'script' };
    const kind = kindMap[tagType] || 'unknown';
    const baseFields = [
      field(offset, 1, 'tag_type', `${tagType} (${kind})`, bytes),
      field(offset + 1, 3, 'data_size', `${dataSize} B`, bytes),
      field(offset + 4, 3, 'timestamp', `${readU24(view, offset + 4)} ms`, bytes),
      field(offset + 7, 1, 'timestamp_ext', String(bytes[offset + 7]), bytes),
      field(offset + 8, 3, 'stream_id', '0', bytes),
    ];

    let detail;
    if (kind === 'audio') detail = decodeAudioTag(bytes, bodyStart, dataSize, timestamp);
    else if (kind === 'video') detail = decodeVideoTag(bytes, bodyStart, dataSize, timestamp);
    else if (kind === 'script') detail = decodeScriptTag(bytes, view, bodyStart, dataSize);
    else detail = { type: 'unknown', label: `알 수 없는 태그(type=${tagType})`, fields: [], keyframe: false };

    const node = makeLeaf(detail.type, offset, dataSize + 11, detail.label,
      baseFields.concat(detail.fields));
    node.truncated = truncated;
    return { node, end, type: kind, timestamp: timestamp >>> 0, keyframe: detail.keyframe, truncated };
  }

  /**
   * 오디오 태그 본문 첫 바이트(코덱/샘플레이트 등)를 해석한다.
   * @param {Uint8Array} bytes 파일 바이트
   * @param {number} bodyStart 본문 시작 오프셋
   * @param {number} dataSize 본문 크기
   * @param {number} timestamp 태그 타임스탬프(ms)
   * @returns {{type:string,label:string,fields:Array<object>,keyframe:boolean}} 해석 결과
   */
  function decodeAudioTag(bytes, bodyStart, dataSize, timestamp) {
    if (dataSize === 0) return { type: 'audio', label: '오디오(빈 본문)', fields: [], keyframe: false };
    const h = bytes[bodyStart];
    const format = (h >> 4) & 0x0f;
    const rate = (h >> 2) & 0x03;
    const size = (h >> 1) & 0x01;
    const channels = h & 0x01;
    const fields = [
      field(bodyStart, 1, 'audio_header',
        `${AUDIO_FORMATS[format] || format}, ${AUDIO_RATES[rate] || rate}, ${size ? '16bit' : '8bit'}, ${channels ? '스테레오' : '모노'}`,
        bytes),
    ];
    let label = `오디오 · ${AUDIO_FORMATS[format] || format} · ${timestamp >>> 0}ms`;
    if (format === 10 && dataSize >= 2) {
      const pktType = bytes[bodyStart + 1];
      fields.push(field(bodyStart + 1, 1, 'aac_packet_type', pktType === 0 ? '0 (시퀀스 헤더)' : '1 (raw)', bytes));
      if (pktType === 0) label += ' · AAC 시퀀스 헤더';
    }
    return { type: 'audio', label, fields, keyframe: false };
  }

  /**
   * 비디오 태그 본문 첫 바이트(프레임 타입/코덱)를 해석한다.
   * @param {Uint8Array} bytes 파일 바이트
   * @param {number} bodyStart 본문 시작 오프셋
   * @param {number} dataSize 본문 크기
   * @param {number} timestamp 태그 타임스탬프(ms)
   * @returns {{type:string,label:string,fields:Array<object>,keyframe:boolean}} 해석 결과
   */
  function decodeVideoTag(bytes, bodyStart, dataSize, timestamp) {
    if (dataSize === 0) return { type: 'video', label: '비디오(빈 본문)', fields: [], keyframe: false };
    const h = bytes[bodyStart];
    const frameType = (h >> 4) & 0x0f;
    const codec = h & 0x0f;
    const keyframe = frameType === 1 || frameType === 4;
    const fields = [
      field(bodyStart, 1, 'video_header',
        `${FRAME_TYPES[frameType] || frameType}, ${VIDEO_CODECS[codec] || codec}`, bytes),
    ];
    let label = `비디오 · ${VIDEO_CODECS[codec] || codec} · ${FRAME_TYPES[frameType] || frameType} · ${timestamp >>> 0}ms`;
    if ((codec === 7 || codec === 12) && dataSize >= 2) {
      const pktType = bytes[bodyStart + 1];
      const ptLabel = pktType === 0 ? '0 (시퀀스 헤더)' : pktType === 1 ? '1 (NALU)' : '2 (끝)';
      fields.push(field(bodyStart + 1, 1, 'avc_packet_type', ptLabel, bytes));
      if (pktType === 0) label += ' · 시퀀스 헤더';
    }
    return { type: 'video', label, fields, keyframe };
  }

  /**
   * 스크립트(AMF0) 태그를 해석한다(onMetaData 등 스칼라 값 추출).
   * @param {Uint8Array} bytes 파일 바이트
   * @param {DataView} view 파일 DataView
   * @param {number} bodyStart 본문 시작 오프셋
   * @param {number} dataSize 본문 크기
   * @returns {{type:string,label:string,fields:Array<object>,keyframe:boolean}} 해석 결과
   */
  function decodeScriptTag(bytes, view, bodyStart, dataSize) {
    const ctx = { pos: bodyStart, end: Math.min(bodyStart + dataSize, bytes.length), bytes, view };
    const name = amfReadValue(ctx);
    const fields = [];
    let label = '스크립트 데이터';
    if (typeof name === 'string') label = `스크립트 · ${name}`;

    const meta = amfReadValue(ctx);
    if (meta && typeof meta === 'object') {
      let count = 0;
      for (const [k, v] of Object.entries(meta)) {
        if (count >= 30) break;
        if (v === null || typeof v === 'object') continue;
        fields.push({ offset: bodyStart, length: 0, name: k, value: String(v), hex: '' });
        count += 1;
      }
    }
    return { type: 'script', label, fields, keyframe: false };
  }

  // ------- AMF0 최소 파서 -------

  /**
   * AMF0 값 하나를 읽고 ctx.pos를 전진시킨다.
   * @param {{pos:number,end:number,bytes:Uint8Array,view:DataView}} ctx 파싱 컨텍스트
   * @returns {*} 해석된 값(객체/숫자/문자열/불리언) 또는 null
   */
  function amfReadValue(ctx) {
    if (ctx.pos >= ctx.end) return null;
    const marker = ctx.bytes[ctx.pos];
    ctx.pos += 1;
    switch (marker) {
      case 0x00: { const n = ctx.view.getFloat64(ctx.pos); ctx.pos += 8; return n; }
      case 0x01: { const b = ctx.bytes[ctx.pos] !== 0; ctx.pos += 1; return b; }
      case 0x02: return amfReadString(ctx);
      case 0x03: return amfReadObject(ctx);
      case 0x08: { ctx.pos += 4; return amfReadObject(ctx); }
      case 0x05: return null;
      case 0x06: return undefined;
      default: ctx.pos = ctx.end; return null;
    }
  }

  /**
   * AMF0 UTF-8 문자열(2바이트 길이 접두)을 읽는다.
   * @param {{pos:number,end:number,bytes:Uint8Array,view:DataView}} ctx 파싱 컨텍스트
   * @returns {string} 문자열
   */
  function amfReadString(ctx) {
    if (ctx.pos + 2 > ctx.end) { ctx.pos = ctx.end; return ''; }
    const len = ctx.view.getUint16(ctx.pos);
    ctx.pos += 2;
    const s = readAscii(ctx.bytes, ctx.pos, Math.min(len, ctx.end - ctx.pos));
    ctx.pos += len;
    return s;
  }

  /**
   * AMF0 객체/ECMA 배열의 key-value 쌍을 종료 마커(0x000009)까지 읽는다.
   * @param {{pos:number,end:number,bytes:Uint8Array,view:DataView}} ctx 파싱 컨텍스트
   * @returns {object} 평탄화된 객체
   */
  function amfReadObject(ctx) {
    const obj = {};
    let guard = 0;
    while (ctx.pos + 2 <= ctx.end && guard < 1000) {
      guard += 1;
      const keyLen = ctx.view.getUint16(ctx.pos);
      if (keyLen === 0) { ctx.pos += 3; break; } // 0x00 0x00 0x09 종료
      ctx.pos += 2;
      const key = readAscii(ctx.bytes, ctx.pos, Math.min(keyLen, ctx.end - ctx.pos));
      ctx.pos += keyLen;
      obj[key] = amfReadValue(ctx);
    }
    return obj;
  }

  // ------- 요약/노드 헬퍼 -------

  /**
   * 태그 종류별 카운트를 누적한다.
   * @param {{type:string,keyframe:boolean}} parsed 파싱된 태그
   * @param {object} counts 누적 카운트
   * @returns {void}
   */
  function countTag(parsed, counts) {
    if (parsed.type === 'audio') counts.audio += 1;
    else if (parsed.type === 'video') counts.video += 1;
    else if (parsed.type === 'script') counts.script += 1;
    if (parsed.keyframe) counts.keyframes += 1;
  }

  /**
   * 태그 통계 요약 노드를 만든다.
   * @param {object} counts 태그 카운트
   * @param {number} lastTimestamp 마지막 타임스탬프(ms)
   * @returns {object} 요약 노드
   */
  function makeSummary(counts, lastTimestamp) {
    const total = counts.audio + counts.video + counts.script;
    return makeLeaf('SUMMARY', 0, 0,
      `태그 ${total}개 · 비디오 ${counts.video}(키 ${counts.keyframes}) · 오디오 ${counts.audio} · 스크립트 ${counts.script} · ~${(lastTimestamp / 1000).toFixed(1)}s`,
      []);
  }

  /**
   * 리프 노드를 생성한다(다른 파서와 동일한 트리 노드 형태).
   * @param {string} type 노드 타입 코드
   * @param {number} start 시작 오프셋
   * @param {number} size 바이트 길이
   * @param {string} label 사람이 읽는 라벨
   * @param {Array<object>} fields 필드 주석 배열
   * @returns {object} 트리 노드
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
   * @param {number} offset 파일 내 절대 오프셋
   * @param {number} length 바이트 길이
   * @param {string} name 필드 이름
   * @param {string} value 해석값
   * @param {Uint8Array} bytes 바이트 배열
   * @returns {{offset:number,length:number,name:string,value:string,hex:string}} 필드
   */
  function field(offset, length, name, value, bytes) {
    return { offset, length, name, value, hex: readHex(bytes, offset, length) };
  }

  /**
   * FLV 헤더 플래그 바이트를 설명 문자열로 변환한다.
   * @param {number} flags 플래그 바이트
   * @returns {string} 설명
   */
  function describeFlags(flags) {
    const parts = [];
    if (flags & 0x01) parts.push('비디오');
    if (flags & 0x04) parts.push('오디오');
    return parts.length ? parts.join('+') : '스트림 없음';
  }

  /**
   * 24비트 빅엔디언 정수를 읽는다.
   * @param {DataView} view DataView
   * @param {number} offset 시작 오프셋
   * @returns {number} 정수값
   */
  function readU24(view, offset) {
    return (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);
  }

  /**
   * 지정 범위를 ASCII로 읽는다.
   * @param {Uint8Array} bytes 바이트 배열
   * @param {number} offset 시작 오프셋
   * @param {number} len 길이
   * @returns {string} ASCII 문자열
   */
  function readAscii(bytes, offset, len) {
    let s = '';
    for (let i = 0; i < len && offset + i < bytes.length; i += 1) s += String.fromCharCode(bytes[offset + i]);
    return s;
  }

  /**
   * 바이트 범위를 공백 구분 16진수 문자열로 변환한다.
   * @param {Uint8Array} bytes 바이트 배열
   * @param {number} offset 시작 오프셋
   * @param {number} length 길이
   * @returns {string} hex 문자열
   */
  function readHex(bytes, offset, length) {
    const parts = [];
    const end = Math.min(offset + length, bytes.length);
    for (let i = offset; i < end; i += 1) parts.push(bytes[i].toString(16).padStart(2, '0'));
    return parts.join(' ');
  }

  global.FlvParser = { parse };
})(typeof window !== 'undefined' ? window : globalThis);
