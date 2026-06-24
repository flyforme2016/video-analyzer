'use strict';

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
  const code = err && err.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
  res.status(code).json({ error: '서버 오류', detail: String((err && err.message) || err) });
}

module.exports = { handleError };
