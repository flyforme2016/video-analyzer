'use strict';

const { execFile } = require('child_process');
const { logCommand } = require('./cmd-logger');
const {
  FFPROBE_BIN,
  FFPROBE_TIMEOUT_MS,
  FFPROBE_HLS_TIMEOUT_MS,
} = require('./config');

/**
 * ffprobe를 실행해 format/stream 정보를 JSON으로 반환한다.
 * @param {string} input 로컬 파일 경로 또는 http(s) URL
 * @returns {Promise<object>} ffprobe의 파싱된 JSON 결과
 * @throws {Error} ffprobe 실행 실패 또는 JSON 파싱 실패 시
 */
function runFfprobe(input) {
  const args = [
    '-v', 'error',
    '-hide_banner',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    '-show_programs',
  ];
  const hls = isHlsInput(input);
  if (hls) args.push('-allowed_extensions', 'ALL');
  args.push(input);
  const timeout = hls ? FFPROBE_HLS_TIMEOUT_MS : FFPROBE_TIMEOUT_MS;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    execFile(FFPROBE_BIN, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      logCommand('ffprobe', { bin: FFPROBE_BIN, args, startedAt, elapsedMs: Date.now() - startedAt, err, stdout, stderr });
      const errText = (stderr && stderr.toString().trim()) || '';
      if (err) {
        const timedOut = err.killed || err.signal === 'SIGTERM';
        reject(new Error(timedOut
          ? `ffprobe 시간 초과(${Math.round(timeout / 1000)}s) — 원격 소스 응답이 느립니다. FFPROBE_HLS_TIMEOUT_MS로 조정 가능`
          : (errText || err.message)));
        return;
      }
      try {
        resolve(JSON.parse(stdout.toString() || '{}'));
      } catch (e) {
        reject(new Error('ffprobe JSON 파싱 실패: ' + e.message + (errText ? ' / ' + errText : '')));
      }
    });
  });
}

/**
 * 입력이 HLS(m3u8) 플레이리스트인지 확장자로 판별한다.
 * @param {string} input 파일 경로 또는 URL
 * @returns {boolean} HLS면 true
 */
function isHlsInput(input) {
  return /\.m3u8(\?|#|$)/i.test(String(input));
}

module.exports = { runFfprobe };
