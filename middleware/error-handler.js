'use strict';

const { MAX_UPLOAD_BYTES } = require('../lib/config');

/**
 * 처리되지 않은 라우트 오류를 JSON으로 응답하는 Express 에러 핸들러.
 * @param {Error} err 발생한 오류
 * @param {import('express').Request} req 요청
 * @param {import('express').Response} res 응답
 * @param {import('express').NextFunction} next 다음 미들웨어
 * @returns {void}
 */
function handleError(err, req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    const limitGb = (MAX_UPLOAD_BYTES / (1024 * 1024 * 1024)).toFixed(0);
    res.status(413).json({
      error: '파일이 너무 큽니다',
      detail: `업로드 한도는 ${limitGb}GB입니다. 더 작은 파일을 사용하세요.`,
    });
    return;
  }
  res.status(500).json({ error: '서버 오류', detail: String((err && err.message) || err) });
}

module.exports = { handleError };
