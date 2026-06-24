/**
 * 미디어 무결성 검사 진행률 UI (상태 배너 프로그레스 바 재사용).
 * 각 단계(format/structure/nal/decode)마다 바가 0→100%로 채워진다.
 */

import { dom } from './state.js';

/** 단계 키 → 짧은 단계명 */
const PHASE_SHORT = {
  format: '형식 판별',
  structure: '구조·인덱스',
  nal: 'NAL 검사',
  decode: '전체 디코드',
  done: '완료',
};

/**
 * 무결성 검사 진행률을 상태 배너에 표시한다.
 * @param {string} label 단계 설명 문구
 * @param {number} phasePct 현재 단계 내 진행률 0–100 (-1이면 불확정)
 * @param {string} [detail] 보조 문구(경과 시간 등)
 * @param {string} [phase] 단계 키
 * @returns {void}
 */
export function showIntegrityProgress(label, phasePct, detail, phase) {
  if (!dom.status) return;
  dom.status.hidden = false;
  dom.status.className = 'status loading';
  const phaseName = phase ? PHASE_SHORT[phase] : '';
  if (dom.statusText) {
    dom.statusText.textContent = label || '미디어 무결성 검사 중…';
  }
  const indeterminate = phasePct == null || phasePct < 0;
  if (dom.statusProgress) {
    dom.statusProgress.hidden = false;
    dom.statusProgress.classList.toggle('indeterminate', indeterminate);
  }
  if (dom.statusProgressBar) {
    dom.statusProgressBar.style.width = indeterminate ? '0%' : `${Math.min(100, Math.max(0, phasePct))}%`;
  }
  if (dom.statusProgressLabel) {
    const parts = [];
    if (phaseName) parts.push(`[${phaseName}]`);
    if (!indeterminate) parts.push(`${phasePct}%`);
    if (detail) parts.push(detail);
    dom.statusProgressLabel.textContent = parts.length
      ? parts.join(' · ')
      : (indeterminate ? '진행률 계산 중…' : '');
  }
}

/**
 * 무결성 검사 진행률 UI를 숨긴다.
 * @returns {void}
 */
export function hideIntegrityProgress() {
  if (dom.statusProgress) {
    dom.statusProgress.hidden = true;
    dom.statusProgress.classList.remove('indeterminate');
  }
  if (dom.statusProgressBar) dom.statusProgressBar.style.width = '0%';
  if (dom.statusProgressLabel) dom.statusProgressLabel.textContent = '';
}
