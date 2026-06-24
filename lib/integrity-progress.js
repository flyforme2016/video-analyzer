'use strict';

const THROTTLE_MS = 400;

/**
 * 무결성 검사 진행률을 현재 단계 기준 0–100%로 throttle하여 콜백으로 전달한다.
 * @param {(payload: {phase:string, phasePct:number, label:string, detail:string}) => void} [onProgress] 진행 콜백
 * @returns {{report: function(string, number, string, string=): void}} 리포터
 */
function createIntegrityProgressReporter(onProgress) {
  let lastAt = 0;
  let lastKey = '';

  /**
   * 단계 내 진행 비율(0–1)을 해당 단계의 0–100%로 보고한다.
   * @param {string} phase format|structure|nal|decode|done
   * @param {number} fraction 단계 내 0–1
   * @param {string} label 상태 문구
   * @param {string} [detail] 보조 문구
   * @returns {void}
   */
  function report(phase, fraction, label, detail) {
    if (!onProgress) return;
    const frac = Math.max(0, Math.min(1, fraction));
    const phasePct = phase === 'done' ? 100 : Math.round(frac * 100);
    const key = `${phase}:${phasePct}:${detail || ''}`;
    const now = Date.now();
    if (key === lastKey && now - lastAt < THROTTLE_MS) return;
    if (now - lastAt < THROTTLE_MS && phasePct < 100) return;
    lastAt = now;
    lastKey = key;
    onProgress({ phase, phasePct, label, detail: detail || '' });
  }

  return { report };
}

module.exports = { createIntegrityProgressReporter };
