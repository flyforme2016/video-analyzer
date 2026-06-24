'use strict';

const fs = require('fs');
const path = require('path');
const { dailyLogPath } = require('./log-rotate');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
const MAX_STDOUT = Number(process.env.LOG_MAX_STDOUT) || 512 * 1024; // 로그당 stdout 상한

/**
 * ffprobe/ffmpeg 실행 명령과 결과를 도구별 로그 파일에 추가한다.
 * 로깅 실패가 분석을 막지 않도록 모든 오류를 무시한다.
 * @param {'ffprobe'|'ffmpeg'} tool 실행한 도구 종류
 * @param {object} entry 실행 정보
 * @param {string} entry.bin 실행 파일 경로
 * @param {string[]} entry.args 인자 배열
 * @param {number} entry.startedAt 시작 시각(ms epoch)
 * @param {number} entry.elapsedMs 소요 시간(ms)
 * @param {Error|null} [entry.err] execFile 오류(없으면 null)
 * @param {string|Buffer} [entry.stdout] 표준 출력
 * @param {string|Buffer} [entry.stderr] 표준 에러
 * @returns {void}
 */
function logCommand(tool, entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(dailyLogPath(tool), formatEntry(tool, entry));
  } catch (_) { /* 로깅은 절대 분석을 깨뜨리지 않는다 */ }
}

/**
 * 로그 항목 문자열을 구성한다.
 * @param {string} tool 도구 종류
 * @param {object} entry 실행 정보
 * @returns {string} 파일에 추가할 텍스트 블록
 */
function formatEntry(tool, entry) {
  const { bin, args, startedAt, elapsedMs, err } = entry;
  const status = describeStatus(err);
  const lines = [
    '='.repeat(80),
    `[${new Date(startedAt).toISOString()}] ${tool} ${status} · ${elapsedMs}ms`,
    `$ ${formatCommand(bin, args)}`,
  ];
  const stderr = toText(entry.stderr);
  const stdout = toText(entry.stdout);
  if (stderr) lines.push('--- stderr ---', truncate(stderr));
  if (stdout) lines.push('--- stdout ---', truncate(stdout));
  if (err && !stderr) lines.push('--- error ---', String(err.message || err));
  lines.push('', '');
  return lines.join('\n');
}

/**
 * execFile 오류로 실행 상태 문자열을 만든다.
 * @param {Error|null|undefined} err execFile 오류
 * @returns {string} 상태 라벨
 */
function describeStatus(err) {
  if (!err) return 'OK';
  if (err.killed || err.signal === 'SIGTERM') return 'TIMEOUT/KILLED';
  return `FAIL(exit ${err.code != null ? err.code : '?'})`;
}

/**
 * 실행 파일과 인자를 셸에 붙여넣기 가능한 한 줄 명령으로 합친다.
 * @param {string} bin 실행 파일 경로
 * @param {string[]} args 인자 배열
 * @returns {string} 명령 문자열
 */
function formatCommand(bin, args) {
  return [bin, ...(args || [])].map(quoteArg).join(' ');
}

/**
 * 공백·특수문자가 있는 인자를 따옴표로 감싼다.
 * @param {string} arg 인자
 * @returns {string} 인용 처리된 인자
 */
function quoteArg(arg) {
  const s = String(arg);
  return /[\s"'$`\\|&;<>()]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}

/**
 * stdout/stderr 값을 문자열로 정규화한다.
 * @param {string|Buffer|undefined} v 입력 값
 * @returns {string} 트림된 문자열
 */
function toText(v) {
  if (!v) return '';
  return (Buffer.isBuffer(v) ? v.toString() : String(v)).trim();
}

/**
 * 너무 긴 출력을 상한까지 자르고 안내를 덧붙인다.
 * @param {string} text 원본 텍스트
 * @returns {string} 잘린 텍스트
 */
function truncate(text) {
  if (text.length <= MAX_STDOUT) return text;
  return `${text.slice(0, MAX_STDOUT)}\n…(${text.length - MAX_STDOUT} bytes 생략)`;
}

module.exports = { logCommand, LOG_DIR };
