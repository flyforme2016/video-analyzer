/**
 * 공유 상태·DOM 참조·공용 유틸리티.
 * 모든 앱 모듈이 이 모듈의 단일 state/dom 객체를 가져다 쓴다.
 */

export const MAX_PARSE_BYTES = 256 * 1024 * 1024; // 박스 파싱을 위해 읽을 최대 바이트
export const HEX_VIEW_CAP = 4096; // 한 박스에서 hex로 보여줄 최대 바이트

export const state = {
  buffer: null,
  boxes: [],
  selectedBox: null,
  selectedRange: null,
  objectUrl: null,
  fileSize: 0,
  containerFormat: 'unknown',
  playbackKind: 'video',
  playerSrc: null,
  msePlayer: null,
  hlsPlayer: null,
  appliedSrc: null,
  appliedKind: null,
  sourceUrl: null,
  sourceIsLocal: false,
  serverFileId: null,
  loadGeneration: 0,
  probe: null,
  integrity: null,
};

export const dom = {};

/**
 * 자주 쓰는 DOM 요소를 dom 객체에 캐싱한다.
 * @returns {void}
 */
export function cacheDom() {
  const ids = ['dropzone', 'fileInput', 'urlField', 'urlInput', 'urlBtn', 'urlHistoryDropdown',
    'urlHistoryList', 'urlHistoryEmpty', 'libraryUploadInput', 'libraryUploadBtn', 'libraryStatus',
    'libraryStatusText', 'libraryProgress', 'libraryProgressBar', 'libraryProgressLabel',
    'serverFileList', 'serverFileEmpty', 'status', 'player', 'imagePlayer',
    'playerStage', 'playerTitle', 'playerKindBadge', 'playerNotice',
    'sourceLabel', 'quickMeta', 'boxTree', 'treeEmpty', 'detailTitle', 'fieldList',
    'hexDump', 'probeSummary', 'probeJson', 'probeElapsed', 'copyProbe',
    'checksScore', 'checksList', 'containerTreeLabel', 'treeHeadActions',
    'treeExpandAll', 'treeCollapseAll',
    'integrityScore', 'integrityMeta', 'integrityList'];
  ids.forEach((id) => { dom[id] = document.getElementById(id); });
}

/**
 * 상태 배너 텍스트와 스타일을 설정한다.
 * @param {string} msg 표시할 메시지
 * @param {string} [kind] 'loading' | 'error' 등 스타일 키
 * @returns {void}
 */
export function setStatus(msg, kind) {
  dom.status.hidden = false;
  dom.status.textContent = msg;
  dom.status.className = 'status' + (kind ? ' ' + kind : '');
}

/**
 * 분석 완료 시 상태 배너를 잠시 표시 후 숨긴다.
 * @returns {void}
 */
export function finishStatus() {
  setStatus('분석 완료', 'ok');
  setTimeout(() => { dom.status.hidden = true; }, 1500);
}

/**
 * probe에서 지정한 codec_type의 첫 스트림을 찾는다.
 * @param {object} probe ffprobe JSON 결과
 * @param {string} type 'video'|'audio' 등
 * @returns {object|null} 해당 스트림 또는 null
 */
export function pickStream(probe, type) {
  return (probe.streams || []).find((s) => s.codec_type === type) || null;
}

/**
 * 바이트 수를 사람이 읽는 단위로 변환한다.
 * @param {number} n 바이트 수
 * @returns {string} 예: "1.20 MB"
 */
export function fmtBytes(n) {
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
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
