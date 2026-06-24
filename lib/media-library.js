'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
const MANIFEST_PATH = path.join(UPLOADS_DIR, 'manifest.json');
const ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

/**
 * 업로드 저장소 디렉터리와 manifest를 준비한다.
 * @returns {void}
 */
function ensureLibraryReady() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(MANIFEST_PATH)) {
    writeManifest({ files: [] });
  }
}

/**
 * 저장된 미디어 파일 목록을 반환한다. 디스크에 없는 항목은 manifest에서 정리한다.
 * @returns {Promise<Array<{id:string, name:string, size:number, uploadedAt:string}>>}
 */
async function listLibraryFiles() {
  const manifest = await readManifest();
  const kept = [];
  let changed = false;
  for (const entry of manifest.files) {
    if (!isValidId(entry.id) || !entry.name) {
      changed = true;
      continue;
    }
    const filePath = resolveLibraryFilePath(entry.id);
    if (!filePath || !fs.existsSync(filePath)) {
      changed = true;
      continue;
    }
    const stat = fs.statSync(filePath);
    if (entry.size !== stat.size) {
      entry.size = stat.size;
      changed = true;
    }
    kept.push({
      id: entry.id,
      name: entry.name,
      size: entry.size,
      uploadedAt: entry.uploadedAt || new Date(stat.mtimeMs).toISOString(),
    });
  }
  if (changed) await writeManifest({ files: kept });
  kept.sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  return kept;
}

/**
 * 업로드된 임시 파일을 라이브러리에 영구 등록한다.
 * @param {string} tempPath multer가 저장한 임시 파일 경로
 * @param {string} originalName 원본 파일명
 * @param {number} size 바이트 크기
 * @returns {Promise<{id:string, name:string, size:number, uploadedAt:string}>}
 */
async function addLibraryFile(tempPath, originalName, size) {
  const id = createLibraryId();
  const destPath = path.join(UPLOADS_DIR, id);
  await fs.promises.rename(tempPath, destPath);
  const entry = {
    id,
    name: sanitizeDisplayName(originalName),
    size,
    uploadedAt: new Date().toISOString(),
  };
  const manifest = await readManifest();
  manifest.files.unshift(entry);
  await writeManifest(manifest);
  return entry;
}

/**
 * 라이브러리 항목을 삭제한다.
 * @param {string} id 파일 ID
 * @returns {Promise<boolean>} 삭제 성공 시 true, 없으면 false
 * @throws {Error} 잘못된 ID 형식
 */
async function deleteLibraryFile(id) {
  if (!isValidId(id)) throw new Error('잘못된 파일 ID');
  const filePath = resolveLibraryFilePath(id);
  if (!filePath) throw new Error('잘못된 파일 ID');

  const manifest = await readManifest();
  const next = manifest.files.filter((f) => f.id !== id);
  if (next.length === manifest.files.length) return false;

  await writeManifest({ files: next });
  if (fs.existsSync(filePath)) await fs.promises.unlink(filePath);
  return true;
}

/**
 * ID에 해당하는 라이브러리 파일 메타데이터를 반환한다.
 * @param {string} id 파일 ID
 * @returns {Promise<{id:string, name:string, size:number, uploadedAt:string}|null>}
 */
async function getLibraryFileMeta(id) {
  if (!isValidId(id)) return null;
  const manifest = await readManifest();
  const entry = manifest.files.find((f) => f.id === id);
  if (!entry) return null;
  const filePath = resolveLibraryFilePath(id);
  if (!filePath || !fs.existsSync(filePath)) return null;
  return {
    id: entry.id,
    name: entry.name,
    size: entry.size,
    uploadedAt: entry.uploadedAt,
  };
}

/**
 * 라이브러리 파일의 절대 경로를 반환한다. path traversal을 차단한다.
 * @param {string} id 파일 ID
 * @returns {string|null} 안전한 절대 경로 또는 null
 */
function resolveLibraryFilePath(id) {
  if (!isValidId(id)) return null;
  const filePath = path.resolve(UPLOADS_DIR, id);
  const base = path.resolve(UPLOADS_DIR);
  if (!filePath.startsWith(base + path.sep) && filePath !== base) return null;
  return filePath;
}

/**
 * 라이브러리 업로드 저장 디렉터리 경로를 반환한다.
 * @returns {string} uploads 디렉터리 절대 경로
 */
function getUploadsDir() {
  return UPLOADS_DIR;
}

/**
 * manifest.json을 읽어 파싱한다.
 * @returns {Promise<{files:Array<object>}>}
 */
async function readManifest() {
  ensureLibraryReady();
  try {
    const raw = await fs.promises.readFile(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.files)) return { files: [] };
    return parsed;
  } catch (_) {
    return { files: [] };
  }
}

/**
 * manifest.json을 원자적으로 갱신한다.
 * @param {{files:Array<object>}} manifest 저장할 manifest 객체
 * @returns {Promise<void>}
 */
async function writeManifest(manifest) {
  ensureLibraryReady();
  const tmp = `${MANIFEST_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  await fs.promises.rename(tmp, MANIFEST_PATH);
}

/**
 * 라이브러리 파일 ID를 생성한다.
 * @returns {string} 고유 ID
 */
function createLibraryId() {
  return `f_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * 표시용 원본 파일명을 정리한다.
 * @param {string} name 원본 파일명
 * @returns {string} 정리된 파일명
 */
function sanitizeDisplayName(name) {
  const base = path.basename(String(name || 'upload').replace(/[\0\r\n]/g, ''));
  return base || 'upload';
}

/**
 * 라이브러리 ID 형식이 유효한지 검사한다.
 * @param {string} id 검사할 ID
 * @returns {boolean} 유효하면 true
 */
function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

module.exports = {
  ensureLibraryReady,
  listLibraryFiles,
  addLibraryFile,
  deleteLibraryFile,
  getLibraryFileMeta,
  resolveLibraryFilePath,
  getUploadsDir,
  isValidLibraryId: isValidId,
};
