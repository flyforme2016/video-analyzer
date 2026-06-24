'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const { execFile } = require('child_process');
const { logCommand } = require('./lib/cmd-logger');
const { startLogMaintenance } = require('./lib/log-rotate');
const http = require('http');
const { URL } = require('url');

const express = require('express');
const cors = require('cors');
const multer = require('multer');

const { analyzeIntegrity } = require('./lib/integrity');
const {
  SsrfError,
  validateUrlSyntax,
  assertUrlAllowed,
  createSafeLookup,
} = require('./lib/ssrf-guard');
const {
  ensureLibraryReady,
  listLibraryFiles,
  addLibraryFile,
  deleteLibraryFile,
  getLibraryFileMeta,
  resolveLibraryFilePath,
  isValidLibraryId,
} = require('./lib/media-library');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1GB
const FFPROBE_TIMEOUT_MS = Number(process.env.FFPROBE_TIMEOUT_MS) || 60 * 1000;
const FFPROBE_HLS_TIMEOUT_MS = Number(process.env.FFPROBE_HLS_TIMEOUT_MS) || 4 * 60 * 1000;
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const SAFE_LOOKUP = createSafeLookup();

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

/**
 * 라우트와 미들웨어가 모두 등록된 Express 애플리케이션을 생성한다.
 * @returns {import('express').Express} 구성된 Express 앱 인스턴스
 */
function createApp() {
  ensureLibraryReady();
  const app = express();
  const upload = createUploader();
  const libraryUpload = createLibraryUploader();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/library', handleLibraryList);
  app.post('/api/library', libraryUpload.single('video'), handleLibraryUpload);
  app.delete('/api/library/:id', handleLibraryDelete);
  app.get('/api/library/:id/file', handleLibraryStream);
  app.post('/api/probe/library/:id', handleProbeLibrary);
  app.post('/api/probe/file', upload.single('video'), handleProbeFile);
  app.post('/api/probe/url', handleProbeUrl);
  app.get('/api/proxy', handleProxy);
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.use(handleError);
  return app;
}

/**
 * 라이브러리에 저장된 파일 목록을 JSON으로 반환한다.
 * @param {import('express').Request} req 요청
 * @param {import('express').Response} res 응답
 * @returns {Promise<void>}
 */
async function handleLibraryList(req, res) {
  try {
    const files = await listLibraryFiles();
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: '목록 조회 실패', detail: String(err.message || err) });
  }
}

/**
 * 업로드된 파일을 서버 라이브러리에 영구 저장한다.
 * @param {import('express').Request} req multipart 업로드(req.file)
 * @param {import('express').Response} res 저장된 파일 메타데이터 JSON
 * @returns {Promise<void>}
 */
async function handleLibraryUpload(req, res) {
  if (!req.file) {
    res.status(400).json({ error: '업로드된 파일이 없습니다. (필드명: video)' });
    return;
  }
  const tempPath = req.file.path;
  try {
    const file = await addLibraryFile(tempPath, req.file.originalname, req.file.size);
    res.status(201).json({ file });
  } catch (err) {
    safeUnlink(tempPath);
    res.status(500).json({ error: '서버 저장 실패', detail: String(err.message || err) });
  }
}

/**
 * 라이브러리 파일을 삭제한다.
 * @param {import('express').Request} req params.id에 파일 ID
 * @param {import('express').Response} res 응답
 * @returns {Promise<void>}
 */
async function handleLibraryDelete(req, res) {
  const id = req.params.id;
  if (!isValidLibraryId(id)) {
    res.status(400).json({ error: '잘못된 파일 ID' });
    return;
  }
  try {
    const removed = await deleteLibraryFile(id);
    if (!removed) {
      res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
      return;
    }
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: '삭제 실패', detail: String(err.message || err) });
  }
}

/**
 * 라이브러리 파일을 Range 요청을 지원하며 스트리밍한다.
 * @param {import('express').Request} req params.id, Range 헤더
 * @param {import('express').Response} res 파일 스트림
 * @returns {Promise<void>}
 */
async function handleLibraryStream(req, res) {
  const id = req.params.id;
  if (!isValidLibraryId(id)) {
    res.status(400).json({ error: '잘못된 파일 ID' });
    return;
  }
  const meta = await getLibraryFileMeta(id);
  const filePath = resolveLibraryFilePath(id);
  if (!meta || !filePath) {
    res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    return;
  }
  streamLocalFile(filePath, meta.name, req.headers.range, res);
}

