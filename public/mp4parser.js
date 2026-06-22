'use strict';

/**
 * MP4 / ISO Base Media File Format(ISO BMFF) 박스(atom) 파서.
 * ArrayBuffer를 받아 박스 트리와 필드 단위 주석을 생성한다.
 * 브라우저 전역(window.MP4Parser)으로 노출된다.
 */
(function (global) {
  // 자식 박스를 포함하는 컨테이너 박스 목록
  const CONTAINER_BOXES = new Set([
    'moov', 'trak', 'edts', 'mdia', 'minf', 'dinf', 'stbl', 'mvex',
    'moof', 'traf', 'mfra', 'udta', 'skip', 'strk', 'sinf', 'schi',
    'wave', 'gmhd', 'ilst', 'meta',
  ]);

  // FullBox 헤더(version 1바이트 + flags 3바이트) 뒤에 자식 박스가 오는 특수 컨테이너
  const FULLBOX_CONTAINER = new Set(['meta']);

  const TYPE_LABELS = {
    ftyp: '파일 타입 / 호환 브랜드', moov: '무비 메타데이터(컨테이너)', mvhd: '무비 헤더',
    trak: '트랙(컨테이너)', tkhd: '트랙 헤더', edts: '편집(컨테이너)', elst: '편집 리스트',
    mdia: '미디어(컨테이너)', mdhd: '미디어 헤더', hdlr: '핸들러(트랙 유형)',
    minf: '미디어 정보(컨테이너)', vmhd: '비디오 미디어 헤더', smhd: '사운드 미디어 헤더',
    dinf: '데이터 정보(컨테이너)', dref: '데이터 참조', stbl: '샘플 테이블(컨테이너)',
    stsd: '샘플 설명(코덱)', stts: '디코딩 타임-투-샘플', ctts: '컴포지션 오프셋',
    stsc: '샘플-투-청크', stsz: '샘플 크기', stz2: '샘플 크기(압축)', stco: '청크 오프셋(32bit)',
    co64: '청크 오프셋(64bit)', stss: '싱크 샘플(키프레임)', sdtp: '샘플 디펜던시',
    mdat: '미디어 데이터(실제 프레임)', free: '여유 공간', skip: '건너뜀',
    mvex: '무비 익스텐드(프래그먼트)', mehd: '무비 익스텐드 헤더', trex: '트랙 익스텐드 기본값',
    moof: '무비 프래그먼트', mfhd: '프래그먼트 헤더', traf: '트랙 프래그먼트',
    tfhd: '트랙 프래그먼트 헤더', tfdt: '트랙 프래그먼트 디코드 타임', trun: '트랙 프래그먼트 런',
    udta: '사용자 데이터', meta: '메타데이터', avcC: 'AVC(H.264) 설정', hvcC: 'HEVC(H.265) 설정',
    esds: 'ES 디스크립터', pasp: '픽셀 종횡비', colr: '컬러 정보', btrt: '비트레이트',
    sidx: '세그먼트 인덱스', styp: '세그먼트 타입',
  };

  /**
   * ArrayBuffer 전체를 파싱하여 최상위 박스 배열을 반환한다.
   * @param {ArrayBuffer} buffer 파싱할 파일 바이트(전체 또는 선두 일부)
   * @param {{fileSize?:number}} [options] 실제 파일 크기(알면 전달 — 손상/부분로드 구분)
   * @returns {{boxes: Array<object>, truncated: boolean, partialLoad: boolean, byteLength: number}} 박스 트리
   */
  function parse(buffer, options) {
    const ctx = { fileSize: (options && options.fileSize) || 0 };
    const view = new DataView(buffer);
    const boxes = parseBoxes(view, 0, buffer.byteLength, 0, ctx);
    return {
      boxes,
      truncated: boxes.some((b) => markTruncation(b)),
      partialLoad: boxes.some((b) => markPartialLoad(b)),
      byteLength: buffer.byteLength,
    };
  }

  /**
   * 지정한 범위 [start, end) 안의 형제 박스들을 순차적으로 파싱한다.
   * @param {DataView} view 파일 전체에 대한 DataView
   * @param {number} start 파싱 시작 오프셋
   * @param {number} end 파싱 종료 오프셋(미포함)
   * @param {number} depth 트리 깊이(무한 재귀 방지용)
   * @param {{fileSize:number}} ctx 파싱 컨텍스트
   * @returns {Array<object>} 박스 노드 배열
   */
  function parseBoxes(view, start, end, depth, ctx) {
    const boxes = [];
    let offset = start;
    while (offset + 8 <= end && depth < 32) {
      const box = parseBox(view, offset, end, depth, ctx);
      if (!box) break;
      boxes.push(box);
      if (box.size <= 0) break; // size==0 → 파일 끝까지
      offset = box.end;
    }
    return boxes;
  }

  /**
   * 단일 박스의 헤더를 해석하고, 컨테이너면 자식을, 아니면 필드 주석을 생성한다.
   * @param {DataView} view 파일 전체 DataView
   * @param {number} offset 박스 시작 오프셋
   * @param {number} parentEnd 부모(또는 파일) 종료 오프셋
   * @param {number} depth 현재 깊이
   * @param {{fileSize:number}} ctx 파싱 컨텍스트
   * @returns {object|null} 박스 노드 또는 파싱 불가 시 null
   */
  function parseBox(view, offset, parentEnd, depth, ctx) {
    if (offset + 8 > view.byteLength) return null;
    let size = view.getUint32(offset);
    const type = readType(view, offset + 4);
    let headerSize = 8;
    let declaredToEnd = false;

    if (size === 1) {
      if (offset + 16 > view.byteLength) return null;
      size = readUint64(view, offset + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = parentEnd - offset;
      declaredToEnd = true;
    }

    let usertype = null;
    if (type === 'uuid' && offset + headerSize + 16 <= view.byteLength) {
      usertype = readHex(view, offset + headerSize, 16);
      headerSize += 16;
    }

    const end = Math.min(offset + size, view.byteLength);
    const beyondBuffer = offset + size > view.byteLength;
    const beyondFile = ctx.fileSize > 0 && offset + size > ctx.fileSize;
    const partialLoad = beyondBuffer && !beyondFile;
    const truncated = beyondFile;
    const dataStart = offset + headerSize;
    const dataEnd = end;

    const box = {
      type, size, start: offset, end, headerSize, dataStart, dataEnd,
      usertype, declaredToEnd, truncated, partialLoad, label: TYPE_LABELS[type] || '',
      fullbox: null, children: [], fields: [], hasChildren: false,
    };

    const isFullContainer = FULLBOX_CONTAINER.has(type);
    const isContainer = CONTAINER_BOXES.has(type);

    if (isFullContainer) {
      box.fullbox = readFullBoxHeader(view, dataStart);
      box.children = parseBoxes(view, dataStart + 4, dataEnd, depth + 1, ctx);
      box.hasChildren = true;
    } else if (type === 'stsd') {
      box.children = parseSampleDescription(view, box, depth, ctx);
      box.hasChildren = box.children.length > 0;
    } else if (isContainer) {
      box.children = parseBoxes(view, dataStart, dataEnd, depth + 1, ctx);
      box.hasChildren = box.children.length > 0;
    }

    if (!box.hasChildren && !truncated) {
      box.fields = decodeFields(view, box);
    } else if (box.headerSize > 0) {
      box.fields = headerFields(view, box);
    }
    return box;
  }

  /**
   * stsd(샘플 설명) 박스 내부의 샘플 엔트리(코덱별 박스)를 파싱한다.
   * @param {DataView} view 파일 DataView
   * @param {object} box stsd 박스 노드
   * @param {number} depth 현재 깊이
   * @param {{fileSize:number}} ctx 파싱 컨텍스트
   * @returns {Array<object>} 샘플 엔트리 박스 배열
   */
  function parseSampleDescription(view, box, depth, ctx) {
    box.fullbox = readFullBoxHeader(view, box.dataStart);
    const entryStart = box.dataStart + 8; // version/flags(4) + entry_count(4)
    return parseBoxes(view, entryStart, box.dataEnd, depth + 1, ctx);
  }

  // ------- 필드 디코더 레지스트리 -------

  /**
   * 박스 타입별 디코더를 찾아 필드 주석 배열을 생성한다.
   * @param {DataView} view 파일 DataView
   * @param {object} box 대상 박스
   * @returns {Array<object>} 필드 주석 배열
   */
  function decodeFields(view, box) {
    const base = headerFields(view, box);
    const decoder = FIELD_DECODERS[box.type];
    if (!decoder) {
      base.push(rawField(box.dataStart, box.dataEnd, view));
      return base;
    }
    let pos = box.dataStart;
    let version = 0;
    let flags = 0;
    if (FULLBOX_TYPES.has(box.type)) {
      const fb = readFullBoxHeader(view, pos);
      version = fb.version;
      flags = fb.flags;
      base.push(field(pos, 1, 'version', String(version), view));
      base.push(field(pos + 1, 3, 'flags', '0x' + flags.toString(16).padStart(6, '0'), view));
      pos += 4;
    }
    decoder(view, box, base, { pos, version, flags });
    return base;
  }

  // FullBox(버전/플래그 4바이트로 시작) 타입
  const FULLBOX_TYPES = new Set([
    'mvhd', 'tkhd', 'mdhd', 'hdlr', 'vmhd', 'smhd', 'hmhd', 'nmhd', 'dref', 'url ',
    'elst', 'stts', 'ctts', 'stsc', 'stsz', 'stz2', 'stco', 'co64', 'stss', 'sdtp',
    'mehd', 'trex', 'mfhd', 'tfhd', 'tfdt', 'trun', 'sidx',
  ]);

  const FIELD_DECODERS = {
    ftyp: decodeFtyp,
    styp: decodeFtyp,
    mvhd: decodeMvhd,
    tkhd: decodeTkhd,
    mdhd: decodeMdhd,
    hdlr: decodeHdlr,
    vmhd: decodeVmhd,
    smhd: decodeSmhd,
    elst: decodeElst,
    stts: decodeStts,
    ctts: decodeCtts,
    stsc: decodeStsc,
    stsz: decodeStsz,
    stco: decodeOffsets32,
    co64: decodeOffsets64,
    stss: decodeStss,
    mehd: decodeMehd,
    trex: decodeTrex,
    mfhd: decodeMfhd,
    tfhd: decodeTfhd,
    tfdt: decodeTfdt,
    trun: decodeTrun,
    sidx: decodeSidx,
  };

  /**
   * ftyp/styp: major_brand, minor_version, compatible_brands를 디코드한다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열(누적)
   * @param {{pos:number}} ctx 현재 위치 컨텍스트
   * @returns {void}
   */
  function decodeFtyp(view, box, out, ctx) {
    let p = box.dataStart;
    out.push(field(p, 4, 'major_brand', readType(view, p), view)); p += 4;
    out.push(field(p, 4, 'minor_version', String(view.getUint32(p)), view)); p += 4;
    let i = 0;
    while (p + 4 <= box.dataEnd) {
      out.push(field(p, 4, `compatible_brand[${i}]`, readType(view, p), view));
      p += 4; i += 1;
    }
  }

  /**
   * mvhd: 무비 헤더(타임스케일/지속시간/레이트 등)를 디코드한다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number, version:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeMvhd(view, box, out, ctx) {
    let p = ctx.pos;
    const big = ctx.version === 1;
    p = pushTime(view, out, p, 'creation_time', big);
    p = pushTime(view, out, p, 'modification_time', big);
    out.push(field(p, 4, 'timescale', String(view.getUint32(p)) + ' (단위/초)', view)); p += 4;
    const durLen = big ? 8 : 4;
    const dur = big ? readUint64(view, p) : view.getUint32(p);
    out.push(field(p, durLen, 'duration', String(dur), view)); p += durLen;
    out.push(field(p, 4, 'rate', fixed1616(view, p) + ' (재생속도)', view)); p += 4;
    out.push(field(p, 2, 'volume', fixed88(view, p), view)); p += 2;
    out.push(field(p, 10, 'reserved', '-', view)); p += 10;
    out.push(field(p, 36, 'matrix', '변환 행렬', view)); p += 36;
    out.push(field(p, 24, 'pre_defined', '-', view)); p += 24;
    out.push(field(p, 4, 'next_track_ID', String(view.getUint32(p)), view));
  }

  /**
   * tkhd: 트랙 헤더(트랙 ID/크기 등)를 디코드한다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number, version:number, flags:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeTkhd(view, box, out, ctx) {
    let p = ctx.pos;
    const big = ctx.version === 1;
    p = pushTime(view, out, p, 'creation_time', big);
    p = pushTime(view, out, p, 'modification_time', big);
    out.push(field(p, 4, 'track_ID', String(view.getUint32(p)), view)); p += 4;
    out.push(field(p, 4, 'reserved', '-', view)); p += 4;
    const durLen = big ? 8 : 4;
    const dur = big ? readUint64(view, p) : view.getUint32(p);
    out.push(field(p, durLen, 'duration', String(dur), view)); p += durLen;
    out.push(field(p, 8, 'reserved', '-', view)); p += 8;
    out.push(field(p, 2, 'layer', String(view.getInt16(p)), view)); p += 2;
    out.push(field(p, 2, 'alternate_group', String(view.getInt16(p)), view)); p += 2;
    out.push(field(p, 2, 'volume', fixed88(view, p), view)); p += 2;
    out.push(field(p, 2, 'reserved', '-', view)); p += 2;
    out.push(field(p, 36, 'matrix', '변환 행렬', view)); p += 36;
    out.push(field(p, 4, 'width', fixed1616(view, p) + ' px', view)); p += 4;
    out.push(field(p, 4, 'height', fixed1616(view, p) + ' px', view));
  }

  /**
   * mdhd: 미디어 헤더(타임스케일/언어 등)를 디코드한다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number, version:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeMdhd(view, box, out, ctx) {
    let p = ctx.pos;
    const big = ctx.version === 1;
    p = pushTime(view, out, p, 'creation_time', big);
    p = pushTime(view, out, p, 'modification_time', big);
    out.push(field(p, 4, 'timescale', String(view.getUint32(p)) + ' (단위/초)', view)); p += 4;
    const durLen = big ? 8 : 4;
    const dur = big ? readUint64(view, p) : view.getUint32(p);
    out.push(field(p, durLen, 'duration', String(dur), view)); p += durLen;
    out.push(field(p, 2, 'language', decodeLanguage(view, p), view)); p += 2;
    out.push(field(p, 2, 'pre_defined', '-', view));
  }

  /**
   * hdlr: 핸들러(트랙 유형: vide/soun 등)를 디코드한다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeHdlr(view, box, out, ctx) {
    let p = ctx.pos;
    out.push(field(p, 4, 'pre_defined', '-', view)); p += 4;
    const handler = readType(view, p);
    out.push(field(p, 4, 'handler_type', handler + handlerLabel(handler), view)); p += 4;
    out.push(field(p, 12, 'reserved', '-', view)); p += 12;
    const name = readString(view, p, box.dataEnd);
    out.push(field(p, box.dataEnd - p, 'name', name, view));
  }

  /**
   * vmhd: 비디오 미디어 헤더를 디코드한다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeVmhd(view, box, out, ctx) {
    let p = ctx.pos;
    out.push(field(p, 2, 'graphicsmode', String(view.getUint16(p)), view)); p += 2;
    out.push(field(p, 6, 'opcolor', 'RGB', view));
  }

  /**
   * smhd: 사운드 미디어 헤더를 디코드한다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeSmhd(view, box, out, ctx) {
    let p = ctx.pos;
    out.push(field(p, 2, 'balance', fixed88(view, p), view)); p += 2;
    out.push(field(p, 2, 'reserved', '-', view));
  }

  /**
   * elst: 편집 리스트를 디코드한다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number, version:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeElst(view, box, out, ctx) {
    let p = ctx.pos;
    const count = view.getUint32(p);
    out.push(field(p, 4, 'entry_count', String(count), view)); p += 4;
    const big = ctx.version === 1;
    for (let i = 0; i < count && p < box.dataEnd; i += 1) {
      const segLen = big ? 8 : 4;
      out.push(field(p, segLen, `entry[${i}].segment_duration`, String(big ? readUint64(view, p) : view.getUint32(p)), view)); p += segLen;
      out.push(field(p, segLen, `entry[${i}].media_time`, String(big ? readUint64(view, p) : view.getInt32(p)), view)); p += segLen;
      out.push(field(p, 2, `entry[${i}].media_rate_int`, String(view.getInt16(p)), view)); p += 2;
      out.push(field(p, 2, `entry[${i}].media_rate_frac`, String(view.getInt16(p)), view)); p += 2;
    }
  }

  /**
   * stts: 디코딩 타임-투-샘플 테이블을 디코드한다(엔트리 수만 요약).
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeStts(view, box, out, ctx) {
    decodeCountTable(view, box, out, ctx, ['sample_count', 'sample_delta'], 8);
  }

  /**
   * ctts: 컴포지션 오프셋 테이블을 디코드한다(엔트리 수만 요약).
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeCtts(view, box, out, ctx) {
    decodeCountTable(view, box, out, ctx, ['sample_count', 'sample_offset'], 8);
  }

  /**
   * stsc: 샘플-투-청크 테이블을 디코드한다(엔트리 수만 요약).
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeStsc(view, box, out, ctx) {
    decodeCountTable(view, box, out, ctx, ['first_chunk', 'samples_per_chunk', 'sample_desc_idx'], 12);
  }

  /**
   * stsz: 샘플 크기 테이블 헤더를 디코드한다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeStsz(view, box, out, ctx) {
    let p = ctx.pos;
    out.push(field(p, 4, 'sample_size', String(view.getUint32(p)) + ' (0이면 가변)', view)); p += 4;
    out.push(field(p, 4, 'sample_count', String(view.getUint32(p)), view));
  }

  /**
   * stco: 32비트 청크 오프셋 테이블을 디코드한다(엔트리 수만 요약).
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeOffsets32(view, box, out, ctx) {
    decodeCountTable(view, box, out, ctx, ['chunk_offset'], 4);
  }

  /**
   * co64: 64비트 청크 오프셋 테이블을 디코드한다(엔트리 수만 요약).
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeOffsets64(view, box, out, ctx) {
    decodeCountTable(view, box, out, ctx, ['chunk_offset(64)'], 8);
  }

  /**
   * stss: 싱크 샘플(키프레임) 테이블을 디코드한다(엔트리 수만 요약).
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeStss(view, box, out, ctx) {
    decodeCountTable(view, box, out, ctx, ['sample_number(keyframe)'], 4);
  }

  /**
   * mehd: 무비 익스텐드 헤더(fragment_duration)를 디코드한다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number, version:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeMehd(view, box, out, ctx) {
    const big = ctx.version === 1;
    const len = big ? 8 : 4;
    out.push(field(ctx.pos, len, 'fragment_duration', String(big ? readUint64(view, ctx.pos) : view.getUint32(ctx.pos)), view));
  }

  /**
   * trex: 트랙 익스텐드 기본값을 디코드한다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeTrex(view, box, out, ctx) {
    let p = ctx.pos;
    out.push(field(p, 4, 'track_ID', String(view.getUint32(p)), view)); p += 4;
    out.push(field(p, 4, 'default_sample_description_index', String(view.getUint32(p)), view)); p += 4;
    out.push(field(p, 4, 'default_sample_duration', String(view.getUint32(p)), view)); p += 4;
    out.push(field(p, 4, 'default_sample_size', String(view.getUint32(p)), view)); p += 4;
    out.push(field(p, 4, 'default_sample_flags', '0x' + view.getUint32(p).toString(16), view));
  }

  /**
   * mfhd: 무비 프래그먼트 시퀀스 번호를 디코드한다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeMfhd(view, box, out, ctx) {
    out.push(field(ctx.pos, 4, 'sequence_number', String(view.getUint32(ctx.pos)), view));
  }

  /**
   * tfhd: 트랙 프래그먼트 헤더(track_ID)를 디코드한다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeTfhd(view, box, out, ctx) {
    out.push(field(ctx.pos, 4, 'track_ID', String(view.getUint32(ctx.pos)), view));
  }

  /**
   * tfdt: 트랙 프래그먼트 baseMediaDecodeTime을 디코드한다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number, version:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeTfdt(view, box, out, ctx) {
    const big = ctx.version === 1;
    const len = big ? 8 : 4;
    out.push(field(ctx.pos, len, 'baseMediaDecodeTime', String(big ? readUint64(view, ctx.pos) : view.getUint32(ctx.pos)), view));
  }

  /**
   * trun: 트랙 프래그먼트 런의 sample_count를 디코드한다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeTrun(view, box, out, ctx) {
    out.push(field(ctx.pos, 4, 'sample_count', String(view.getUint32(ctx.pos)), view));
  }

  /**
   * sidx: 세그먼트 인덱스의 reference_ID/timescale을 디코드한다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number}} ctx 컨텍스트
   * @returns {void}
   */
  function decodeSidx(view, box, out, ctx) {
    let p = ctx.pos;
    out.push(field(p, 4, 'reference_ID', String(view.getUint32(p)), view)); p += 4;
    out.push(field(p, 4, 'timescale', String(view.getUint32(p)), view));
  }

  // ------- 공통 헬퍼 -------

  /**
   * 'count(4)' 뒤에 고정 폭 엔트리가 반복되는 테이블의 요약 필드를 만든다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @param {Array<object>} out 필드 배열
   * @param {{pos:number}} ctx 컨텍스트
   * @param {Array<string>} cols 엔트리 컬럼 이름들(설명용)
   * @param {number} entrySize 엔트리 1개의 바이트 크기
   * @returns {void}
   */
  function decodeCountTable(view, box, out, ctx, cols, entrySize) {
    let p = ctx.pos;
    const count = view.getUint32(p);
    out.push(field(p, 4, 'entry_count', String(count), view)); p += 4;
    const tableBytes = Math.min(count * entrySize, box.dataEnd - p);
    const preview = Math.min(count, 3);
    for (let i = 0; i < preview && p + entrySize <= box.dataEnd; i += 1) {
      const parts = cols.map((c, idx) => `${c}=${view.getUint32(p + idx * 4)}`).join(', ');
      out.push(field(p, entrySize, `entry[${i}]`, parts, view));
      p += entrySize;
    }
    if (count > preview) {
      out.push(field(p, box.dataEnd - p, `entries[${preview}..${count - 1}]`, `… (${cols.join('/')}) 반복, 총 ${count}개`, view));
    }
  }

  /**
   * 박스 헤더(size/type, 필요 시 largesize/usertype)를 필드로 만든다.
   * @param {DataView} view DataView
   * @param {object} box 박스
   * @returns {Array<object>} 헤더 필드 배열
   */
  function headerFields(view, box) {
    const out = [];
    if (box.headerSize >= 16 && view.getUint32(box.start) === 1) {
      out.push(field(box.start, 4, 'size', '1 (64비트 크기 사용)', view));
      out.push(field(box.start + 4, 4, 'type', box.type, view));
      out.push(field(box.start + 8, 8, 'largesize', `${box.size} bytes (크기)`, view));
    } else {
      out.push(field(box.start, 4, 'size', `${box.size} bytes (크기)`, view));
      out.push(field(box.start + 4, 4, 'type', `"${box.type}"${box.label ? ' — ' + box.label : ''}`, view));
    }
    if (box.usertype) out.push(field(box.start + box.headerSize - 16, 16, 'usertype(uuid)', box.usertype, view));
    return out;
  }

  /**
   * FullBox의 version/flags를 읽는다.
   * @param {DataView} view DataView
   * @param {number} pos version 바이트 위치
   * @returns {{version:number, flags:number}} 버전과 플래그
   */
  function readFullBoxHeader(view, pos) {
    const version = view.getUint8(pos);
    const flags = (view.getUint8(pos + 1) << 16) | (view.getUint8(pos + 2) << 8) | view.getUint8(pos + 3);
    return { version, flags };
  }

  /**
   * creation/modification_time 필드를 버전에 따라 읽고 사람이 읽을 날짜로 변환한다.
   * @param {DataView} view DataView
   * @param {Array<object>} out 필드 배열
   * @param {number} p 현재 위치
   * @param {string} name 필드 이름
   * @param {boolean} big 64비트 여부(version 1)
   * @returns {number} 다음 위치
   */
  function pushTime(view, out, p, name, big) {
    const len = big ? 8 : 4;
    const raw = big ? readUint64(view, p) : view.getUint32(p);
    out.push(field(p, len, name, `${raw} (${macDate(raw)})`, view));
    return p + len;
  }

  /**
   * 박스 전체를 단일 raw 필드로 만든다(전용 디코더가 없을 때).
   * @param {number} start 시작 오프셋
   * @param {number} endOff 끝 오프셋
   * @param {DataView} view DataView
   * @returns {object} raw 필드
   */
  function rawField(start, endOff, view) {
    return field(start, Math.max(0, endOff - start), 'data', '(원시 페이로드)', view);
  }

  /**
   * 절대 오프셋 기반 필드 주석 객체를 생성한다.
   * @param {number} offset 파일 내 절대 오프셋
   * @param {number} length 바이트 길이
   * @param {string} name 필드 이름
   * @param {string} value 사람이 읽는 해석값
   * @param {DataView} view DataView
   * @returns {{offset:number,length:number,name:string,value:string,hex:string}} 필드
   */
  function field(offset, length, name, value, view) {
    return { offset, length, name, value, hex: readHex(view, offset, Math.min(length, 32)) };
  }

  /**
   * 4바이트를 ASCII 타입 문자열로 읽는다(비출력 문자는 .으로 치환).
   * @param {DataView} view DataView
   * @param {number} offset 시작 오프셋
   * @returns {string} 4글자 타입
   */
  function readType(view, offset) {
    let s = '';
    for (let i = 0; i < 4; i += 1) {
      const c = view.getUint8(offset + i);
      s += c >= 32 && c < 127 ? String.fromCharCode(c) : '.';
    }
    return s;
  }

  /**
   * 지정 길이의 바이트를 공백으로 구분한 16진수 문자열로 변환한다.
   * @param {DataView} view DataView
   * @param {number} offset 시작 오프셋
   * @param {number} length 길이
   * @returns {string} 예: "00 00 00 18"
   */
  function readHex(view, offset, length) {
    const parts = [];
    const end = Math.min(offset + length, view.byteLength);
    for (let i = offset; i < end; i += 1) parts.push(view.getUint8(i).toString(16).padStart(2, '0'));
    return parts.join(' ');
  }

  /**
   * 16바이트를 연속 16진수 문자열로 읽는다.
   * @param {DataView} view DataView
   * @param {number} offset 시작 오프셋
   * @param {number} length 길이
   * @returns {string} 16진수 문자열
   */
  function readHexRaw(view, offset, length) {
    return readHex(view, offset, length).replace(/ /g, '');
  }

  /**
   * 64비트 부호 없는 정수를 안전하게 읽는다(Number 정밀도 한계 내).
   * @param {DataView} view DataView
   * @param {number} offset 시작 오프셋
   * @returns {number} 정수값
   */
  function readUint64(view, offset) {
    const hi = view.getUint32(offset);
    const lo = view.getUint32(offset + 4);
    return hi * 0x100000000 + lo;
  }

  /**
   * 16.16 고정소수점을 실수로 변환한다.
   * @param {DataView} view DataView
   * @param {number} offset 시작 오프셋
   * @returns {string} 소수 2자리 문자열
   */
  function fixed1616(view, offset) {
    return (view.getUint32(offset) / 65536).toFixed(2);
  }

  /**
   * 8.8 고정소수점을 실수로 변환한다.
   * @param {DataView} view DataView
   * @param {number} offset 시작 오프셋
   * @returns {string} 소수 2자리 문자열
   */
  function fixed88(view, offset) {
    return (view.getUint16(offset) / 256).toFixed(2);
  }

  /**
   * ISO 639-2/T 5비트 팩 언어 코드를 디코드한다.
   * @param {DataView} view DataView
   * @param {number} offset 시작 오프셋
   * @returns {string} 3글자 언어 코드
   */
  function decodeLanguage(view, offset) {
    const v = view.getUint16(offset);
    const a = ((v >> 10) & 0x1f) + 0x60;
    const b = ((v >> 5) & 0x1f) + 0x60;
    const c = (v & 0x1f) + 0x60;
    return String.fromCharCode(a, b, c);
  }

  /**
   * 1904-01-01 기준 초를 사람이 읽는 날짜 문자열로 변환한다.
   * @param {number} seconds 1904 기준 경과 초
   * @returns {string} ISO 날짜 또는 빈 표시
   */
  function macDate(seconds) {
    if (!seconds) return '미설정';
    const epoch = Date.UTC(1904, 0, 1) / 1000;
    const d = new Date((epoch + seconds) * 1000);
    return Number.isNaN(d.getTime()) ? '?' : d.toISOString().slice(0, 19) + 'Z';
  }

  /**
   * 핸들러 타입 코드에 한국어 라벨을 덧붙인다.
   * @param {string} handler 핸들러 4글자 코드
   * @returns {string} 라벨(괄호 포함) 또는 빈 문자열
   */
  function handlerLabel(handler) {
    const map = { vide: ' (비디오)', soun: ' (오디오)', hint: ' (힌트)', meta: ' (메타)', subt: ' (자막)', text: ' (텍스트)' };
    return map[handler] || '';
  }

  /**
   * NUL 종료 또는 길이 기반 문자열을 읽는다.
   * @param {DataView} view DataView
   * @param {number} offset 시작 오프셋
   * @param {number} endOff 끝 오프셋
   * @returns {string} 디코드된 문자열
   */
  function readString(view, offset, endOff) {
    let s = '';
    for (let i = offset; i < endOff; i += 1) {
      const c = view.getUint8(i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  /**
   * 박스 트리에 부분 로드(버퍼 한도) 노드가 있는지 검사한다.
   * @param {object} box 박스 노드
   * @returns {boolean} 부분 로드 노드가 있으면 true
   */
  function markPartialLoad(box) {
    if (box.partialLoad) return true;
    return (box.children || []).some(markPartialLoad);
  }

  /**
   * 박스 트리에 파일 손상 의심(truncated) 노드가 있는지 검사한다.
   * @param {object} box 박스 노드
   * @returns {boolean} 손상 의심 노드가 있으면 true
   */
  function markTruncation(box) {
    if (box.truncated) return true;
    return (box.children || []).some(markTruncation);
  }

  global.MP4Parser = { parse, TYPE_LABELS, readHex: readHexRaw };
})(typeof window !== 'undefined' ? window : globalThis);
