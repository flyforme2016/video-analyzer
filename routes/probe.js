'use strict';

const { SsrfError, assertUrlAllowed } = require('../lib/ssrf-guard');
const {
  getLibraryFileMeta,
  resolveLibraryFilePath,
  isValidLibraryId,
} = require('../lib/media-library');
const { streamAnalysis } = require('../lib/analysis-stream');
const { safeUnlink } = require('../lib/safe-unlink');

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

module.exports = { handleProbeLibrary, handleProbeFile, handleProbeUrl };
