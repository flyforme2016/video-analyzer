/**
 * 분석 탭별 로딩 스피너 표시(바이트/박스, ffprobe, 트랜스코딩 점검, 미디어 무결성).
 */

const TAB_KEYS = ['bytes', 'probe', 'checks', 'integrity'];

/**
 * 모든 탭 로딩 표시를 끈다.
 * @returns {void}
 */
export function resetTabProgress() {
  TAB_KEYS.forEach((tab) => setTabLoading(tab, false));
}

/**
 * 분석 시작 시 네 탭 모두 로딩 표시를 켠다.
 * @returns {void}
 */
export function beginTabProgress() {
  TAB_KEYS.forEach((tab) => setTabLoading(tab, true));
}

/**
 * 지정 탭의 로딩 표시를 켜거나 끈다.
 * @param {'bytes'|'probe'|'checks'|'integrity'} tab 탭 키
 * @param {boolean} loading 로딩 중이면 true
 * @returns {void}
 */
export function setTabLoading(tab, loading) {
  const btn = document.querySelector(`.tab[data-tab="${tab}"]`);
  if (!btn) return;
  const spinner = btn.querySelector('.tab-spinner');
  btn.classList.toggle('tab-loading', loading);
  btn.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (spinner) spinner.hidden = !loading;
}

/**
 * 지정 탭의 로딩을 완료 처리한다.
 * @param {'bytes'|'probe'|'checks'|'integrity'} tab 탭 키
 * @returns {void}
 */
export function completeTabProgress(tab) {
  setTabLoading(tab, false);
}

/**
 * 여러 탭의 로딩을 한 번에 완료 처리한다.
 * @param {Array<'bytes'|'probe'|'checks'|'integrity'>} tabs 탭 키 배열
 * @returns {void}
 */
export function completeTabProgressMany(tabs) {
  tabs.forEach((tab) => completeTabProgress(tab));
}
