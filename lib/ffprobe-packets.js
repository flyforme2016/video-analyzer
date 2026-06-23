'use strict';

const { execFile } = require('child_process');
const { logCommand } = require('./cmd-logger');

/**
 * ffprobe 패킷 정보로 비디오 샘플 오프셋 목록을 추출한다.
 * @param {string} input 파일 경로 또는 URL
 * @param {string} ffprobePath ffprobe 실행 경로
 * @returns {Promise<{lengthSize:number,samples:Array<object>}|null>} 샘플 인덱스
 */
function extractPacketsViaFfprobe(input, ffprobePath) {
  const args = [
    '-v', 'quiet',
    '-show_packets',
    '-select_streams', 'v:0',
    '-print_format', 'json',
    input,
  ];
  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile(ffprobePath, args, { timeout: 120000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      logCommand('ffprobe', { bin: ffprobePath, args, startedAt, elapsedMs: Date.now() - startedAt, err, stdout, stderr });
      if (err) { resolve(null); return; }
      try {
        const json = JSON.parse(stdout.toString() || '{}');
        const packets = json.packets || [];
        if (!packets.length) { resolve(null); return; }
        const samples = packets.map((p, i) => ({
          index: i + 1,
          offset: Number(p.pos),
          size: Number(p.size),
          keyframe: (p.flags || '').includes('K'),
        })).filter((s) => s.offset >= 0 && s.size > 0);
        resolve(samples.length ? { lengthSize: 4, samples } : null);
      } catch (e) {
        resolve(null);
      }
    });
  });
}

module.exports = { extractPacketsViaFfprobe };