/**
 * 라이브러리에 저장된 파일을 ffprobe·무결성 분석한다.
 * @param {import('express').Request} req params.id에 파일 ID
 * @param {import('express').Response} res NDJSON 스트림
 * @returns {Promise<void>}
 */
async function handleProbeLibrary(req, res) {
  const id = req.params.id;
  if (!isValidLibraryId(id)) {
    res.status(400).json({ error: '잘못된 파일 ID' });
    return;
  }
  const meta = await getLibraryFileMeta(id);
  const filePath = resolveLibraryFilePath(id);
  if (!meta || !filePath) {
    res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    return;
  }
  try {
    await streamAnalysis(
      res,
      { type: 'library', id: meta.id, name: meta.name, size: meta.size },
      filePath
    );
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: '분석 실행 실패', detail: String(err.message || err) });
    else res.end();
  }
}

/**
 * 업로드된 비디오 파일을 임시 저장한 뒤 ffprobe로 분석한다.
 * @param {import('express').Request} req 업로드 파일(req.file)을 포함한 요청
 * @param {import('express').Response} res ffprobe 결과 JSON을 반환할 응답
 * @returns {Promise<void>}
 */
async function handleProbeFile(req, res) {
  if (!req.file) {
    res.status(400).json({ error: '업로드된 파일이 없습니다. (필드명: video)' });
    return;
  }
  const filePath = req.file.path;
  try {
    await streamAnalysis(res, { type: 'file', name: req.file.originalname, size: req.file.size }, filePath);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: '분석 실행 실패', detail: String(err.message || err) });
    else res.end();
  } finally {
    safeUnlink(filePath);
  }
}

/**
 * 원격 URL의 비디오를 ffprobe로 직접 분석한다.
 * @param {import('express').Request} req body.url에 분석 대상 URL을 포함한 요청
 * @param {import('express').Response} res ffprobe 결과 JSON을 반환할 응답
 * @returns {Promise<void>}
 */
async function handleProbeUrl(req, res) {
  const target = req.body && req.body.url;
  try {
    await assertUrlAllowed(target);
  } catch (err) {
    res.status(err instanceof SsrfError ? 400 : 502).json({ error: String(err.message || err) });
    return;
  }
  try {
    await streamAnalysis(res, { type: 'url', url: target }, target);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: '분석 실행 실패', detail: String(err.message || err) });
    else res.end();
  }
}

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

/**
 * 임시 디렉터리에 업로드를 저장하는 multer 인스턴스를 생성한다.
 * @returns {import('multer').Multer} 구성된 multer 업로더
 */
function createUploader() {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, resolveProbeUploadFilename(file.originalname)),
  });
  return multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES } });
}

/**
 * 로컬 파일 분석용 임시 저장 파일명을 결정한다. 기본은 원본 파일명이며 충돌 시에만 접미사를 붙인다.
 * @param {string} originalName 클라이언트가 보낸 원본 파일명
 * @returns {string} tmpdir 기준 안전한 파일명
 */
function resolveProbeUploadFilename(originalName) {
  const base = sanitizeProbeUploadFilename(originalName);
  const dest = path.join(os.tmpdir(), base);
  if (!fs.existsSync(dest)) return base;
  const ext = path.extname(base);
  const stem = path.basename(base, ext) || 'upload';
  return `${stem}_${Date.now()}${ext}`;
}

/**
 * 업로드 임시 파일명으로 쓸 원본 이름을 정리한다.
 * @param {string} originalName 원본 파일명
 * @returns {string} path.basename 적용·특수문자 제거 후 파일명
 */
function sanitizeProbeUploadFilename(originalName) {
  const base = path.basename(String(originalName || 'upload').replace(/[\0\r\n]/g, ''));
  const cleaned = base.replace(/[<>:"|?*]/g, '_').trim();
  return cleaned || 'upload';
}

function createLibraryUploader() {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `va_lib_${Date.now()}_${Math.random().toString(36).slice(2)}`),
  });
  return multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES } });
}

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

/**
 * 임시 파일을 조용히 삭제한다(실패해도 예외를 던지지 않음).
 * @param {string} filePath 삭제할 파일 경로
 * @returns {void}
 */
function safeUnlink(filePath) {
  fs.unlink(filePath, () => {});
}

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

main();
