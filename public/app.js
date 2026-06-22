'use strict';

/**
 * 프론트엔드 컨트롤러: 소스 입력(드롭/URL) → 비디오 재생 → 바이트·박스 시각화
 * → ffprobe 분석 → 트랜스코딩 이상 점검을 연결한다.
 */
(function () {
  const MAX_PARSE_BYTES = 256 * 1024 * 1024; // 박스 파싱을 위해 읽을 최대 바이트
  const HEX_VIEW_CAP = 4096; // 한 박스에서 hex로 보여줄 최대 바이트

  const state = {
    buffer: null,
    boxes: [],
    selectedBox: null,
    selectedRange: null,
    objectUrl: null,
    fileSize: 0,
    containerFormat: 'unknown',
    playbackKind: 'video',
    playerSrc: null,
    loadGeneration: 0,
    probe: null,
    integrity: null,
  };

  const dom = {};

  /**
   * 앱을 초기화하고 DOM 참조 및 이벤트 핸들러를 등록한다.
   * @returns {void}
   */
  function init() {
    cacheDom();
    setupTabs();
    setupDragAndDrop();
    dom.fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) loadLocalFile(e.target.files[0]);
    });
    dom.urlBtn.addEventListener('click', () => {
      const url = dom.urlInput.value.trim();
      if (url) loadRemoteUrl(url);
    });
    dom.urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') dom.urlBtn.click();
    });
    dom.copyProbe.addEventListener('click', copyProbeJson);
    setupBytesSplitter();
    setupTreeCollapse();
  }

  /**
   * 박스 트리 전체 접기/펼치기 버튼을 연결한다.
   * @returns {void}
   */
  function setupTreeCollapse() {
    if (dom.treeExpandAll) {
      dom.treeExpandAll.addEventListener('click', () => setAllTreeCollapsed(false));
    }
    if (dom.treeCollapseAll) {
      dom.treeCollapseAll.addEventListener('click', () => setAllTreeCollapsed(true));
    }
  }

  /**
   * 바이트/박스 탭 왼쪽(박스 트리) 패널 너비를 드래그로 조절할 수 있게 한다.
   * 마지막 너비는 localStorage에 저장한다.
   * @returns {void}
   */
  function setupBytesSplitter() {
    const layout = document.getElementById('bytesLayout');
    const pane = document.getElementById('boxTreePane');
    const splitter = document.getElementById('bytesSplitter');
    if (!layout || !pane || !splitter) return;

    const saved = Number(localStorage.getItem('va-bytes-tree-width'));
    if (saved > 0) setTreePaneWidth(layout, pane, saved);

    let dragging = false;

    splitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      splitter.classList.add('dragging');
      document.body.classList.add('col-resize-cursor');
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = layout.getBoundingClientRect();
      const width = clampTreeWidth(e.clientX - rect.left, rect.width);
      setTreePaneWidth(layout, pane, width);
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove('dragging');
      document.body.classList.remove('col-resize-cursor');
      localStorage.setItem('va-bytes-tree-width', String(pane.offsetWidth));
    });
  }

  /**
   * 박스 트리 패널의 너비를 설정한다.
   * @param {HTMLElement} layout bytes-layout 컨테이너
   * @param {HTMLElement} pane 박스 트리 패널
   * @param {number} width 픽셀 너비
   * @returns {void}
   */
  function setTreePaneWidth(layout, pane, width) {
    const w = clampTreeWidth(width, layout.getBoundingClientRect().width);
    pane.style.width = w + 'px';
    pane.style.flexBasis = w + 'px';
  }

  /**
   * 박스 트리 패널 너비를 허용 범위 안으로 제한한다.
   * @param {number} width 요청 너비(px)
   * @param {number} layoutWidth 레이아웃 전체 너비(px)
   * @returns {number} 제한된 너비
   */
  function clampTreeWidth(width, layoutWidth) {
    const min = 140;
    const max = Math.max(min, layoutWidth * 0.65);
    return Math.min(Math.max(width, min), max);
  }

  /**
   * 자주 쓰는 DOM 요소를 dom 객체에 캐싱한다.
   * @returns {void}
   */
  function cacheDom() {
    const ids = ['dropzone', 'fileInput', 'urlInput', 'urlBtn', 'status', 'player', 'imagePlayer',
      'playerStage', 'playerTitle', 'playerKindBadge',
      'sourceLabel', 'quickMeta', 'boxTree', 'treeEmpty', 'detailTitle', 'fieldList',
      'hexDump', 'probeSummary', 'probeJson', 'probeElapsed', 'copyProbe',
      'checksScore', 'checksList', 'containerTreeLabel', 'treeHeadActions',
      'treeExpandAll', 'treeCollapseAll',
      'integrityScore', 'integrityMeta', 'integrityList'];
    ids.forEach((id) => { dom[id] = document.getElementById(id); });
  }

  // ------- 소스 로딩 -------

  /**
   * 로컬 파일을 받아 재생, 바이트 파싱, ffprobe 분석을 수행한다.
   * @param {File} file 사용자가 선택/드롭한 비디오 파일
   * @returns {Promise<void>}
   */
  async function loadLocalFile(file) {
    resetForNewSource(`${file.name} · ${fmtBytes(file.size)}`);
    const kindHint = detectPlaybackKindFromFile(file) || 'video';
    setPlayerSrc(makeObjectUrl(file), kindHint);
    setStatus('파일 분석·무결성 검사 중… (대용량은 수 분 걸릴 수 있음)', 'loading');
    try {
      state.fileSize = file.size;
      await parseBytesFromFile(file);
      await probeViaUpload(file);
      finishStatus();
    } catch (err) {
      setStatus('분석 중 오류: ' + (err.message || err), 'error');
    }
  }

  /**
   * 원격 URL을 받아 (프록시 경유) 재생, 바이트 파싱, ffprobe 분석을 수행한다.
   * @param {string} url 분석할 http(s) 비디오 URL
   * @returns {Promise<void>}
   */
  async function loadRemoteUrl(url) {
    resetForNewSource(url);
    const kindHint = detectPlaybackKindFromUrl(url) || 'video';
    setPlayerSrc('/api/proxy?url=' + encodeURIComponent(url), kindHint);
    setStatus('URL 분석·무결성 검사 중…', 'loading');
    try {
      state.fileSize = 0;
      await parseBytesFromUrl(url);
      await probeViaUrl(url);
      finishStatus();
    } catch (err) {
      setStatus('분석 중 오류: ' + (err.message || err), 'error');
    }
  }

  /**
   * 새 소스를 불러오기 전에 UI 상태와 패널을 초기화한다.
   * @param {string} label 소스 라벨(파일명/URL)
   * @returns {void}
   */
  function resetForNewSource(label) {
    state.loadGeneration += 1;
    dom.sourceLabel.textContent = label;
    dom.boxTree.innerHTML = '';
    dom.fieldList.innerHTML = '';
    dom.hexDump.innerHTML = '';
    dom.detailTitle.textContent = '박스 상세';
    dom.probeSummary.innerHTML = '';
    dom.probeJson.textContent = '';
    dom.probeElapsed.textContent = '';
    dom.checksScore.innerHTML = '';
    dom.checksList.innerHTML = '';
    dom.integrityScore.innerHTML = '';
    dom.integrityMeta.innerHTML = '';
    dom.integrityList.innerHTML = '';
    dom.quickMeta.innerHTML = '';
    dom.treeEmpty.hidden = true;
    state.buffer = null;
    state.boxes = [];
    state.selectedBox = null;
    state.fileSize = 0;
    state.containerFormat = 'unknown';
    state.playbackKind = 'video';
    state.playerSrc = null;
    state.probe = null;
    state.integrity = null;
    dom.player.hidden = true;
    dom.imagePlayer.hidden = true;
    if (dom.playerStage) dom.playerStage.dataset.kind = 'idle';
    dom.player.removeAttribute('src');
    dom.imagePlayer.removeAttribute('src');
    updatePlayerChrome();
  }

  /**
   * 로컬 파일 메타데이터로 GIF(이미지) 재생 여부를 추정한다.
   * @param {File} file 사용자가 선택한 파일
   * @returns {'image'|'video'|null} 확실하면 종류, 아니면 null
   */
  function detectPlaybackKindFromFile(file) {
    if (file.type === 'image/gif') return 'image';
    if (/\.gif$/i.test(file.name)) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    if (/\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(file.name)) return 'video';
    return null;
  }

  /**
   * URL 경로 확장자로 GIF(이미지) 재생 여부를 추정한다.
   * @param {string} url 원격 미디어 URL
   * @returns {'image'|'video'|null} 확실하면 종류, 아니면 null
   */
  function detectPlaybackKindFromUrl(url) {
    try {
      const path = new URL(url).pathname;
      if (/\.gif$/i.test(path)) return 'image';
      if (/\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(path)) return 'video';
    } catch (_) { /* ignore */ }
    return null;
  }

  /**
   * ffprobe 결과로 재생기 종류를 판별한다.
   * @param {object} probe ffprobe JSON 결과
   * @returns {'image'|'video'} 재생기 종류
   */
  function detectPlaybackKindFromProbe(probe) {
    const fmt = probe.format || {};
    if (fmt.format_name && String(fmt.format_name).includes('gif')) return 'image';
    const v = pickStream(probe, 'video');
    if (v && v.codec_name === 'gif') return 'image';
    return 'video';
  }

  /**
   * 컨테이너 포맷 문자열을 재생기 종류로 매핑한다.
   * @param {string} format detectContainerFormat/parse 결과 포맷
   * @returns {'image'|'video'|null} 알 수 있으면 종류
   */
  function playbackKindFromFormat(format) {
    if (format === 'gif') return 'image';
    if (format === 'mp4' || format === 'webm') return 'video';
    return null;
  }

  /**
   * 재생 URL과 종류를 저장하고 적절한 재생기 요소에 반영한다.
   * @param {string} src 재생할 URL 또는 object URL
   * @param {'image'|'video'} [kind] 재생기 종류(생략 시 기존 값 유지)
   * @returns {void}
   */
  function setPlayerSrc(src, kind) {
    state.playerSrc = src;
    if (kind) state.playbackKind = kind;
    applyPlayer();
  }

  /**
   * 재생기 종류가 바뀌면 소스를 유지한 채 UI를 전환한다.
   * @param {'image'|'video'} kind 새 재생기 종류
   * @returns {void}
   */
  function reconcilePlaybackKind(kind) {
    if (!kind || kind === state.playbackKind) return;
    state.playbackKind = kind;
    applyPlayer();
  }

  /**
   * state에 따라 <video> 또는 <img> 재생기를 표시한다.
   * @returns {void}
   */
  function applyPlayer() {
    const src = state.playerSrc || '';
    const hasSrc = !!src;
    const isImage = state.playbackKind === 'image';
    if (dom.playerStage) {
      dom.playerStage.dataset.kind = hasSrc ? (isImage ? 'image' : 'video') : 'idle';
    }
    dom.player.hidden = !hasSrc || isImage;
    dom.imagePlayer.hidden = !hasSrc || !isImage;
    if (isImage) {
      dom.player.pause();
      dom.player.removeAttribute('src');
      dom.player.load();
      dom.imagePlayer.src = src;
    } else {
      dom.imagePlayer.removeAttribute('src');
      if (hasSrc) {
        dom.player.src = src;
        dom.player.load();
      } else {
        dom.player.removeAttribute('src');
        dom.player.load();
      }
    }
    updatePlayerChrome();
  }

  /**
   * 재생기 종류에 맞게 패널 제목·배지를 갱신한다.
   * @returns {void}
   */
  function updatePlayerChrome() {
    const isImage = state.playbackKind === 'image';
    const hasSrc = !!state.playerSrc;
    if (dom.playerTitle) dom.playerTitle.textContent = isImage ? 'GIF 미리보기' : '재생';
    if (dom.playerKindBadge) {
      dom.playerKindBadge.hidden = !hasSrc;
      dom.playerKindBadge.textContent = isImage ? 'IMAGE' : 'VIDEO';
      dom.playerKindBadge.className = 'player-kind ' + (isImage ? 'kind-image' : 'kind-video');
    }
  }

  /**
   * File로부터 object URL을 만들고 이전 URL을 해제한다.
   * @param {File} file 대상 파일
   * @returns {string} 생성된 object URL
   */
  function makeObjectUrl(file) {
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(file);
    return state.objectUrl;
  }

  // ------- 바이트 / 박스 파싱 -------

  /**
   * 로컬 파일의 바이트를 읽어(상한 적용) 박스 트리를 파싱·렌더한다.
   * @param {File} file 대상 파일
   * @returns {Promise<void>}
   */
  async function parseBytesFromFile(file) {
    const gen = state.loadGeneration;
    const slice = file.size > MAX_PARSE_BYTES ? file.slice(0, MAX_PARSE_BYTES) : file;
    const buffer = await slice.arrayBuffer();
    if (gen !== state.loadGeneration) return;
    handleBuffer(buffer, file.size > MAX_PARSE_BYTES);
  }

  /**
   * 프록시를 통해 원격 URL의 선두 바이트를 받아 박스 트리를 파싱·렌더한다.
   * @param {string} url 대상 URL
   * @returns {Promise<void>}
   */
  async function parseBytesFromUrl(url) {
    const gen = state.loadGeneration;
    const res = await fetch('/api/proxy?url=' + encodeURIComponent(url), {
      headers: { Range: `bytes=0-${MAX_PARSE_BYTES - 1}` },
    });
    if (!res.ok && res.status !== 206) throw new Error('바이트를 가져오지 못했습니다 (HTTP ' + res.status + ')');
    state.fileSize = parseContentRangeTotal(res.headers.get('content-range'));
    const buffer = await res.arrayBuffer();
    if (gen !== state.loadGeneration) return;
    const partial = res.status === 206 || buffer.byteLength >= MAX_PARSE_BYTES;
    handleBuffer(buffer, partial);
  }

  /**
   * Content-Range 응답 헤더에서 전체 리소스 크기를 추출한다.
   * @param {string|null} header Content-Range 헤더 값
   * @returns {number} 전체 바이트 수(알 수 없으면 0)
   */
  function parseContentRangeTotal(header) {
    if (!header) return 0;
    const m = /\/(\d+)\s*$/.exec(header);
    return m ? parseInt(m[1], 10) : 0;
  }

  /**
   * ArrayBuffer를 파싱하여 컨테이너 포맷별 트리를 렌더하거나 원시 Hex로 폴백한다.
   * @param {ArrayBuffer} buffer 파일(또는 선두 일부) 바이트
   * @param {boolean} partial 일부만 읽었는지 여부(잘림 경고용)
   * @returns {void}
   */
  function handleBuffer(buffer, partial) {
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
      dom.treeEmpty.textContent = '지원 컨테이너: MP4/MOV, GIF, WebM. 이 파일은 원시 Hex로 표시합니다.';
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
    if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
    if (b.length >= 8) {
      const tag = String.fromCharCode(b[4], b[5], b[6], b[7]);
      if (tag === 'ftyp' || tag === 'moov' || tag === 'mdat' || tag === 'styp' || tag === 'free') return 'mp4';
    }
    return 'unknown';
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

  // ------- 박스 트리 렌더링 -------

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
  function setAllTreeCollapsed(collapsed) {
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

  // ------- Hex 덤프 -------

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

  // ------- ffprobe -------

  /**
   * 파일을 서버로 업로드하여 ffprobe 분석을 요청하고 결과를 렌더한다.
   * @param {File} file 분석할 파일
   * @returns {Promise<void>}
   */
  async function probeViaUpload(file) {
    const gen = state.loadGeneration;
    const form = new FormData();
    form.append('video', file);
    const res = await fetch('/api/probe/file', { method: 'POST', body: form });
    const data = await res.json();
    if (gen !== state.loadGeneration) return;
    if (!res.ok) throw new Error(data.detail || data.error || 'ffprobe 실패');
    renderProbe(data.ffprobe, data.integrity);
  }

  /**
   * 서버에 URL ffprobe 분석을 요청하고 결과를 렌더한다.
   * @param {string} url 분석할 URL
   * @returns {Promise<void>}
   */
  async function probeViaUrl(url) {
    const gen = state.loadGeneration;
    const res = await fetch('/api/probe/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (gen !== state.loadGeneration) return;
    if (!res.ok) throw new Error(data.detail || data.error || 'ffprobe 실패');
    renderProbe(data.ffprobe, data.integrity);
  }

  /**
   * ffprobe 결과로 요약 카드, 원본 JSON, 빠른 메타, 점검·무결성 결과를 채운다.
   * @param {object} probe ffprobe JSON 결과
   * @param {object} [integrity] 서버 무결성 검사 결과
   * @returns {void}
   */
  function renderProbe(probe, integrity) {
    state.probe = probe;
    state.integrity = integrity || null;
    reconcilePlaybackKind(detectPlaybackKindFromProbe(probe));
    dom.probeJson.textContent = JSON.stringify(probe, null, 2);
    renderProbeSummary(probe);
    renderQuickMeta(probe);
    renderChecks(probe, state.boxes);
    renderIntegrity(integrity);
  }

  /**
   * 서버 무결성 검사 결과를 미디어 무결성 탭에 렌더한다.
   * @param {object|null|undefined} report 무결성 리포트
   * @returns {void}
   */
  function renderIntegrity(report) {
    if (!dom.integrityList) return;
    if (!report || report.error) {
      dom.integrityScore.innerHTML = '<div class="score-badge"><span class="muted">무결성 검사 실패' +
        (report && report.error ? ': ' + escapeHtml(report.error) : '') + '</span></div>';
      dom.integrityMeta.innerHTML = '';
      dom.integrityList.innerHTML = '';
      return;
    }
    const s = report.summary || {};
    const tone = s.errors ? 'error' : s.warns ? 'warn' : 'ok';
    dom.integrityScore.innerHTML =
      `<div class="score-badge"><span class="ico">${iconFor(tone)}</span>` +
      `<span class="num">${escapeHtml(s.verdict || '—')}</span>` +
      `<span class="muted">오류 ${s.errors || 0} · 경고 ${s.warns || 0} · ${report.elapsed || 0}ms</span></div>`;

    const meta = [];
    if (report.format) meta.push(['컨테이너', String(report.format).toUpperCase()]);
    if (report.decode) {
      meta.push(['디코드', report.decode.success ? '성공' : '실패']);
      if (report.decode.errors && report.decode.errors.length) {
        meta.push(['디코드 오류', report.decode.errors[0]]);
      }
    }
    dom.integrityMeta.innerHTML = meta.map(([k, v]) =>
      `<div class="kv"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(String(v))}</div></div>`).join('');

    dom.integrityList.innerHTML = (report.checks || []).map((c) =>
      `<li class="check ${c.level}"><span class="ico">${iconFor(c.level)}</span>` +
      `<div><div class="ctitle">${escapeHtml(c.title)}</div>` +
      `<div class="cdesc">${c.desc}</div></div></li>`).join('');
  }

  /**
   * ffprobe 결과의 핵심 값을 키-값 카드로 렌더한다.
   * @param {object} probe ffprobe JSON 결과
   * @returns {void}
   */
  function renderProbeSummary(probe) {
    const fmt = probe.format || {};
    const v = pickStream(probe, 'video');
    const a = pickStream(probe, 'audio');
    const cards = [
      ['컨테이너', fmt.format_name || '-'],
      ['전체 길이', fmt.duration ? Number(fmt.duration).toFixed(2) + 's' : '-'],
      ['크기', fmt.size ? fmtBytes(Number(fmt.size)) : '-'],
      ['전체 비트레이트', fmt.bit_rate ? fmtBitrate(fmt.bit_rate) : '-'],
      ['비디오 코덱', v ? `${v.codec_name} (${v.profile || '-'})` : '없음'],
      ['해상도', v ? `${v.width}×${v.height}` : '-'],
      ['픽셀 포맷', v ? (v.pix_fmt || '-') : '-'],
      ['프레임레이트', v ? `${ratio(v.r_frame_rate)} fps` : '-'],
      ['오디오 코덱', a ? `${a.codec_name} (${a.channels || '?'}ch ${a.sample_rate || '?'}Hz)` : '없음'],
    ];
    dom.probeSummary.innerHTML = cards.map(([k, val]) =>
      `<div class="kv"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(String(val))}</div></div>`).join('');
  }

  /**
   * 플레이어 하단에 핵심 메타데이터 칩을 렌더한다.
   * @param {object} probe ffprobe JSON 결과
   * @returns {void}
   */
  function renderQuickMeta(probe) {
    const v = pickStream(probe, 'video');
    const fmt = probe.format || {};
    const chips = [];
    if (state.playbackKind === 'image') {
      chips.push('<span class="chip"><b>GIF</b> 이미지</span>');
    }
    if (v) chips.push(`<span class="chip"><b>${v.codec_name}</b> ${v.width}×${v.height}</span>`);
    if (v && v.r_frame_rate && state.playbackKind !== 'image') {
      chips.push(`<span class="chip">${ratio(v.r_frame_rate)} fps</span>`);
    }
    if (fmt.duration) chips.push(`<span class="chip">${Number(fmt.duration).toFixed(1)}s</span>`);
    if (fmt.format_name) chips.push(`<span class="chip">${escapeHtml(fmt.format_name)}</span>`);
    dom.quickMeta.innerHTML = chips.join('');
  }

  // ------- 트랜스코딩 점검 -------

  /**
   * ffprobe + 박스 구조를 종합해 트랜스코딩 이상 점검 결과를 렌더한다.
   * @param {object} probe ffprobe JSON 결과
   * @param {Array<object>} boxes 박스 트리(최상위)
   * @returns {void}
   */
  function renderChecks(probe, boxes) {
    const checks = analyzeTranscoding(probe, boxes);
    const errors = checks.filter((c) => c.level === 'error').length;
    const warns = checks.filter((c) => c.level === 'warn').length;
    const tone = errors ? 'error' : warns ? 'warn' : 'ok';
    const verdict = errors ? '문제 발견' : warns ? '주의 필요' : '정상';
    dom.checksScore.innerHTML =
      `<div class="score-badge"><span class="ico">${iconFor(tone)}</span>` +
      `<span class="num">${verdict}</span>` +
      `<span class="muted">오류 ${errors} · 경고 ${warns} · 항목 ${checks.length}</span></div>`;
    dom.checksList.innerHTML = checks.map((c) =>
      `<li class="check ${c.level}"><span class="ico">${iconFor(c.level)}</span>` +
      `<div><div class="ctitle">${escapeHtml(c.title)}</div>` +
      `<div class="cdesc">${c.desc}</div></div></li>`).join('');
  }

  /**
   * ffprobe와 박스 정보로 트랜스코딩 적합성 점검 항목 배열을 생성한다.
   * @param {object} probe ffprobe JSON 결과
   * @param {Array<object>} boxes 최상위 박스 배열
   * @returns {Array<{level:string,title:string,desc:string}>} 점검 결과 목록
   */
  function analyzeTranscoding(probe, boxes) {
    const out = [];
    const fmt = probe.format || {};
    const v = pickStream(probe, 'video');
    const a = pickStream(probe, 'audio');

    out.push({ level: 'info', title: '컨테이너 포맷', desc: `<code>${escapeHtml(fmt.format_name || '?')}</code> · 스트림 ${fmt.nb_streams || 0}개` });

    if (!v) {
      out.push({ level: 'error', title: '비디오 스트림 없음', desc: '비디오 트랙이 감지되지 않았습니다. 트랜스코딩 결과가 이미지/오디오 전용일 수 있습니다.' });
    } else {
      checkVideoCodec(v, out);
      checkResolution(v, out);
      checkPixFmt(v, out);
      checkFrameRate(v, out);
      checkFrameCount(v, out);
      checkStartTime(v, out);
      checkCodecTag(v, out);
    }

    if (!a) out.push({ level: 'info', title: '오디오 스트림 없음', desc: '오디오 트랙이 없습니다(무음 영상이면 정상).' });
    else out.push({ level: 'ok', title: '오디오 스트림', desc: `<code>${escapeHtml(a.codec_name)}</code> · ${a.channels || '?'}ch · ${a.sample_rate || '?'}Hz` });

    checkDurationConsistency(fmt, v, out);
    checkFastStart(boxes, fmt, out);
    return out;
  }

  /**
   * 비디오 코덱이 정상 영상 코덱인지(이미지 코덱 오인식 여부) 점검한다.
   * @param {object} v 비디오 스트림 객체
   * @param {Array<object>} out 점검 결과 누적 배열
   * @returns {void}
   */
  function checkVideoCodec(v, out) {
    const good = ['h264', 'hevc', 'vp9', 'vp8', 'av1', 'mpeg4', 'mpeg2video'];
    const imageLike = ['gif', 'mjpeg', 'png', 'bmp', 'webp', 'apng', 'tiff'];
    const isGif = v.codec_name === 'gif' || state.containerFormat === 'gif';
    if (imageLike.includes(v.codec_name)) {
      if (isGif && v.codec_name === 'gif') {
        out.push({ level: 'ok', title: 'GIF 이미지', desc: `코덱 <code>gif</code> · ${v.width || '?'}×${v.height || '?'} — 애니메이션 이미지 형식` });
      } else {
        out.push({ level: 'error', title: '이미지 계열 코덱 감지', desc: `코덱이 <code>${escapeHtml(v.codec_name)}</code> 입니다. 동영상으로 트랜스코딩되지 않고 이미지(예: GIF)로 처리되었을 가능성이 높습니다.` });
      }
    } else if (good.includes(v.codec_name)) {
      out.push({ level: 'ok', title: '비디오 코덱', desc: `<code>${escapeHtml(v.codec_name)}</code> (${escapeHtml(v.profile || '-')}, level ${v.level})` });
    } else {
      out.push({ level: 'warn', title: '비표준/드문 코덱', desc: `<code>${escapeHtml(v.codec_name)}</code> — 재생 호환성을 확인하세요.` });
    }
  }

  /**
   * 해상도가 짝수(H.264/HEVC yuv420p 요구)인지 점검한다.
   * @param {object} v 비디오 스트림 객체
   * @param {Array<object>} out 점검 결과 누적 배열
   * @returns {void}
   */
  function checkResolution(v, out) {
    if (!v.width || !v.height) {
      out.push({ level: 'warn', title: '해상도 불명', desc: '폭/높이를 읽을 수 없습니다.' });
      return;
    }
    if (v.width % 2 !== 0 || v.height % 2 !== 0) {
      out.push({ level: 'error', title: '홀수 해상도', desc: `${v.width}×${v.height} — 다수 코덱(yuv420p)은 짝수 해상도를 요구합니다. 인코딩 오류 가능.` });
    } else {
      out.push({ level: 'ok', title: '해상도', desc: `${v.width}×${v.height} (짝수, 정상)` });
    }
  }

  /**
   * 픽셀 포맷이 범용 호환(yuv420p)인지 점검한다.
   * @param {object} v 비디오 스트림 객체
   * @param {Array<object>} out 점검 결과 누적 배열
   * @returns {void}
   */
  function checkPixFmt(v, out) {
    if (!v.pix_fmt) return;
    if (v.pix_fmt === 'yuv420p') {
      out.push({ level: 'ok', title: '픽셀 포맷', desc: '<code>yuv420p</code> (범용 호환)' });
    } else {
      out.push({ level: 'warn', title: '비호환 가능 픽셀 포맷', desc: `<code>${escapeHtml(v.pix_fmt)}</code> — 일부 브라우저/기기에서 재생이 안 될 수 있습니다(<code>yuv420p</code> 권장).` });
    }
  }

  /**
   * r_frame_rate와 avg_frame_rate를 비교해 VFR(가변 프레임레이트) 여부를 점검한다.
   * @param {object} v 비디오 스트림 객체
   * @param {Array<object>} out 점검 결과 누적 배열
   * @returns {void}
   */
  function checkFrameRate(v, out) {
    const r = evalRatio(v.r_frame_rate);
    const avg = evalRatio(v.avg_frame_rate);
    if (!r || !avg) return;
    const diff = Math.abs(r - avg) / Math.max(r, 1);
    if (diff > 0.1) {
      out.push({ level: 'warn', title: '가변 프레임레이트(VFR) 의심', desc: `r_frame_rate=${r.toFixed(2)} vs avg_frame_rate=${avg.toFixed(2)} — 편집/싱크 문제 유발 가능. CFR로 재인코딩 고려.` });
    } else {
      out.push({ level: 'ok', title: '프레임레이트 일관성', desc: `${avg.toFixed(2)} fps (CFR로 보임)` });
    }
  }

  /**
   * nb_frames와 duration×fps의 정합성을 점검한다.
   * @param {object} v 비디오 스트림 객체
   * @param {Array<object>} out 점검 결과 누적 배열
   * @returns {void}
   */
  function checkFrameCount(v, out) {
    const fps = evalRatio(v.avg_frame_rate) || evalRatio(v.r_frame_rate);
    const dur = Number(v.duration);
    const nb = Number(v.nb_frames);
    if (!fps || !dur || !nb) return;
    const expected = fps * dur;
    const diff = Math.abs(expected - nb) / Math.max(expected, 1);
    if (diff > 0.15) {
      out.push({ level: 'warn', title: '프레임 수 불일치', desc: `실제 ${nb} 프레임 vs 예상 ${expected.toFixed(0)} (duration×fps) — 프레임 드롭/중복 가능.` });
    } else {
      out.push({ level: 'ok', title: '프레임 수', desc: `${nb} 프레임 (예상치와 일치)` });
    }
  }

  /**
   * 비디오 start_time이 0이 아닌지(A/V 싱크 지연 가능) 점검한다.
   * @param {object} v 비디오 스트림 객체
   * @param {Array<object>} out 점검 결과 누적 배열
   * @returns {void}
   */
  function checkStartTime(v, out) {
    const st = Number(v.start_time);
    if (st && Math.abs(st) > 0.1) {
      out.push({ level: 'warn', title: '0이 아닌 시작 시간', desc: `start_time=${st}s — 재생 시작 지연 또는 A/V 싱크 어긋남 가능.` });
    }
  }

  /**
   * 코덱 태그가 비어있는지(컨테이너-코덱 매핑 누락) 점검한다.
   * @param {object} v 비디오 스트림 객체
   * @param {Array<object>} out 점검 결과 누적 배열
   * @returns {void}
   */
  function checkCodecTag(v, out) {
    if (v.codec_tag_string === '[0][0][0][0]' || v.codec_tag === '0x0000') {
      out.push({ level: 'warn', title: '코덱 태그 없음', desc: '컨테이너에 코덱 태그(fourcc)가 비어 있습니다. MP4가 아닌 단순 컨테이너(예: GIF/raw)일 수 있습니다.' });
    }
  }

  /**
   * format과 비디오 스트림의 duration 차이가 큰지 점검한다.
   * @param {object} fmt ffprobe format 객체
   * @param {object|null} v 비디오 스트림 객체
   * @param {Array<object>} out 점검 결과 누적 배열
   * @returns {void}
   */
  function checkDurationConsistency(fmt, v, out) {
    if (!v || !fmt.duration || !v.duration) return;
    const diff = Math.abs(Number(fmt.duration) - Number(v.duration));
    if (diff > 0.5) {
      out.push({ level: 'warn', title: '길이 불일치', desc: `컨테이너 ${Number(fmt.duration).toFixed(2)}s vs 비디오 스트림 ${Number(v.duration).toFixed(2)}s (차이 ${diff.toFixed(2)}s).` });
    }
  }

  /**
   * moov 박스가 mdat보다 앞에 있는지(웹 스트리밍 faststart 최적화) 점검한다.
   * @param {Array<object>} boxes 최상위 박스 배열
   * @param {object} fmt ffprobe format 객체
   * @param {Array<object>} out 점검 결과 누적 배열
   * @returns {void}
   */
  function checkFastStart(boxes, fmt, out) {
    if (!boxes || !boxes.length) return;
    const isMp4 = (fmt.format_name || '').includes('mp4') || boxes.some((b) => b.type === 'ftyp');
    if (!isMp4) return;
    const moovIdx = boxes.findIndex((b) => b.type === 'moov');
    const mdatIdx = boxes.findIndex((b) => b.type === 'mdat');
    if (moovIdx === -1) {
      out.push({ level: 'warn', title: 'moov 미확인', desc: '읽은 범위에서 moov 박스를 찾지 못했습니다(파일 후미에 있거나 일부만 로드됨).' });
    } else if (mdatIdx !== -1 && moovIdx > mdatIdx) {
      out.push({ level: 'warn', title: 'faststart 미적용', desc: 'moov가 mdat 뒤에 있습니다. 웹 점진적 재생이 느려질 수 있어 <code>-movflags +faststart</code> 재먹싱 권장.' });
    } else {
      out.push({ level: 'ok', title: 'faststart 최적화', desc: 'moov가 mdat 앞에 위치합니다(웹 스트리밍에 적합).' });
    }
  }

  // ------- UI 보조 -------

  /**
   * 탭 전환 동작을 설정한다.
   * @returns {void}
   */
  function setupTabs() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });
  }

  /**
   * 드래그&드롭 영역의 이벤트를 설정한다.
   * @returns {void}
   */
  function setupDragAndDrop() {
    const dz = dom.dropzone;
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.add('drag');
    }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.remove('drag');
    }));
    dz.addEventListener('drop', (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) loadLocalFile(file);
    });
    document.body.addEventListener('dragover', (e) => e.preventDefault());
    document.body.addEventListener('drop', (e) => e.preventDefault());
  }

  /**
   * ffprobe 원본 JSON을 클립보드로 복사한다.
   * @returns {void}
   */
  function copyProbeJson() {
    if (!state.probe) return;
    navigator.clipboard.writeText(JSON.stringify(state.probe, null, 2))
      .then(() => { dom.copyProbe.textContent = '복사됨!'; setTimeout(() => { dom.copyProbe.textContent = 'JSON 복사'; }, 1200); })
      .catch(() => {});
  }

  /**
   * 상태 배너 텍스트와 스타일을 설정한다.
   * @param {string} msg 표시할 메시지
   * @param {string} [kind] 'loading' | 'error' 등 스타일 키
   * @returns {void}
   */
  function setStatus(msg, kind) {
    dom.status.hidden = false;
    dom.status.textContent = msg;
    dom.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  /**
   * 분석 완료 시 상태 배너를 잠시 표시 후 숨긴다.
   * @returns {void}
   */
  function finishStatus() {
    setStatus('분석 완료', 'ok');
    setTimeout(() => { dom.status.hidden = true; }, 1500);
  }

  /**
   * 점검 레벨에 맞는 아이콘 문자를 반환한다.
   * @param {string} level 'ok'|'warn'|'error'|'info'
   * @returns {string} 아이콘 문자
   */
  function iconFor(level) {
    return { ok: '✓', warn: '⚠', error: '✕', info: 'ℹ' }[level] || '·';
  }

  /**
   * probe에서 지정한 codec_type의 첫 스트림을 찾는다.
   * @param {object} probe ffprobe JSON 결과
   * @param {string} type 'video'|'audio' 등
   * @returns {object|null} 해당 스트림 또는 null
   */
  function pickStream(probe, type) {
    return (probe.streams || []).find((s) => s.codec_type === type) || null;
  }

  /**
   * "num/den" 비율 문자열을 사람이 읽는 소수로 변환한다.
   * @param {string} r 비율 문자열(예: "30000/1001")
   * @returns {string} 소수 2자리 문자열 또는 '-'
   */
  function ratio(r) {
    const v = evalRatio(r);
    return v ? v.toFixed(2) : '-';
  }

  /**
   * "num/den" 비율 문자열을 실수로 평가한다(0 분모 방지).
   * @param {string} r 비율 문자열
   * @returns {number|null} 평가값 또는 null
   */
  function evalRatio(r) {
    if (!r || typeof r !== 'string' || !r.includes('/')) return null;
    const [n, d] = r.split('/').map(Number);
    if (!d) return null;
    return n / d;
  }

  /**
   * bit/s 값을 사람이 읽는 단위로 변환한다.
   * @param {string|number} bps 초당 비트
   * @returns {string} 예: "1.50 Mbps"
   */
  function fmtBitrate(bps) {
    const n = Number(bps);
    if (n >= 1e6) return (n / 1e6).toFixed(2) + ' Mbps';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + ' kbps';
    return n + ' bps';
  }

  /**
   * 바이트 수를 사람이 읽는 단위로 변환한다.
   * @param {number} n 바이트 수
   * @returns {string} 예: "1.20 MB"
   */
  function fmtBytes(n) {
    if (n == null) return '-';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return (i === 0 ? v : v.toFixed(2)) + ' ' + units[i];
  }

  /**
   * HTML 특수문자를 이스케이프한다.
   * @param {string} s 원본 문자열
   * @returns {string} 이스케이프된 문자열
   */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  document.addEventListener('DOMContentLoaded', init);
})();
