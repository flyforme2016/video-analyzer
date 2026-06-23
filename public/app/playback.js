/**
 * 재생기 제어: 포맷→재생 종류 판별, <video>/<img> 전환,
 * flv.js / hls.js / mpegts.js(MSE) 부착 및 정리.
 */

import { state, dom, pickStream } from './state.js';

/**
 * 로컬 파일 메타데이터로 GIF(이미지) 재생 여부를 추정한다.
 * @param {File} file 사용자가 선택한 파일
 * @returns {'image'|'video'|null} 확실하면 종류, 아니면 null
 */
export function detectPlaybackKindFromFile(file) {
  if (file.type === 'image/gif') return 'image';
  if (/\.gif$/i.test(file.name)) return 'image';
  if (/\.(flv|f4v)$/i.test(file.name)) return 'flv';
  if (/\.m3u8$/i.test(file.name)) return 'hls';
  if (/\.(ts|m2ts|mts)$/i.test(file.name)) return 'ts';
  if (file.type.startsWith('video/')) return 'video';
  if (/\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(file.name)) return 'video';
  return null;
}

/**
 * URL 경로 확장자로 GIF(이미지) 재생 여부를 추정한다.
 * @param {string} url 원격 미디어 URL
 * @returns {'image'|'video'|null} 확실하면 종류, 아니면 null
 */
export function detectPlaybackKindFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    if (/\.gif$/i.test(path)) return 'image';
    if (/\.(flv|f4v)$/i.test(path)) return 'flv';
    if (/\.m3u8$/i.test(path)) return 'hls';
    if (/\.(ts|m2ts|mts)$/i.test(path)) return 'ts';
    if (/\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(path)) return 'video';
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * ffprobe 결과로 재생기 종류를 판별한다.
 * @param {object} probe ffprobe JSON 결과
 * @returns {'image'|'video'} 재생기 종류
 */
export function detectPlaybackKindFromProbe(probe) {
  const fmt = probe.format || {};
  const name = String(fmt.format_name || '');
  if (name.includes('gif')) return 'image';
  if (name.includes('flv')) return 'flv';
  if (name.includes('hls') || name.includes('applehttp')) return 'hls';
  if (name.includes('mpegts')) return 'ts';
  const v = pickStream(probe, 'video');
  if (v && v.codec_name === 'gif') return 'image';
  return 'video';
}

/**
 * 컨테이너 포맷 문자열을 재생기 종류로 매핑한다.
 * @param {string} format detectContainerFormat/parse 결과 포맷
 * @returns {'image'|'video'|null} 알 수 있으면 종류
 */
export function playbackKindFromFormat(format) {
  if (format === 'gif') return 'image';
  if (format === 'flv') return 'flv';
  if (format === 'hls') return 'hls';
  if (format === 'ts') return 'ts';
  if (format === 'mp4' || format === 'webm') return 'video';
  return null;
}

/**
 * 재생 URL과 종류를 저장하고 적절한 재생기 요소에 반영한다.
 * @param {string} src 재생할 URL 또는 object URL
 * @param {'image'|'video'} [kind] 재생기 종류(생략 시 기존 값 유지)
 * @returns {void}
 */
export function setPlayerSrc(src, kind) {
  state.playerSrc = src;
  if (kind) state.playbackKind = kind;
  applyPlayer();
}

/**
 * 재생기 종류가 바뀌면 소스를 유지한 채 UI를 전환한다.
 * @param {'image'|'video'} kind 새 재생기 종류
 * @returns {void}
 */
export function reconcilePlaybackKind(kind) {
  if (!kind || kind === state.playbackKind) return;
  state.playbackKind = kind;
  applyPlayer();
}

/**
 * state에 따라 <video> 또는 <img> 재생기를 표시한다.
 * @returns {void}
 */
function applyPlayer() {
  const src = state.playerSrc || '';
  const hasSrc = !!src;
  const kind = state.playbackKind;
  const isImage = kind === 'image';
  if (dom.playerStage) dom.playerStage.dataset.kind = hasSrc ? kind : 'idle';
  dom.player.hidden = !hasSrc || isImage;
  dom.imagePlayer.hidden = !hasSrc || !isImage;

  if (state.appliedSrc === src && state.appliedKind === kind) {
    updatePlayerChrome();
    return;
  }
  state.appliedSrc = src;
  state.appliedKind = kind;
  destroyMsePlayer();
  setPlayerNotice('');

  if (isImage) {
    dom.player.pause();
    dom.player.removeAttribute('src');
    dom.player.load();
    dom.imagePlayer.src = src;
  } else {
    dom.imagePlayer.removeAttribute('src');
    if (!hasSrc) {
      dom.player.removeAttribute('src');
      dom.player.load();
    } else if (kind === 'flv') {
      attachFlvPlayer(src);
    } else if (kind === 'ts') {
      attachTsPlayer(src);
    } else if (kind === 'hls') {
      attachHlsPlayer();
    } else {
      dom.player.src = src;
      dom.player.load();
    }
  }
  updatePlayerChrome();
}

/**
 * mpegts.js(MSE)로 MPEG-TS 소스를 <video> 요소에 부착한다.
 * @param {string} src TS object URL 또는 프록시 URL
 * @returns {void}
 */
