'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const { ensureLibraryReady } = require('./lib/media-library');
const { createProbeUploader, createLibraryUploader } = require('./lib/upload');
const { handleError } = require('./middleware/error-handler');
const library = require('./routes/library');
const probe = require('./routes/probe');
const proxy = require('./routes/proxy');

/**
 * 라우트와 미들웨어가 모두 등록된 Express 애플리케이션을 생성한다.
 * @returns {import('express').Express} 구성된 Express 앱 인스턴스
 */
function createApp() {
  ensureLibraryReady();
  const app = express();
  const upload = createProbeUploader();
  const libraryUpload = createLibraryUploader();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/library', library.handleList);
  app.post('/api/library', libraryUpload.single('video'), library.handleUpload);
  app.delete('/api/library/:id', library.handleDelete);
  app.get('/api/library/:id/file', library.handleStream);
  app.post('/api/probe/library/:id', probe.handleProbeLibrary);
  app.post('/api/probe/file', upload.single('video'), probe.handleProbeFile);
  app.post('/api/probe/url', probe.handleProbeUrl);
  app.get('/api/proxy', proxy.handleProxy);
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.use(handleError);
  return app;
}

module.exports = { createApp };
