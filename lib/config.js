'use strict';

const { createSafeLookup } = require('./ssrf-guard');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1GB
const FFPROBE_TIMEOUT_MS = Number(process.env.FFPROBE_TIMEOUT_MS) || 60 * 1000;
const FFPROBE_HLS_TIMEOUT_MS = Number(process.env.FFPROBE_HLS_TIMEOUT_MS) || 4 * 60 * 1000;
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const SAFE_LOOKUP = createSafeLookup();

module.exports = {
  PORT,
  HOST,
  MAX_UPLOAD_BYTES,
  FFPROBE_TIMEOUT_MS,
  FFPROBE_HLS_TIMEOUT_MS,
  FFPROBE_BIN,
  FFMPEG_BIN,
  SAFE_LOOKUP,
};
