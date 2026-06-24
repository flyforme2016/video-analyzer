/**
 * 앱 진입점: DOM 캐싱, 탭/드롭존/스플리터/트리 토글 등 UI 이벤트 바인딩.
 */

import { dom, cacheDom } from './state.js';
import { loadLocalFile, loadRemoteUrl, loadServerFile } from './loader.js';
import { setAllTreeCollapsed } from './container.js';
import { copyProbeJson } from './analysis.js';
import { setupUrlHistory, addRecentUrl } from './url-history.js';
import { setupServerLibrary } from './server-library.js';

/**
 * URL 입력값을 최근 기록에 남기고 원격 분석을 시작한다.
 * @param {string} url 분석할 URL
 * @returns {void}
 */
function submitRemoteUrl(url) {
  const trimmed = url.trim();
  if (!trimmed) return;
  addRecentUrl(trimmed);
  loadRemoteUrl(trimmed);
}

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
  dom.urlBtn.addEventListener('click', () => submitRemoteUrl(dom.urlInput.value));
  dom.urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dom.urlBtn.click();
  });
  setupUrlHistory(submitRemoteUrl);
  setupServerLibrary(loadServerFile);
  dom.copyProbe.addEventListener('click', copyProbeJson);
  setupBytesSplitter();
  setupTreeCollapse();
}

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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
