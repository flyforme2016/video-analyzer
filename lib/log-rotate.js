'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
const RETENTION_DAYS = Math.max(1, Number(process.env.LOG_RETENTION_DAYS) || 7);
const DAILY_LOG_RE = /^(ffprobe|ffmpeg)-(\d{4}-\d{2}-\d{2})\.log$/;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** @type {ReturnType<typeof setTimeout>|null} */
let midnightTimer = null;

/**
 * 로그 유지보수를 시작한다. 기동 시 만료 로그 삭제 후 매일 KST 자정에 다시 정리한다.
 * @returns {void}
 */
function startLogMaintenance() {
  purgeExpiredLogs();
  scheduleMidnightPurge();
}

/**
 * 도구별 당일(KST) 로그 파일 경로를 반환한다.
 * @param {'ffprobe'|'ffmpeg'|string} tool 도구 이름
 * @param {Date} [date] 기준 시각(기본: 현재)
 * @returns {string} 절대 경로
 */
function dailyLogPath(tool, date = new Date()) {
  return path.join(LOG_DIR, `${tool}-${formatDateKey(date)}.log`);
}

/**
 * 보관 기간을 넘긴 일별 로그 파일을 삭제한다.
 * @returns {number} 삭제한 파일 수
 */
function purgeExpiredLogs() {
  let removed = 0;
  try {
    if (!fs.existsSync(LOG_DIR)) return 0;
    const cutoffMs = kstDayStartMs(new Date()) - RETENTION_DAYS * DAY_MS;
    for (const name of fs.readdirSync(LOG_DIR)) {
      const m = DAILY_LOG_RE.exec(name);
      if (!m) continue;
      const fileDayMs = parseDateKey(m[2]);
      if (fileDayMs == null || fileDayMs >= cutoffMs) continue;
      try {
        fs.unlinkSync(path.join(LOG_DIR, name));
        removed += 1;
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
  return removed;
}

/**
 * 다음 KST 자정에 만료 로그 정리를 예약한다. 정리 후 다시 예약해 매일 반복한다.
 * @returns {void}
 */
function scheduleMidnightPurge() {
  if (midnightTimer) clearTimeout(midnightTimer);
  const delay = msUntilNextKstMidnight();
  midnightTimer = setTimeout(() => {
    purgeExpiredLogs();
    scheduleMidnightPurge();
  }, delay);
  if (typeof midnightTimer.unref === 'function') midnightTimer.unref();
}

/**
 * 현재 시각부터 다음 KST 자정까지 남은 밀리초를 반환한다.
 * @returns {number} 대기 시간(ms)
 */
function msUntilNextKstMidnight() {
  const now = Date.now();
  const next = kstDayStartMs(new Date()) + DAY_MS;
  return Math.max(1000, next - now);
}

/**
 * 시각을 KST 기준 YYYY-MM-DD 문자열로 포맷한다.
 * @param {Date} date 기준 시각
 * @returns {string} 날짜 키
 */
function formatDateKey(date) {
  const { year, month, day } = toKstParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * YYYY-MM-DD(KST 달력 날짜)를 해당일 KST 00:00의 epoch ms로 파싱한다.
 * @param {string} key 날짜 키
 * @returns {number|null} KST 자정 epoch ms 또는 null
 */
function parseDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - KST_OFFSET_MS;
  const check = toKstParts(new Date(ms));
  if (check.year !== year || check.month !== month || check.day !== day) return null;
  return ms;
}

/**
 * 시각이 속한 KST 달력 날짜의 00:00 epoch ms를 반환한다.
 * @param {Date} date 기준 시각
 * @returns {number} KST 자정 epoch ms
 */
function kstDayStartMs(date) {
  const { year, month, day } = toKstParts(date);
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0) - KST_OFFSET_MS;
}

/**
 * Date를 KST 달력 연·월·일로 변환한다.
 * @param {Date} date 기준 시각
 * @returns {{year:number, month:number, day:number}} KST 날짜 구성요소
 */
function toKstParts(date) {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  return {
    year: kst.getUTCFullYear(),
    month: kst.getUTCMonth() + 1,
    day: kst.getUTCDate(),
  };
}

module.exports = {
  LOG_DIR,
  RETENTION_DAYS,
  startLogMaintenance,
  dailyLogPath,
  purgeExpiredLogs,
  msUntilNextKstMidnight,
};
