'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { SsrfError, validateUrlSyntax } = require('../lib/ssrf-guard');
const { SAFE_LOOKUP } = require('../lib/config');

/**
 * CORS/Range 제약을 우회하기 위해 원격 미디어를 스트리밍 프록시한다.
 * 브라우저 측 박스 파싱과 <video> 재생에 사용된다.
 * @param {import('express').Request} req query.url에 대상 URL을 포함한 요청 (Range 헤더 전달)
 * @param {import('express').Response} res 원격 응답을 그대로 중계할 응답
 * @returns {void}
 */
function handleProxy(req, res) {
  const target = req.query.url;
  try {
    validateUrlSyntax(target);
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
    return;
  }
  forwardRemote(target, req.headers.range, res, 0);
}

/**
 * 원격 URL 요청을 수행하고 응답을 클라이언트로 중계한다. 리다이렉트를 따라간다.
 * @param {string} target 원격 미디어 URL
 * @param {string|undefined} range 클라이언트가 보낸 Range 헤더(없으면 undefined)
 * @param {import('express').Response} res 데이터를 중계할 Express 응답
 * @param {number} depth 현재 리다이렉트 추적 깊이
 * @returns {void}
 */
function forwardRemote(target, range, res, depth) {
  if (depth > 5) {
    res.status(508).json({ error: '리다이렉트가 너무 많습니다.' });
    return;
  }
  let parsed;
  try {
    parsed = validateUrlSyntax(target);
  } catch (err) {
    if (!res.headersSent) res.status(400).json({ error: String(err.message || err) });
    return;
  }
  const client = parsed.protocol === 'https:' ? https : http;
  const headers = {};
  if (range) headers.Range = range;

  const upstream = client.get(target, { headers, lookup: SAFE_LOOKUP }, (up) => {
    const status = up.statusCode || 502;
    if ([301, 302, 303, 307, 308].includes(status) && up.headers.location) {
      const next = new URL(up.headers.location, target).toString();
      up.resume();
      forwardRemote(next, range, res, depth + 1);
      return;
    }
    res.status(status);
    copyHeader(up, res, 'content-type');
    copyHeader(up, res, 'content-length');
    copyHeader(up, res, 'content-range');
    copyHeader(up, res, 'accept-ranges');
    up.pipe(res);
  });
  upstream.on('error', (err) => {
    if (res.headersSent) return;
    if (err instanceof SsrfError) res.status(400).json({ error: String(err.message || err) });
    else res.status(502).json({ error: '원격 요청 실패', detail: String(err.message || err) });
  });
}

/**
 * 업스트림 응답의 특정 헤더를 클라이언트 응답으로 복사한다.
 * @param {import('http').IncomingMessage} from 업스트림 응답
 * @param {import('express').Response} to 클라이언트 응답
 * @param {string} name 복사할 헤더 이름(소문자)
 * @returns {void}
 */
function copyHeader(from, to, name) {
  const v = from.headers[name];
  if (v !== undefined) to.setHeader(name, v);
}

module.exports = { handleProxy };
