/**
 * 소스 로딩: 로컬 파일/원격 URL을 받아 재생 부착, 바이트 파싱(트리),
 * 서버 분석 요청까지의 흐름을 조율한다.
 */

import { state, dom, MAX_PARSE_BYTES, fmtBytes, setStatus, finishStatus } from './state.js';
import {
  detectPlaybackKindFromFile, detectPlaybackKindFromUrl, setPlayerSrc,
  destroyMsePlayer, setPlayerNotice, updatePlayerChrome, makeObjectUrl,
} from './playback.js';
import { handleBuffer } from './container.js';
import { probeViaUpload, probeViaUrl } from './analysis.js';

/**
 * 로컬 파일을 받아 재생, 바이트 파싱, ffprobe 분석을 수행한다.
 * @param {File} file 사용자가 선택/드롭한 비디오 파일
 * @returns {Promise<void>}
 */
export async function loadLocalFile(file) {
  resetForNewSource(`${file.name} · ${fmtBytes(file.size)}`);
  state.sourceIsLocal = true;
  state.sourceUrl = null;
  const kindHint = detectPlaybackKindFromFile(file) || 'video';
  setPlayerSrc(makeObjectUrl(file), kindHint);
  setStatus('파일 분석·무결성 검사 중… (대용량은 수 분 걸릴 수 있음)', 'loading');
  try {
    state.fileSize = file.size;
    await parseBytesFromFile(file);
    await probeViaUpload(file);
    finishStatus();
  } catch (err) {
    setStatus('분석 중 오류: ' + (err.message || err), 'error');
  }
}

/**
 * 원격 URL을 받아 (프록시 경유) 재생, 바이트 파싱, ffprobe 분석을 수행한다.
 * @param {string} url 분석할 http(s) 비디오 URL
 * @returns {Promise<void>}
 */
export async function loadRemoteUrl(url) {
  resetForNewSource(url);
  state.sourceIsLocal = false;
  state.sourceUrl = url;
  const kindHint = detectPlaybackKindFromUrl(url) || 'video';
  setPlayerSrc('/api/proxy?url=' + encodeURIComponent(url), kindHint);
  setStatus('URL 분석·무결성 검사 중…', 'loading');
  try {
    state.fileSize = 0;
    await parseBytesFromUrl(url);
    await probeViaUrl(url);
    finishStatus();
  } catch (err) {
    setStatus('분석 중 오류: ' + (err.message || err), 'error');
  }
}

/**
 * 새 소스를 불러오기 전에 UI 상태와 패널을 초기화한다.
 * @param {string} label 소스 라벨(파일명/URL)
 * @returns {void}
 */
function resetForNewSource(label) {
  state.loadGeneration += 1;
  dom.sourceLabel.textContent = label;
  dom.boxTree.innerHTML = '';
  dom.fieldList.innerHTML = '';
  dom.hexDump.innerHTML = '';
  dom.detailTitle.textContent = '박스 상세';
  dom.probeSummary.innerHTML = '';
  dom.probeJson.textContent = '';
  dom.probeElapsed.textContent = '';
  dom.checksScore.innerHTML = '';
  dom.checksList.innerHTML = '';
  dom.integrityScore.innerHTML = '';
  dom.integrityMeta.innerHTML = '';
  dom.integrityList.innerHTML = '';
  dom.quickMeta.innerHTML = '';
  dom.treeEmpty.hidden = true;
  state.buffer = null;
  state.boxes = [];
  state.selectedBox = null;
  state.fileSize = 0;
  state.containerFormat = 'unknown';
  state.playbackKind = 'video';
  state.playerSrc = null;
  state.probe = null;
  state.integrity = null;
  destroyMsePlayer();
  state.appliedSrc = null;
  state.appliedKind = null;
  state.sourceUrl = null;
  state.sourceIsLocal = false;
  setPlayerNotice('');
  dom.player.hidden = true;
  dom.imagePlayer.hidden = true;
  if (dom.playerStage) dom.playerStage.dataset.kind = 'idle';
  dom.player.removeAttribute('src');
  dom.imagePlayer.removeAttribute('src');
  updatePlayerChrome();
}

/**
 * 로컬 파일의 바이트를 읽어(상한 적용) 박스 트리를 파싱·렌더한다.
 * @param {File} file 대상 파일
 * @returns {Promise<void>}
 */
async function parseBytesFromFile(file) {
  const gen = state.loadGeneration;
  const slice = file.size > MAX_PARSE_BYTES ? file.slice(0, MAX_PARSE_BYTES) : file;
  const buffer = await slice.arrayBuffer();
  if (gen !== state.loadGeneration) return;
  handleBuffer(buffer, file.size > MAX_PARSE_BYTES);
}

/**
 * 프록시를 통해 원격 URL의 선두 바이트를 받아 박스 트리를 파싱·렌더한다.
 * @param {string} url 대상 URL
 * @returns {Promise<void>}
 */
async function parseBytesFromUrl(url) {
  const gen = state.loadGeneration;
  const res = await fetch('/api/proxy?url=' + encodeURIComponent(url), {
    headers: { Range: `bytes=0-${MAX_PARSE_BYTES - 1}` },
  });
  if (!res.ok && res.status !== 206) throw new Error('바이트를 가져오지 못했습니다 (HTTP ' + res.status + ')');
  state.fileSize = parseContentRangeTotal(res.headers.get('content-range'));
  const buffer = await res.arrayBuffer();
  if (gen !== state.loadGeneration) return;
  const partial = res.status === 206 || buffer.byteLength >= MAX_PARSE_BYTES;
  handleBuffer(buffer, partial);
}

/**
 * Content-Range 응답 헤더에서 전체 리소스 크기를 추출한다.
 * @param {string|null} header Content-Range 헤더 값
 * @returns {number} 전체 바이트 수(알 수 없으면 0)
 */
function parseContentRangeTotal(header) {
  if (!header) return 0;
  const m = /\/(\d+)\s*$/.exec(header);
  return m ? parseInt(m[1], 10) : 0;
}
