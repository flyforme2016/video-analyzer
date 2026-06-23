'use strict';

const fs = require('fs');

/**
 * 로컬 m3u8 파일을 읽어 플레이리스트 구조를 검사한다.
 * @param {string} filePath m3u8 파일 경로
 * @returns {Promise<object>} 검사 결과
 */
async function scanHlsFile(filePath) {
  const text = await fs.promises.readFile(filePath, 'utf-8');
  return analyzePlaylist(text);
}

/**
 * m3u8 텍스트를 분석해 마스터/미디어 구조와 정합성 정보를 반환한다.
 * @param {string} text 플레이리스트 텍스트
 * @returns {object} 분석 결과
 */
function analyzePlaylist(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '').trim()).filter((l) => l.length);
  if (!lines.length || !/^\uFEFF?#EXTM3U/.test(lines[0])) {
    return { valid: false };
  }

  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  const version = extractTag(lines, '#EXT-X-VERSION');
  const result = {
    valid: true,
    kind: isMaster ? 'master' : 'media',
    version: version ? Number(version) : null,
  };

  if (isMaster) return Object.assign(result, analyzeMaster(lines));
  return Object.assign(result, analyzeMedia(lines));
}

/**
 * 마스터 플레이리스트의 변형 스트림 정합성을 검사한다.
 * @param {Array<string>} lines 라인 목록
 * @returns {object} 마스터 분석 결과
 */
function analyzeMaster(lines) {
  let variants = 0;
  let missingUri = 0;
  let missingBandwidth = 0;
  let mediaCount = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      variants += 1;
      if (!/BANDWIDTH=\d+/.test(lines[i])) missingBandwidth += 1;
      const uri = lines[i + 1];
      if (!uri || uri.startsWith('#')) missingUri += 1;
    } else if (lines[i].startsWith('#EXT-X-MEDIA:')) {
      mediaCount += 1;
    }
  }
  return { variants, missingUri, missingBandwidth, mediaCount };
}

/**
 * 미디어 플레이리스트의 세그먼트 정합성을 검사한다.
 * @param {Array<string>} lines 라인 목록
 * @returns {object} 미디어 분석 결과
 */
function analyzeMedia(lines) {
  let segments = 0;
  let missingUri = 0;
  let maxDuration = 0;
  let totalDuration = 0;
  const targetDuration = Number(extractTag(lines, '#EXT-X-TARGETDURATION')) || 0;
  let overTarget = 0;
  const hasEndlist = lines.some((l) => l.startsWith('#EXT-X-ENDLIST'));
  const encrypted = lines.some((l) => l.startsWith('#EXT-X-KEY') && !/METHOD=NONE/.test(l));

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('#EXTINF')) {
      segments += 1;
      const dur = parseFloat((lines[i].split(':')[1] || '').replace(',', '')) || 0;
      maxDuration = Math.max(maxDuration, dur);
      totalDuration += dur;
      if (targetDuration && dur > targetDuration + 0.5) overTarget += 1;
      const uri = lines[i + 1];
      if (!uri || uri.startsWith('#')) missingUri += 1;
    }
  }
  return {
    segments, missingUri, maxDuration, totalDuration,
    targetDuration, overTarget, hasEndlist, encrypted,
  };
}

/**
 * 특정 태그의 값을 추출한다.
 * @param {Array<string>} lines 라인 목록
 * @param {string} tag 태그 접두(예: #EXT-X-VERSION)
 * @returns {string|null} 태그 값
 */
function extractTag(lines, tag) {
  const line = lines.find((l) => l.startsWith(tag + ':'));
  return line ? line.slice(tag.length + 1).trim() : null;
}

module.exports = { scanHlsFile, analyzePlaylist };
