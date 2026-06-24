'use strict';

const { analyzeIntegrity } = require('./integrity');
const { FFPROBE_BIN, FFMPEG_BIN } = require('./config');
const { runFfprobe } = require('./ffprobe-run');

/**
 * ffprobe와 무결성 검사를 독립적으로 실행하고 완료되는 즉시 NDJSON 한 줄씩 흘려보낸다.
 * 느린 무결성 검사가 빠른 ffprobe 결과 전달을 막지 않도록 분리한다.
 * @param {import('express').Response} res Express 응답(스트리밍)
 * @param {object} source 소스 메타데이터
 * @param {string} input 로컬 경로 또는 http(s) URL
 * @returns {Promise<void>}
 */
async function streamAnalysis(res, source, input) {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  writeNdjson(res, { stage: 'source', source });

  const probeJob = runFfprobe(input)
    .then((ffprobe) => writeNdjson(res, { stage: 'probe', ffprobe, ffprobeError: null }))
    .catch((e) => writeNdjson(res, { stage: 'probe', ffprobe: null, ffprobeError: String(e.message || e) }));
  const integrityJob = analyzeIntegrity(input, FFPROBE_BIN, FFMPEG_BIN)
    .then((integrity) => writeNdjson(res, { stage: 'integrity', integrity }))
    .catch((e) => writeNdjson(res, { stage: 'integrity', integrity: { error: String(e.message || e) } }));

  await Promise.allSettled([probeJob, integrityJob]);
  res.end();
}

/**
 * 객체를 NDJSON 한 줄로 직렬화해 전송한다(연결이 끝났으면 무시).
 * @param {import('express').Response} res Express 응답
 * @param {object} obj 전송할 객체
 * @returns {void}
 */
function writeNdjson(res, obj) {
  if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n');
}

module.exports = { streamAnalysis };
