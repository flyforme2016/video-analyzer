/**
 * URL 입력 최근 기록: localStorage 저장, 드롭다운 표시, 항목 삭제.
 */

import { dom, escapeHtml } from './state.js';

const STORAGE_KEY = 'va-recent-urls';
const MAX_RECENT = 10;

/** @type {(url: string) => void} */
let onUrlPick = () => {};

/**
 * URL 최근 기록 UI와 이벤트를 초기화한다.
 * @param {(url: string) => void} onPick 목록 항목 선택 시 호출할 콜백
 * @returns {void}
 */
export function setupUrlHistory(onPick) {
  if (!dom.urlInput || !dom.urlHistoryDropdown) return;
  onUrlPick = onPick;

  dom.urlInput.addEventListener('focus', showUrlHistoryDropdown);
  dom.urlInput.addEventListener('click', showUrlHistoryDropdown);

  dom.urlHistoryList.addEventListener('mousedown', (e) => {
    if (e.target.closest('[data-remove-url]')) e.preventDefault();
  });

  dom.urlHistoryList.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-remove-url]');
    if (removeBtn) {
      handleUrlHistoryRemove(removeBtn.dataset.removeUrl, e);
      return;
    }
    const row = e.target.closest('[data-url]');
    if (row) handleUrlHistorySelect(row.dataset.url);
  });

  document.addEventListener('click', (e) => {
    if (!dom.urlField.contains(e.target)) hideUrlHistoryDropdown();
  });

  dom.urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideUrlHistoryDropdown();
  });
}

/**
 * URL을 최근 기록에 추가한다. 동일 URL은 맨 앞으로 이동하며 최대 10개까지 유지한다.
 * @param {string} url 저장할 URL
 * @returns {void}
 */
export function addRecentUrl(url) {
  const trimmed = url.trim();
  if (!trimmed) return;
  const urls = getRecentUrls().filter((item) => item !== trimmed);
  urls.unshift(trimmed);
  saveRecentUrlsToStorage(urls.slice(0, MAX_RECENT));
  if (!dom.urlHistoryDropdown?.hidden) renderUrlHistoryList();
}

/**
 * 최근 기록에서 URL을 제거한다.
 * @param {string} url 제거할 URL
 * @returns {void}
 */
export function removeRecentUrl(url) {
  const urls = getRecentUrls().filter((item) => item !== url);
  saveRecentUrlsToStorage(urls);
}

/**
 * localStorage에서 최근 URL 목록을 읽는다.
 * @returns {string[]} 최근 URL 배열(최신 순)
 */
export function getRecentUrls() {
  return loadRecentUrlsFromStorage();
}

/**
 * 최근 기록 드롭다운을 표시하고 목록을 갱신한다.
 * @returns {void}
 */
function showUrlHistoryDropdown() {
  renderUrlHistoryList();
  dom.urlHistoryDropdown.hidden = false;
}

/**
 * 최근 기록 드롭다운을 숨긴다.
 * @returns {void}
 */
function hideUrlHistoryDropdown() {
  dom.urlHistoryDropdown.hidden = true;
}

/**
 * 드롭다운 목록 DOM을 최근 기록 데이터로 다시 그린다.
 * @returns {void}
 */
function renderUrlHistoryList() {
  const urls = getRecentUrls();
  dom.urlHistoryEmpty.hidden = urls.length > 0;
  dom.urlHistoryList.innerHTML = urls.map((url) => (
    `<li class="url-history-item">
      <button type="button" class="url-history-pick" data-url="${escapeAttr(url)}" title="${escapeAttr(url)}">${escapeHtml(url)}</button>
      <button type="button" class="url-history-remove" data-remove-url="${escapeAttr(url)}" title="기록에서 제거" aria-label="기록에서 제거">×</button>
    </li>`
  )).join('');
}

/**
 * 최근 기록 항목 클릭 시 입력란에 URL을 넣고 불러온다.
 * @param {string} url 선택한 URL
 * @returns {void}
 */
function handleUrlHistorySelect(url) {
  dom.urlInput.value = url;
  hideUrlHistoryDropdown();
  onUrlPick(url);
}

/**
 * 최근 기록 항목의 × 버튼 클릭을 처리한다.
 * @param {string} url 제거할 URL
 * @param {Event} e 클릭 이벤트
 * @returns {void}
 */
function handleUrlHistoryRemove(url, e) {
  e.preventDefault();
  e.stopPropagation();
  removeRecentUrl(url);
  renderUrlHistoryList();
  dom.urlInput.focus();
}

/**
 * localStorage에서 최근 URL 배열을 파싱해 반환한다.
 * @returns {string[]} URL 배열
 */
function loadRecentUrlsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string' && item.trim()) : [];
  } catch (_) {
    return [];
  }
}

/**
 * 최근 URL 배열을 localStorage에 저장한다.
 * @param {string[]} urls 저장할 URL 배열
 * @returns {void}
 */
function saveRecentUrlsToStorage(urls) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(urls));
  } catch (_) { /* quota 등 무시 */ }
}

/**
 * HTML 속성값에 넣을 문자열을 이스케이프한다.
 * @param {string} s 원본 문자열
 * @returns {string} 이스케이프된 문자열
 */
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, '&#96;');
}
