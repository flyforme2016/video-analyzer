'use strict';

/**
 * GIF87a/GIF89a 컨테이너 파서.
 * 헤더·논리 화면·확장·이미지 프레임 블록을 트리와 필드 주석으로 반환한다.
 */
(function (global) {
  /**
   * ArrayBuffer 전체를 파싱하여 최상위 블록 배열을 반환한다.
   * @param {ArrayBuffer} buffer 파싱할 GIF 바이트
   * @returns {{boxes: Array<object>, truncated: boolean, byteLength: number}} 블록 트리와 메타정보
   */
  function parse(buffer) {
    const bytes = new Uint8Array(buffer);
    const boxes = [];
    if (bytes.length < 13 || readAscii(bytes, 0, 3) !== 'GIF') {
      return { boxes, truncated: false, byteLength: buffer.byteLength };
    }
    let pos = 0;
    const sig = readAscii(bytes, 0, 6);
    boxes.push(makeLeaf('HDR', 0, 6, 'GIF 헤더', [
      field(0, 3, 'signature', '"GIF"', bytes),
      field(3, 3, 'version', `"${sig.slice(3)}"`, bytes),
    ]));
    pos = 6;

    const lsdStart = pos;
    const packed = bytes[pos + 4];
    const gctFlag = (packed & 0x80) !== 0;
    const gctPow = (packed & 0x07) + 1;
    const gctColors = 1 << gctPow;
    const width = bytes[pos] | (bytes[pos + 1] << 8);
    const height = bytes[pos + 2] | (bytes[pos + 3] << 8);
    boxes.push(makeLeaf('LSD', lsdStart, 7, '논리 화면 설명자', [
      field(lsdStart, 2, 'width', `${width} px`, bytes),
      field(lsdStart + 2, 2, 'height', `${height} px`, bytes),
      field(lsdStart + 4, 1, 'packed', describeLsdPacked(packed), bytes),
      field(lsdStart + 5, 1, 'bg_color_index', String(bytes[pos + 5]), bytes),
      field(lsdStart + 6, 1, 'pixel_aspect', String(bytes[pos + 6]), bytes),
    ]));
    pos = 13;

    if (gctFlag) {
      const gctLen = 3 * gctColors;
      boxes.push(makeLeaf('GCT', pos, gctLen, `전역 색상표 (${gctColors}색)`, [
        field(pos, Math.min(gctLen, 12), 'colors', `RGB × ${gctColors}`, bytes),
      ]));
      pos += gctLen;
    }

    let frame = 0;
    let truncated = false;
    while (pos < bytes.length) {
      const marker = bytes[pos];
      if (marker === 0x3b) {
        boxes.push(makeLeaf('TRAILER', pos, 1, '파일 종료 (0x3B)', [
          field(pos, 1, 'trailer', '0x3B', bytes),
        ]));
        pos += 1;
        break;
      }
      if (marker === 0x21) {
        const block = parseExtension(bytes, pos, frame);
        if (!block) { truncated = true; break; }
        boxes.push(block.node);
        pos = block.end;
        continue;
      }
      if (marker === 0x2c) {
        const block = parseImage(bytes, pos, frame);
        if (!block) { truncated = true; break; }
        boxes.push(block.node);
        frame += 1;
        pos = block.end;
        continue;
      }
      truncated = true;
      break;
    }
    if (pos < bytes.length && !truncated) truncated = true;
    return { boxes, truncated, byteLength: buffer.byteLength };
  }

  /**
   * GIF 확장 블록(0x21)을 파싱한다.
   * @param {Uint8Array} bytes 파일 바이트
   * @param {number} start 시작 오프셋
   * @param {number} frameIdx 현재까지의 프레임 수(라벨용)
   * @returns {{node: object, end: number}|null} 파싱 결과 또는 null
   */
  function parseExtension(bytes, start, frameIdx) {
    if (start + 2 >= bytes.length) return null;
    const label = bytes[start + 1];
    const labelName = EXT_LABELS[label] || `0x${label.toString(16)}`;
    const fields = [
      field(start, 1, 'introducer', '0x21 (확장)', bytes),
      field(start + 1, 1, 'label', `${labelName}`, bytes),
    ];
    let pos = start + 2;
    if (label === 0xf9 && pos + 6 <= bytes.length) {
      const packed = bytes[pos + 1];
      const delay = bytes[pos + 2] | (bytes[pos + 3] << 8);
      fields.push(field(pos, 1, 'block_size', '4', bytes));
      fields.push(field(pos + 1, 1, 'packed', describeGcePacked(packed), bytes));
      fields.push(field(pos + 2, 2, 'delay', `${delay} (1/100초) ≈ ${(delay / 100).toFixed(2)}s`, bytes));
      fields.push(field(pos + 4, 1, 'transparent_color', String(bytes[pos + 4]), bytes));
      pos += 5;
      if (bytes[pos] === 0) pos += 1;
      return { node: makeLeaf('GCE', start, pos - start, `Graphic Control (프레임 ${frameIdx} 전)`, fields), end: pos };
    }
    if (pos >= bytes.length) return null;
    const blockSize = bytes[pos];
    fields.push(field(pos, 1, 'block_size', String(blockSize), bytes));
    pos += 1 + blockSize;
    const sub = skipSubBlocks(bytes, pos);
    if (!sub) return null;
    pos = sub;
    return { node: makeLeaf('EXT', start, pos - start, `확장: ${labelName}`, fields), end: pos };
  }

  /**
   * GIF 이미지 디스크립터(0x2C)와 LZW 데이터를 파싱한다.
   * @param {Uint8Array} bytes 파일 바이트
   * @param {number} start 시작 오프셋
   * @param {number} frameIdx 프레임 인덱스
   * @returns {{node: object, end: number}|null} 파싱 결과 또는 null
   */
  function parseImage(bytes, start, frameIdx) {
    if (start + 10 > bytes.length) return null;
    const left = bytes[start + 1] | (bytes[start + 2] << 8);
    const top = bytes[start + 3] | (bytes[start + 4] << 8);
    const iw = bytes[start + 5] | (bytes[start + 6] << 8);
    const ih = bytes[start + 7] | (bytes[start + 8] << 8);
    const packed = bytes[start + 9];
    const lctFlag = (packed & 0x80) !== 0;
    const lctPow = (packed & 0x07) + 1;
    const lctColors = 1 << lctPow;
    const fields = [
      field(start, 1, 'separator', '0x2C (이미지)', bytes),
      field(start + 1, 2, 'left', String(left), bytes),
      field(start + 3, 2, 'top', String(top), bytes),
      field(start + 5, 2, 'width', `${iw} px`, bytes),
      field(start + 7, 2, 'height', `${ih} px`, bytes),
      field(start + 9, 1, 'packed', describeImgPacked(packed), bytes),
    ];
    let pos = start + 10;
    if (lctFlag) pos += 3 * lctColors;
    if (pos >= bytes.length) return null;
    fields.push(field(pos, 1, 'lzw_min_code_size', String(bytes[pos]), bytes));
    pos += 1;
    const sub = skipSubBlocks(bytes, pos);
    if (!sub) return null;
    pos = sub;
    return { node: makeLeaf('IMG', start, pos - start, `이미지 프레임 #${frameIdx} (${iw}×${ih})`, fields), end: pos };
  }

  /**
   * GIF 서브블록 체인(크기 바이트 + 데이터 반복, 0 종료)을 건너뛴다.
   * @param {Uint8Array} bytes 파일 바이트
   * @param {number} pos 서브블록 시작 오프셋
   * @returns {number|null} 체인 종료 직후 오프셋 또는 null
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
   * LSD packed 바이트를 사람이 읽는 설명으로 변환한다.
   * @param {number} packed packed 바이트
   * @returns {string} 설명 문자열
   */
  function describeLsdPacked(packed) {
    const gct = (packed & 0x80) ? 'GCT 있음' : 'GCT 없음';
    const depth = ((packed >> 4) & 0x07) + 1;
    const sort = (packed & 0x08) ? ', 정렬' : '';
    const size = 1 << ((packed & 0x07) + 1);
    return `${gct}, ${depth}bit, GCT ${size}색${sort}`;
  }

  /**
   * Graphic Control Extension packed 바이트 설명.
   * @param {number} packed packed 바이트
   * @returns {string} 설명 문자열
   */
  function describeGcePacked(packed) {
    const disp = (packed >> 2) & 0x07;
    const dispMap = ['미지정', '유지', '배경복원', '이전복원'];
    const t = (packed & 0x01) ? ', 투명색 있음' : '';
    return `disposal=${dispMap[disp] || disp}${t}`;
  }

  /**
   * 이미지 디스크립터 packed 바이트 설명.
   * @param {number} packed packed 바이트
   * @returns {string} 설명 문자열
   */
  function describeImgPacked(packed) {
    const lct = (packed & 0x80) ? 'LCT 있음' : 'LCT 없음';
    const interlace = (packed & 0x40) ? ', 인터레이스' : '';
    const size = 1 << ((packed & 0x07) + 1);
    return `${lct}, LCT ${size}색${interlace}`;
  }

  const EXT_LABELS = {
    0xf9: 'Graphic Control',
    0xff: 'Comment',
    0xfe: 'Plain Text',
    0x01: 'Application',
  };

  /**
   * 리프 블록 노드를 생성한다(MP4 파서와 동일한 트리 노드 형태).
   * @param {string} type 블록 타입 코드
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
   * 지정 범위를 ASCII로 읽는다.
   * @param {Uint8Array} bytes 바이트 배열
   * @param {number} offset 시작 오프셋
   * @param {number} len 길이
   * @returns {string} ASCII 문자열
   */
  function readAscii(bytes, offset, len) {
    let s = '';
    for (let i = 0; i < len && offset + i < bytes.length; i += 1) {
      s += String.fromCharCode(bytes[offset + i]);
    }
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

  global.GifParser = { parse };
})(typeof window !== 'undefined' ? window : globalThis);
