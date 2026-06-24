'use strict';

const {
  listLibraryFiles,
  addLibraryFile,
  deleteLibraryFile,
  getLibraryFileMeta,
  resolveLibraryFilePath,
  isValidLibraryId,
} = require('../lib/media-library');
const { streamLocalFile } = require('../lib/stream-local');
const { safeUnlink } = require('../lib/safe-unlink');

/**
 * 라이브러리에 저장된 파일 목록을 JSON으로 반환한다.
 * @param {import('express').Request} req 요청
 * @param {import('express').Response} res 응답
 * @returns {Promise<void>}
 */
async function handleList(req, res) {
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
async function handleUpload(req, res) {
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
async function handleDelete(req, res) {
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
async function handleStream(req, res) {
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

module.exports = { handleList, handleUpload, handleDelete, handleStream };
