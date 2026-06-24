'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const multer = require('multer');
const { MAX_UPLOAD_BYTES } = require('./config');

/**
 * 임시 디렉터리에 업로드를 저장하는 multer 인스턴스를 생성한다.
 * @returns {import('multer').Multer} 구성된 multer 업로더
 */
function createProbeUploader() {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, resolveProbeUploadFilename(file.originalname)),
  });
  return multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES } });
}

/**
 * 라이브러리 업로드용 multer 인스턴스를 생성한다.
 * @returns {import('multer').Multer} 구성된 multer 업로더
 */
function createLibraryUploader() {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `va_lib_${Date.now()}_${Math.random().toString(36).slice(2)}`),
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

module.exports = { createProbeUploader, createLibraryUploader };
