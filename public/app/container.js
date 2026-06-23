/**
 * 컨테이너 바이트 처리: 포맷 감지 → 포맷별 파서 디스패치 →
 * 박스/컨테이너 트리 렌더, 필드 주석, Hex 덤프.
 * 파서들은 window.*Parser 전역(parsers/*.js)으로 로드되어 있어야 한다.
 */

import { state, dom, HEX_VIEW_CAP, escapeHtml, fmtBytes } from './state.js';
import { reconcilePlaybackKind, playbackKindFromFormat } from './playback.js';

/**
 * ArrayBuffer를 파싱하여 컨테이너 포맷별 트리를 렌더하거나 원시 Hex로 폴백한다.
 * @param {ArrayBuffer} buffer 파일(또는 선두 일부) 바이트
 * @param {boolean} partial 일부만 읽었는지 여부(잘림 경고용)
 * @returns {void}
 */
export function handleBuffer(buffer, partial) {
  state.buffer = buffer;
  const fmt = detectContainerFormat(buffer);
  const parsed = parseContainerBuffer(buffer, fmt);
  state.boxes = parsed.boxes;
  state.containerFormat = parsed.format;
  const kind = playbackKindFromFormat(parsed.format);
  if (kind) reconcilePlaybackKind(kind);

  if (parsed.format !== 'unknown') {
    if (dom.containerTreeLabel) dom.containerTreeLabel.textContent = '컨테이너 트리 (' + parsed.label + ')';
    dom.treeEmpty.hidden = true;
    renderBoxTree(parsed.boxes);
    const first = findFirstInteresting(parsed.boxes, parsed.format) || parsed.boxes[0];
    if (first) selectBox(first);
  } else {
    if (dom.containerTreeLabel) dom.containerTreeLabel.textContent = '컨테이너 트리';
    dom.boxTree.innerHTML = '';
    dom.treeEmpty.hidden = false;
    dom.treeEmpty.textContent = '지원 컨테이너: MP4/MOV, GIF, WebM, FLV, HLS(m3u8), MPEG-TS. 이 파일은 원시 Hex로 표시합니다.';
    renderFallbackHex(buffer, partial);
  }
}

/**
 * 파일 선두 바이트로 컨테이너 포맷을 감지한다.
 * @param {ArrayBuffer} buffer 파일 바이트
 * @returns {'mp4'|'gif'|'webm'|'unknown'} 감지된 포맷
 */
function detectContainerFormat(buffer) {
  const b = new Uint8Array(buffer);
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && b[4] === 0x39 && b[5] === 0x61) return 'gif';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && b[4] === 0x37 && b[5] === 0x61) return 'gif';
  if (b.length >= 3 && b[0] === 0x46 && b[1] === 0x4c && b[2] === 0x56) return 'flv';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (isExtM3u(b)) return 'hls';
  if (b.length >= 8) {
    const tag = String.fromCharCode(b[4], b[5], b[6], b[7]);
    if (tag === 'ftyp' || tag === 'moov' || tag === 'mdat' || tag === 'styp' || tag === 'free') return 'mp4';
  }
  if (window.TsParser && window.TsParser.detectLayout(b)) return 'ts';
  return 'unknown';
}

/**
 * 선두 바이트가 #EXTM3U(HLS 플레이리스트)로 시작하는지 확인한다(BOM 허용).
 * @param {Uint8Array} b 파일 바이트
 * @returns {boolean} HLS 플레이리스트면 true
 */
function isExtM3u(b) {
  let i = 0;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  const sig = '#EXTM3U';
  if (b.length < i + sig.length) return false;
  for (let j = 0; j < sig.length; j += 1) {
    if (b[i + j] !== sig.charCodeAt(j)) return false;
  }
  return true;
}

/**
 * 감지된 포맷에 맞는 파서로 컨테이너 트리를 파싱한다.
 * @param {ArrayBuffer} buffer 파일 바이트
 * @param {string} fmt detectContainerFormat 결과
 * @returns {{format:string,label:string,boxes:Array<object>}} 파싱 결과
 */
