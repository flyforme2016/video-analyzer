'use strict';

const path = require('path');
const fs = require('fs');

/**
 * 로컬 파일을 Range 지원으로 클라이언트에 스트리밍한다.
 * @param {string} filePath 파일 절대 경로
 * @param {string} displayName Content-Disposition용 표시 이름
 * @param {string|undefined} range Range 요청 헤더
 * @param {import('express').Response} res Express 응답
 * @returns {void}
 */
function streamLocalFile(filePath, displayName, range, res) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    return;
  }
  const contentType = guessMediaContentType(displayName);
  res.setHeader('Accept-Ranges', 'bytes');
  if (contentType) res.setHeader('Content-Type', contentType);

  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/i.exec(String(range));
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (start >= stat.size || end < start) {
        res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
        res.end();
        return;
      }
      const chunkEnd = Math.min(end, stat.size - 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${chunkEnd}/${stat.size}`);
      res.setHeader('Content-Length', String(chunkEnd - start + 1));
      fs.createReadStream(filePath, { start, end: chunkEnd }).pipe(res);
      return;
    }
  }

  res.setHeader('Content-Length', String(stat.size));
  fs.createReadStream(filePath).pipe(res);
}

/**
 * 파일명 확장자로 미디어 Content-Type을 추정한다.
 * @param {string} name 파일명
 * @returns {string|undefined} MIME 타입(알 수 없으면 undefined)
 */
function guessMediaContentType(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  const map = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.flv': 'video/x-flv',
    '.f4v': 'video/x-flv',
    '.ts': 'video/mp2t',
    '.m2ts': 'video/mp2t',
    '.mts': 'video/mp2t',
    '.gif': 'image/gif',
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.m3u': 'application/vnd.apple.mpegurl',
  };
  return map[ext];
}

module.exports = { streamLocalFile };
