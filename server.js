'use strict';

const { startLogMaintenance } = require('./lib/log-rotate');
const { PORT, HOST, FFPROBE_BIN, FFMPEG_BIN } = require('./lib/config');
const { createApp } = require('./app');

/**
 * 애플리케이션 엔트리 포인트. 서버를 시작한다.
 * @returns {void}
 */
function main() {
  startLogMaintenance();
  startServer(createApp(), PORT);
}

/**
 * Express 서버를 지정 호스트/포트에서 시작한다.
 * @param {import('express').Express} app 구성된 Express 앱
 * @param {number} port 바인딩할 포트
 * @returns {void}
 */
function startServer(app, port) {
  const server = app.listen(port, HOST);
  server.on('listening', () => {
    const localUrl = `http://localhost:${port}`;
    // eslint-disable-next-line no-console
    console.log(`video-analyzer running: ${localUrl} (bind ${HOST}:${port})`);
    console.log(`ffprobe: ${FFPROBE_BIN}`);
    console.log(`ffmpeg: ${FFMPEG_BIN}`);
  });
  server.on('error', (err) => {
    console.error('서버 시작 실패:', err.message || err);
    process.exit(1);
  });
}

main();