function parseContainerBuffer(buffer, fmt) {
  if (fmt === 'gif' && window.GifParser) {
    const r = window.GifParser.parse(buffer);
    return { format: 'gif', label: 'GIF', boxes: r.boxes };
  }
  if (fmt === 'webm' && window.EbmlParser) {
    const r = window.EbmlParser.parse(buffer);
    return { format: 'webm', label: 'WebM (EBML)', boxes: r.boxes };
  }
  if (fmt === 'flv' && window.FlvParser) {
    const r = window.FlvParser.parse(buffer);
    return { format: 'flv', label: 'FLV (Flash Video)', boxes: r.boxes };
  }
  if (fmt === 'hls' && window.HlsParser) {
    const r = window.HlsParser.parse(buffer);
    const label = r.kind === 'master' ? 'HLS 마스터 (m3u8)' : 'HLS 미디어 (m3u8)';
    return { format: 'hls', label, boxes: r.boxes };
  }
  if (fmt === 'ts' && window.TsParser) {
    const r = window.TsParser.parse(buffer);
    if (r.boxes.length) return { format: 'ts', label: 'MPEG-TS', boxes: r.boxes };
  }
  const r = window.MP4Parser.parse(buffer, { fileSize: state.fileSize || 0 });
  if (isLikelyIsoBmff(r.boxes)) {
    return { format: 'mp4', label: 'MP4/MOV (ISO BMFF)', boxes: r.boxes };
  }
  return { format: 'unknown', label: '', boxes: r.boxes };
}

/**
 * 포맷별로 처음 보여줄 대표 블록을 고른다.
 * @param {Array<object>} boxes 최상위 블록 배열
 * @param {string} fmt 컨테이너 포맷
 * @returns {object|null} 대표 블록
 */
function findFirstInteresting(boxes, fmt) {
  if (fmt === 'gif') return boxes.find((b) => b.type === 'HDR') || boxes.find((b) => b.type === 'GCE') || boxes.find((b) => b.type === 'IMG');
  if (fmt === 'webm') return boxes.find((b) => b.type === 'EBML') || boxes.find((b) => b.type === 'Info');
  if (fmt === 'flv') return boxes.find((b) => b.type === 'FLV') || boxes.find((b) => b.type === 'script') || boxes[0];
  if (fmt === 'hls') return boxes.find((b) => b.type === 'M3U8') || boxes[0];
  if (fmt === 'ts') return boxes.find((b) => b.type === 'TS') || boxes[0];
  return boxes.find((b) => b.type === 'ftyp') || boxes[0];
}

/**
 * 최상위 박스들이 ISO BMFF로 보이는지(알려진 타입 포함) 판정한다.
 * @param {Array<object>} boxes 최상위 박스 배열
 * @returns {boolean} ISO BMFF로 추정되면 true
 */
function isLikelyIsoBmff(boxes) {
  if (!boxes || !boxes.length) return false;
  const known = new Set(['ftyp', 'moov', 'mdat', 'free', 'styp', 'sidx', 'moof', 'skip', 'wide', 'pdin']);
  return boxes.slice(0, 4).some((b) => known.has(b.type));
}

/**
 * 최상위 박스 배열을 트리 UI로 렌더한다.
 * @param {Array<object>} boxes 최상위 박스 배열
 * @returns {void}
 */
function renderBoxTree(boxes) {
  dom.boxTree.innerHTML = '';
  boxes.forEach((b) => dom.boxTree.appendChild(buildTreeNode(b)));
  if (dom.treeHeadActions) dom.treeHeadActions.hidden = boxes.length === 0;
}

/**
 * 트리 항목의 접힘 상태를 설정한다.
 * @param {HTMLLIElement} li 트리 항목
 * @param {HTMLButtonElement|null} toggle 토글 버튼(없으면 null)
 * @param {boolean} collapsed 접을지 여부
 * @returns {void}
 */
function setTreeCollapsed(li, toggle, collapsed) {
  li.classList.toggle('collapsed', collapsed);
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.textContent = collapsed ? '▶' : '▼';
    toggle.setAttribute('aria-label', collapsed ? '펼치기' : '접기');
  }
}

