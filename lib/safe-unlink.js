'use strict';

const fs = require('fs');

/**
 * 임시 파일을 조용히 삭제한다(실패해도 예외를 던지지 않음).
 * @param {string} filePath 삭제할 파일 경로
 * @returns {void}
 */
function safeUnlink(filePath) {
  fs.unlink(filePath, () => {});
}

module.exports = { safeUnlink };
