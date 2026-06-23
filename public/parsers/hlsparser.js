'use strict';

/**
 * HLS(m3u8) 플레이리스트 파서.
 * 텍스트 플레이리스트를 마스터(변형)·미디어(세그먼트) 구조의 트리로 변환한다.
 */
(function (global) {
  const MAX_ITEMS = 500; // 트리에 표시할 최대 세그먼트/변형 수

  /**
   * m3u8 텍스트 버퍼를 파싱하여 트리 노드를 반환한다.
   * @param {ArrayBuffer} buffer m3u8 바이트
   * @returns {{boxes: Array<object>, truncated: boolean, byteLength: number, kind: string}} 트리와 메타
   */
  function parse(buffer) {
    const bytes = new Uint8Array(buffer);
    const text = new TextDecoder('utf-8').decode(bytes);
    const lines = splitLines(text);
    if (!lines.length || !/^\uFEFF?#EXTM3U/.test(lines[0].text)) {
      return { boxes: [], truncated: false, byteLength: buffer.byteLength, kind: 'unknown' };
    }

    const isMaster = lines.some((l) => l.text.startsWith('#EXT-X-STREAM-INF'));
    const boxes = isMaster ? parseMaster(lines, bytes) : parseMedia(lines, bytes);
    return { boxes, truncated: false, byteLength: buffer.byteLength, kind: isMaster ? 'master' : 'media' };
  }

  /**
   * 마스터 플레이리스트(변형 스트림 목록)를 파싱한다.
   * @param {Array<{text:string,offset:number,length:number}>} lines 라인 목록
   * @param {Uint8Array} bytes 원본 바이트
   * @returns {Array<object>} 트리 노드 배열
   */
  function parseMaster(lines, bytes) {
    const nodes = [makeSummaryNode('마스터 플레이리스트', countTags(lines), bytes, lines[0])];
    let shown = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.text.startsWith('#EXT-X-STREAM-INF')) {
        const uriLine = nextUri(lines, i);
        const attrs = parseAttributes(line.text.split(':')[1] || '');
        const label = `변형 · ${attrs.RESOLUTION || '?'} · ${fmtBandwidth(attrs.BANDWIDTH)} · ${attrs.CODECS || ''}`.trim();
        const fields = attrFields(attrs, line, bytes);
        if (uriLine) fields.push(field(uriLine.offset, uriLine.length, 'URI', uriLine.text, bytes));
        if (shown < MAX_ITEMS) { nodes.push(makeLeaf('STREAM', line.offset, blockLen(line, uriLine), label, fields)); shown += 1; }
      } else if (line.text.startsWith('#EXT-X-MEDIA:')) {
        const attrs = parseAttributes(line.text.split(':')[1] || '');
        const label = `미디어 · ${attrs.TYPE || ''} · ${attrs.NAME || ''} ${attrs.LANGUAGE ? '(' + attrs.LANGUAGE + ')' : ''}`.trim();
        if (shown < MAX_ITEMS) { nodes.push(makeLeaf('MEDIA', line.offset, line.length, label, attrFields(attrs, line, bytes))); shown += 1; }
      } else if (line.text.startsWith('#EXT') && !line.text.startsWith('#EXT-X-STREAM-INF')) {
        nodes.push(tagNode(line, bytes));
      }
    }
    return nodes;
  }

  /**
   * 미디어 플레이리스트(세그먼트 목록)를 파싱한다.
   * @param {Array<{text:string,offset:number,length:number}>} lines 라인 목록
   * @param {Uint8Array} bytes 원본 바이트
   * @returns {Array<object>} 트리 노드 배열
   */
  function parseMedia(lines, bytes) {
    const nodes = [makeSummaryNode('미디어 플레이리스트', countTags(lines), bytes, lines[0])];
    let shown = 0;
    let omitted = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.text.startsWith('#EXTINF')) {
        const uriLine = nextUri(lines, i);
        const dur = (line.text.split(':')[1] || '').replace(',', '').trim();
        const label = `세그먼트 · ${dur}s${uriLine ? ' · ' + shorten(uriLine.text) : ''}`;
        const fields = [field(line.offset, line.length, 'EXTINF', line.text, bytes)];
        if (uriLine) fields.push(field(uriLine.offset, uriLine.length, 'URI', uriLine.text, bytes));
        if (shown < MAX_ITEMS) { nodes.push(makeLeaf('SEG', line.offset, blockLen(line, uriLine), label, fields)); shown += 1; }
        else omitted += 1;
      } else if (/^#EXT-X-(KEY|MAP|BYTERANGE|PROGRAM-DATE-TIME|DISCONTINUITY)/.test(line.text)) {
        if (shown < MAX_ITEMS) nodes.push(tagNode(line, bytes));
      } else if (line.text.startsWith('#EXT') && !line.text.startsWith('#EXTINF')) {
        nodes.push(tagNode(line, bytes));
      }
    }
    if (omitted > 0) nodes.push(makeLeaf('…', lines[0].offset, 0, `외 ${omitted}개 세그먼트 생략`, []));
    return nodes;
  }

  // ------- 노드 빌더 -------

  /**
   * 플레이리스트 요약 노드를 만든다.
   * @param {string} title 플레이리스트 종류 라벨
   * @param {object} counts 태그 카운트
   * @param {Uint8Array} bytes 원본 바이트
   * @param {{offset:number,length:number}} firstLine 첫 라인
   * @returns {object} 요약 노드
   */
  function makeSummaryNode(title, counts, bytes, firstLine) {
    const parts = [];
    if (counts.streams) parts.push(`변형 ${counts.streams}`);
    if (counts.segments) parts.push(`세그먼트 ${counts.segments}`);
    if (counts.media) parts.push(`미디어 ${counts.media}`);
    parts.push(counts.endlist ? 'VOD(ENDLIST)' : 'LIVE/미완결');
    return makeLeaf('M3U8', 0, firstLine ? firstLine.length : 0, `${title} · ${parts.join(' · ')}`, []);
  }

  /**
   * 일반 태그 라인을 노드로 만든다.
   * @param {{text:string,offset:number,length:number}} line 라인
   * @param {Uint8Array} bytes 원본 바이트
   * @returns {object} 태그 노드
   */
  function tagNode(line, bytes) {
    const name = line.text.split(':')[0];
    const value = line.text.slice(name.length + 1);
    return makeLeaf('TAG', line.offset, line.length, `${name}${value ? ' = ' + value : ''}`,
      [field(line.offset, line.length, name.replace('#', ''), value || '(플래그)', bytes)]);
  }

  /**
   * 속성 객체를 필드 배열로 변환한다.
   * @param {object} attrs 속성 맵
   * @param {{offset:number,length:number}} line 라인
   * @param {Uint8Array} bytes 원본 바이트
   * @returns {Array<object>} 필드 배열
   */
  function attrFields(attrs, line, bytes) {
    return Object.entries(attrs).map(([k, v]) => ({ offset: line.offset, length: 0, name: k, value: v, hex: '' }))
      .concat([field(line.offset, line.length, 'raw', line.text, bytes)]);
  }

  // ------- 파싱 헬퍼 -------

  /**
   * 태그 종류별 개수를 센다.
   * @param {Array<{text:string}>} lines 라인 목록
   * @returns {{streams:number,segments:number,media:number,endlist:boolean}} 카운트
   */
  function countTags(lines) {
    let streams = 0; let segments = 0; let media = 0; let endlist = false;
    for (const l of lines) {
      if (l.text.startsWith('#EXT-X-STREAM-INF')) streams += 1;
      else if (l.text.startsWith('#EXTINF')) segments += 1;
      else if (l.text.startsWith('#EXT-X-MEDIA:')) media += 1;
      else if (l.text.startsWith('#EXT-X-ENDLIST')) endlist = true;
    }
    return { streams, segments, media, endlist };
  }

  /**
   * 주어진 인덱스 다음의 첫 URI(비주석) 라인을 찾는다.
   * @param {Array<{text:string,offset:number,length:number}>} lines 라인 목록
   * @param {number} i 기준 인덱스
   * @returns {{text:string,offset:number,length:number}|null} URI 라인
   */
  function nextUri(lines, i) {
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].text.startsWith('#')) return lines[j];
      if (lines[j].text.startsWith('#EXTINF') || lines[j].text.startsWith('#EXT-X-STREAM-INF')) return null;
    }
    return null;
  }

  /**
   * HLS 속성 리스트(KEY=VALUE,KEY="V")를 객체로 파싱한다.
   * @param {string} str 속성 문자열
   * @returns {object} 속성 맵
   */
  function parseAttributes(str) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      attrs[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    return attrs;
  }

  /**
   * 텍스트를 라인 단위로 분할하고 각 라인의 바이트 오프셋을 계산한다.
   * @param {string} text 전체 텍스트
   * @returns {Array<{text:string,offset:number,length:number}>} 라인 목록
   */
  function splitLines(text) {
    const out = [];
    let offset = 0;
    for (const raw of text.split('\n')) {
      const trimmed = raw.replace(/\r$/, '');
      const t = trimmed.trim();
      if (t.length) out.push({ text: t, offset, length: byteLen(trimmed) });
      offset += byteLen(raw) + 1; // '\n'
    }
    return out;
  }

  /**
   * 변형+URI 블록의 대략적 바이트 길이를 구한다.
   * @param {{offset:number,length:number}} line 태그 라인
   * @param {{offset:number,length:number}|null} uriLine URI 라인
   * @returns {number} 길이
   */
  function blockLen(line, uriLine) {
    if (!uriLine) return line.length;
    return (uriLine.offset + uriLine.length) - line.offset;
  }

  /**
   * BANDWIDTH 값을 사람이 읽는 비트레이트로 변환한다.
   * @param {string} bw BANDWIDTH 속성
   * @returns {string} 표시 문자열
   */
  function fmtBandwidth(bw) {
    const n = Number(bw);
    if (!n) return '?';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + ' Mbps';
    return (n / 1e3).toFixed(0) + ' kbps';
  }

  /**
   * 긴 URI를 뒤쪽 위주로 축약한다.
   * @param {string} s URI 문자열
   * @returns {string} 축약된 문자열
   */
  function shorten(s) {
    return s.length > 48 ? '…' + s.slice(-45) : s;
  }

  /**
   * UTF-8 바이트 길이를 구한다.
   * @param {string} s 문자열
   * @returns {number} 바이트 길이
   */
  function byteLen(s) {
    return new TextEncoder().encode(s).length;
  }

  /**
   * 리프 노드를 생성한다(다른 파서와 동일한 트리 노드 형태).
   * @param {string} type 노드 타입 코드
   * @param {number} start 시작 오프셋
   * @param {number} size 바이트 길이
   * @param {string} label 라벨
   * @param {Array<object>} fields 필드 배열
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
   * @param {number} offset 절대 오프셋
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

  global.HlsParser = { parse };
})(typeof window !== 'undefined' ? window : globalThis);