/**
 * 박스 트리의 모든 컨테이너 노드를 일괄 접거나 펼친다.
 * @param {boolean} collapsed true면 전체 접기
 * @returns {void}
 */
export function setAllTreeCollapsed(collapsed) {
  dom.boxTree.querySelectorAll('li').forEach((li) => {
    if (!li.querySelector(':scope > ul')) return;
    const toggle = li.querySelector(':scope > .node > .tree-toggle');
    setTreeCollapsed(li, toggle, collapsed);
  });
}

/**
 * 박스 노드의 부분로드/손상 배지 HTML을 반환한다.
 * @param {object} box 박스 노드
 * @returns {string} 배지 HTML 또는 빈 문자열
 */
function boxBadge(box) {
  if (box.truncated) return '⚠ 파일 손상 의심';
  if (!box.partialLoad) return '';
  if (box.type === 'mdat') return '본문 미로드';
  if (box.type === 'stco' || box.type === 'co64' || box.type === 'stsz') return '테이블 일부만 로드';
  return '일부만 로드';
}

/**
 * 단일 박스(및 자식)를 <li> 트리 노드로 만든다.
 * @param {object} box 박스 노드
 * @returns {HTMLLIElement} 트리 항목 요소
 */
function buildTreeNode(box) {
  const li = document.createElement('li');
  const node = document.createElement('div');
  const hasKids = !!(box.children && box.children.length);
  let cls = 'node' + (hasKids ? ' container' : '');
  if (box.truncated) cls += ' truncated';
  else if (box.partialLoad) cls += ' partial-load';
  node.className = cls;

  if (hasKids) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-toggle';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', '접기');
    toggle.textContent = '▼';
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      setTreeCollapsed(li, toggle, !li.classList.contains('collapsed'));
    });
    node.appendChild(toggle);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'tree-toggle-spacer';
    spacer.setAttribute('aria-hidden', 'true');
    node.appendChild(spacer);
  }

  const badge = boxBadge(box);
  const type = document.createElement('span');
  type.className = 'ntype';
  type.textContent = box.type;
  node.appendChild(type);
  const size = document.createElement('span');
  size.className = 'nsize';
  size.textContent = fmtBytes(box.size);
  node.appendChild(size);
  if (box.label) {
    const label = document.createElement('span');
    label.className = 'nlabel';
    label.textContent = box.label;
    node.appendChild(label);
  }
  if (badge) {
    const badgeEl = document.createElement('span');
    badgeEl.className = 'nlabel';
    badgeEl.textContent = badge;
    node.appendChild(badgeEl);
  }

  node.addEventListener('click', (e) => { e.stopPropagation(); selectBox(box, node); });
  box._node = node;
  li.appendChild(node);
  if (hasKids) {
    const ul = document.createElement('ul');
    box.children.forEach((c) => ul.appendChild(buildTreeNode(c)));
    li.appendChild(ul);
  }
  return li;
}

/**
 * 트리에서 첫 번째 리프(주석이 풍부한) 박스를 찾는다(없으면 null).
 * @param {Array<object>} boxes 박스 배열
 * @returns {object|null} 첫 리프 박스
 */
function findFirstLeaf(boxes) {
  return findFirstInteresting(boxes, state.containerFormat || 'mp4');
}

/**
 * 박스를 선택 상태로 만들고 필드/Hex 상세를 렌더한다.
 * @param {object} box 선택할 박스
 * @param {HTMLElement} [nodeEl] 트리 노드 요소(하이라이트용)
 * @returns {void}
 */
function selectBox(box, nodeEl) {
  state.selectedBox = box;
  state.selectedRange = null;
  document.querySelectorAll('.node.selected').forEach((n) => n.classList.remove('selected'));
  const target = nodeEl || box._node;
  if (target) target.classList.add('selected');
  dom.detailTitle.textContent = `${box.type} — ${box.label || '박스'} · 오프셋 ${box.start} · ${fmtBytes(box.size)}`;
  renderFields(box);
  renderBoxHex(box);
}