function attachTsPlayer(src) {
  if (!window.mpegts || !window.mpegts.isSupported()) {
    dom.player.removeAttribute('src');
    dom.player.load();
    setPlayerNotice('이 브라우저는 MPEG-TS 재생(MSE)을 지원하지 않습니다. 분석 결과만 확인하세요.');
    return;
  }
  try {
    const player = window.mpegts.createPlayer(
      { type: 'mpegts', isLive: false, url: src },
      { enableWorker: true, seekType: 'range' },
    );
    player.on(window.mpegts.Events.ERROR, (type, detail) => {
      setPlayerNotice(`TS 재생 오류: ${type} / ${detail}`);
    });
    player.attachMediaElement(dom.player);
    player.load();
    state.msePlayer = player;
  } catch (e) {
    setPlayerNotice('TS 재생 초기화 실패: ' + (e.message || e));
  }
}

/**
 * hls.js(또는 네이티브 HLS)로 m3u8 소스를 <video>에 부착한다.
 * 로컬 업로드 m3u8은 세그먼트 파일이 없어 재생할 수 없다.
 * @returns {void}
 */
function attachHlsPlayer() {
  if (state.sourceIsLocal || !state.sourceUrl) {
    dom.player.removeAttribute('src');
    dom.player.load();
    setPlayerNotice('로컬 m3u8은 세그먼트 파일이 없어 재생할 수 없습니다. 플레이리스트 구조 분석만 제공합니다.');
    return;
  }
  const url = state.sourceUrl;
  if (window.Hls && window.Hls.isSupported()) {
    try {
      const hls = new window.Hls();
      hls.on(window.Hls.Events.ERROR, (event, data) => {
        if (data && data.fatal) setPlayerNotice(`HLS 재생 오류: ${data.type} / ${data.details}`);
      });
      hls.loadSource(url);
      hls.attachMedia(dom.player);
      state.hlsPlayer = hls;
    } catch (e) {
      setPlayerNotice('HLS 재생 초기화 실패: ' + (e.message || e));
    }
    return;
  }
  if (dom.player.canPlayType('application/vnd.apple.mpegurl')) {
    dom.player.src = url;
    dom.player.load();
    return;
  }
  setPlayerNotice('이 브라우저는 HLS 재생을 지원하지 않습니다. 플레이리스트 분석만 확인하세요.');
}

/**
 * flv.js(MSE)로 FLV 소스를 <video> 요소에 부착한다.
 * @param {string} src FLV object URL 또는 프록시 URL
 * @returns {void}
 */
function attachFlvPlayer(src) {
  if (!window.flvjs || !window.flvjs.isSupported()) {
    dom.player.removeAttribute('src');
    dom.player.load();
    setPlayerNotice('이 브라우저는 FLV 재생(MSE)을 지원하지 않습니다. 분석 결과만 확인하세요.');
    return;
  }
  try {
    const player = window.flvjs.createPlayer({ type: 'flv', url: src });
    player.on(window.flvjs.Events.ERROR, (type, detail) => {
      setPlayerNotice(`FLV 재생 오류: ${type} / ${detail}`);
    });
    player.attachMediaElement(dom.player);
    player.load();
    state.msePlayer = player;
  } catch (e) {
    setPlayerNotice('FLV 재생 초기화 실패: ' + (e.message || e));
  }
}

/**
 * 활성화된 MSE 플레이어(flv.js 등)를 정리한다.
 * @returns {void}
 */
export function destroyMsePlayer() {
  if (state.msePlayer) {
    try { state.msePlayer.destroy(); } catch (_) { /* ignore */ }
    state.msePlayer = null;
  }
  if (state.hlsPlayer) {
    try { state.hlsPlayer.destroy(); } catch (_) { /* ignore */ }
    state.hlsPlayer = null;
  }
}

/**
 * 재생 영역 위 안내 문구를 표시하거나 숨긴다.
 * @param {string} message 표시할 메시지(빈 문자열이면 숨김)
 * @returns {void}
 */
export function setPlayerNotice(message) {
  if (!dom.playerNotice) return;
  dom.playerNotice.textContent = message || '';
  dom.playerNotice.hidden = !message;
}

/**
 * 재생기 종류에 맞게 패널 제목·배지를 갱신한다.
 * @returns {void}
 */
export function updatePlayerChrome() {
  const kind = state.playbackKind;
  const hasSrc = !!state.playerSrc;
  const titles = { image: 'GIF 미리보기', flv: 'FLV 재생', hls: 'HLS 재생', ts: 'MPEG-TS 재생', video: '재생' };
  const badges = { image: 'IMAGE', flv: 'FLV', hls: 'HLS', ts: 'TS', video: 'VIDEO' };
  const badgeClasses = { image: 'image', flv: 'flv', hls: 'hls', ts: 'ts', video: 'video' };
  if (dom.playerTitle) dom.playerTitle.textContent = titles[kind] || '재생';
  if (dom.playerKindBadge) {
    dom.playerKindBadge.hidden = !hasSrc;
    dom.playerKindBadge.textContent = badges[kind] || 'VIDEO';
    dom.playerKindBadge.className = 'player-kind kind-' + (badgeClasses[kind] || 'video');
  }
}

/**
 * File로부터 object URL을 만들고 이전 URL을 해제한다.
 * @param {File} file 대상 파일
 * @returns {string} 생성된 object URL
 */
export function makeObjectUrl(file) {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(file);
  return state.objectUrl;
}
