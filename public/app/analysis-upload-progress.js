/**
 * 로컬 파일 분석 업로드(/api/probe/file) 진행률 UI.
 */

import { dom, fmtBytes } from './state.js';

/**
 * 분석용 파일 업로드 진행률을 상태 배너에 표시한다.
 * @param {string} fileName 파일명
 * @param {number} loaded 전송된 바이트
 * @param {number} total 전체 바이트(0이면 불명)
 * @param {boolean} computable total이 신뢰 가능한지
 * @returns {void}
 */
export function showAnalysisUploadProgress(fileName, loaded, total, computable) {
  if (!dom.status) return;
  dom.status.hidden = false;
  dom.status.className = 'status loading';
  if (dom.statusText) {
    dom.statusText.textContent = `"${fileName}" 서버로 전송 중…`;
  }
  if (dom.statusProgress) {
    dom.statusProgress.hidden = false;
    dom.statusProgress.classList.toggle('indeterminate', !computable);
  }
  if (dom.statusProgressBar) {
    const pct = computable && total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    dom.statusProgressBar.style.width = `${pct}%`;
  }
  if (dom.statusProgressLabel) {
    if (computable && total > 0) {
      const pct = Math.min(100, Math.round((loaded / total) * 100));
      dom.statusProgressLabel.textContent = `${pct}% · ${fmtBytes(loaded)} / ${fmtBytes(total)}`;
    } else {
      dom.statusProgressLabel.textContent = `${fmtBytes(loaded)} 전송됨`;
    }
  }
}

/**
 * 분석용 업로드 진행률 UI를 숨긴다.
 * @returns {void}
 */
export function hideAnalysisUploadProgress() {
  if (dom.statusProgress) {
    dom.statusProgress.hidden = true;
    dom.statusProgress.classList.remove('indeterminate');
  }
  if (dom.statusProgressBar) dom.statusProgressBar.style.width = '0%';
  if (dom.statusProgressLabel) dom.statusProgressLabel.textContent = '';
}