/**
 * 선택된 박스의 필드 주석 목록을 렌더한다.
 * @param {object} box 대상 박스
 * @returns {void}
 */
function renderFields(box) {
  dom.fieldList.innerHTML = '';
  if (!box.fields || !box.fields.length) {
    dom.fieldList.innerHTML = '<div class="empty">표시할 필드 주석이 없습니다(컨테이너 또는 원시 데이터).</div>';
    return;
  }
  box.fields.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'field';
    row.innerHTML =
      `<div class="fhex">${escapeHtml(f.hex || '')}</div>` +
      `<div class="fmeta">` +
      `<span class="fname">${escapeHtml(f.name)}</span>` +
      `<span class="fval">${escapeHtml(String(f.value))}</span>` +
      `<span class="foff">@${f.offset} · ${f.length}B</span>` +
      `</div>`;
    row.addEventListener('click', () => {
      document.querySelectorAll('.field.active').forEach((n) => n.classList.remove('active'));
      row.classList.add('active');
      state.selectedRange = { start: f.offset, end: f.offset + f.length };
      renderBoxHex(box);
    });
    dom.fieldList.appendChild(row);
  });
}

/**
 * 선택된 박스의 바이트 범위를 Hex 덤프로 렌더한다(상한 적용, 필드 하이라이트).
 * @param {object} box 대상 박스
 * @returns {void}
 */
function renderBoxHex(box) {
  const start = box.start;
  const end = Math.min(box.start + Math.min(box.size, HEX_VIEW_CAP), state.buffer.byteLength);
  dom.hexDump.innerHTML = buildHexHtml(state.buffer, start, end, state.selectedRange) +
    (box.size > HEX_VIEW_CAP ? `\n<span class="off">… 이하 ${fmtBytes(box.size - HEX_VIEW_CAP)} 생략</span>` : '');
}

/**
 * ISO BMFF가 아닌 경우 파일 선두를 원시 Hex 덤프로 렌더한다.
 * @param {ArrayBuffer} buffer 바이트 버퍼
 * @param {boolean} partial 일부만 읽었는지 여부
 * @returns {void}
 */
function renderFallbackHex(buffer, partial) {
  dom.fieldList.innerHTML = '<div class="empty">비-MP4 컨테이너: 좌측 트리 대신 원시 Hex를 확인하세요.</div>';
  dom.detailTitle.textContent = '원시 Hex (선두 ' + fmtBytes(Math.min(buffer.byteLength, HEX_VIEW_CAP)) + ')';
  const end = Math.min(buffer.byteLength, HEX_VIEW_CAP);
  dom.hexDump.innerHTML = buildHexHtml(buffer, 0, end, null) + (partial ? '\n<span class="off">… (일부만 로드됨)</span>' : '');
}

/**
 * 지정 범위를 오프셋·16진수·ASCII 3열의 Hex 덤프 HTML로 만든다.
 * @param {ArrayBuffer} buffer 바이트 버퍼
 * @param {number} start 시작 오프셋
 * @param {number} end 끝 오프셋(미포함)
 * @param {{start:number,end:number}|null} hi 하이라이트할 절대 범위
 * @returns {string} 안전하게 이스케이프된 HTML 문자열
 */
function buildHexHtml(buffer, start, end, hi) {
  const bytes = new Uint8Array(buffer);
  const lines = [];
  for (let row = start; row < end; row += 16) {
    const off = '<span class="off">' + row.toString(16).padStart(8, '0') + '</span>';
    let hex = '';
    let asc = '';
    for (let i = 0; i < 16; i += 1) {
      const idx = row + i;
      if (idx >= end) { hex += '   '; continue; }
      const b = bytes[idx];
      const hh = b.toString(16).padStart(2, '0');
      const inHi = hi && idx >= hi.start && idx < hi.end;
      hex += (inHi ? `<span class="hi">${hh}</span>` : hh) + ' ';
      const ch = b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
      asc += inHi ? `<span class="hi">${escapeHtml(ch)}</span>` : escapeHtml(ch);
    }
    lines.push(`${off}  ${hex} <span class="asc">${asc}</span>`);
  }
  return lines.join('\n');
}
