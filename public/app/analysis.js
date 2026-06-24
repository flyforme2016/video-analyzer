/**
 * 서버 분석 결과 소비: NDJSON 스트림 수신 → ffprobe 요약/원본 JSON/빠른 메타,
 * 트랜스코딩 점검, 미디어 무결성 렌더.
 */

import { state, dom, escapeHtml, fmtBytes, pickStream, setStatus } from './state.js';
import { reconcilePlaybackKind, detectPlaybackKindFromProbe } from './playback.js';

/**
 * 파일을 서버로 업로드하여 ffprobe 분석을 요청하고 결과를 렌더한다.
 * @param {File} file 분석할 파일
 * @returns {Promise<void>}
 */
export async function probeViaUpload(file) {
  const gen = state.loadGeneration;
  const form = new FormData();
  form.append('video', file);
  const res = await fetch('/api/probe/file', { method: 'POST', body: form });
  await consumeAnalysisStream(res, gen);
}

/**
 * 서버에 URL ffprobe 분석을 요청하고 결과를 렌더한다.
 * @param {string} url 분석할 URL
 * @returns {Promise<void>}
 */
export async function probeViaUrl(url) {
  const gen = state.loadGeneration;
  const res = await fetch('/api/probe/url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  await consumeAnalysisStream(res, gen);
}

/**
 * 서버 라이브러리에 저장된 파일의 ffprobe 분석을 요청한다.
 * @param {string} id 서버 파일 ID
 * @returns {Promise<void>}
 */
export async function probeViaLibrary(id) {
  const gen = state.loadGeneration;
  const res = await fetch(`/api/probe/library/${encodeURIComponent(id)}`, { method: 'POST' });
  await consumeAnalysisStream(res, gen);
}

/**
 * NDJSON 분석 스트림을 읽어 단계(ffprobe/무결성)별로 도착 즉시 렌더한다.
 * ffprobe가 먼저 끝나면 트랜스코딩 점검까지 바로 표시되고, 무결성은 도착할 때 갱신된다.
 * @param {Response} res 스트리밍 본문을 가진 fetch 응답
 * @param {number} gen 요청 시점의 loadGeneration(경합 방지)
 * @returns {Promise<void>}
 * @throws {Error} 스트림 시작 전 서버가 오류 응답을 준 경우
 */
async function consumeAnalysisStream(res, gen) {
  if (!res.body) {
    let data = {};
    try { data = await res.json(); } catch (_) { /* ignore */ }
    throw new Error(data.detail || data.error || '분석 실패');
  }
  if (gen === state.loadGeneration) setIntegrityLoading();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line && gen === state.loadGeneration) handleAnalysisMessage(JSON.parse(line));
    }
  }
  const tail = buf.trim();
  if (tail && gen === state.loadGeneration) handleAnalysisMessage(JSON.parse(tail));
}

/**
 * 스트림에서 받은 단계별 메시지를 해당 렌더러로 분배한다.
 * @param {{stage:string, ffprobe?:object, ffprobeError?:string, integrity?:object}} msg 스트림 메시지
 * @returns {void}
 */
function handleAnalysisMessage(msg) {
  if (msg.stage === 'probe') {
    renderProbeResult(msg.ffprobe, msg.ffprobeError);
    setStatus('ffprobe 완료 · 미디어 무결성 검사 중…', 'loading');
  } else if (msg.stage === 'integrity') {
    renderIntegrity(msg.integrity);
  }
}

/**
 * 무결성 탭에 "검사 중" 로딩 표시를 채운다.
 * @returns {void}
 */
function setIntegrityLoading() {
  if (!dom.integrityScore) return;
  dom.integrityScore.innerHTML =
    '<div class="score-badge"><span class="muted">미디어 무결성 검사 중… (대용량은 수 분 걸릴 수 있음)</span></div>';
  dom.integrityMeta.innerHTML = '';
  dom.integrityList.innerHTML = '';
}

/**
 * ffprobe 결과로 요약 카드, 원본 JSON, 빠른 메타, 트랜스코딩 점검을 채운다.
 * ffprobe가 실패(probe=null)해도 무결성·재생은 유지한다.
 * @param {object|null} probe ffprobe JSON 결과(실패 시 null)
 * @param {string} [probeError] ffprobe 실패 사유
 * @returns {void}
 */
function renderProbeResult(probe, probeError) {
  state.probe = probe;
  if (probe) {
    reconcilePlaybackKind(detectPlaybackKindFromProbe(probe));
    dom.probeJson.textContent = JSON.stringify(probe, null, 2);
    renderProbeSummary(probe);
    renderQuickMeta(probe);
    renderChecks(probe, state.boxes);
  } else {
    renderProbeError(probeError);
  }
}

/**
 * ffprobe 실패 시 ffprobe·트랜스코딩 점검 탭에 사유를 표시한다.
 * @param {string} [probeError] ffprobe 실패 사유
 * @returns {void}
 */
function renderProbeError(probeError) {
  const msg = probeError || 'ffprobe 분석에 실패했습니다.';
  dom.probeJson.textContent = msg;
  dom.probeSummary.innerHTML =
    `<div class="kv"><div class="k">ffprobe</div><div class="v">${escapeHtml(msg)}</div></div>`;
  dom.checksScore.innerHTML =
    `<div class="score-badge"><span class="muted">ffprobe 실패로 트랜스코딩 점검을 건너뜀</span></div>`;
  dom.checksList.innerHTML = '';
}

/**
 * 서버 무결성 검사 결과를 미디어 무결성 탭에 렌더한다.
 * @param {object|null|undefined} report 무결성 리포트
 * @returns {void}
 */
function renderIntegrity(report) {
  if (!dom.integrityList) return;
  state.integrity = report || null;
  if (!report || report.error) {
    dom.integrityScore.innerHTML = '<div class="score-badge"><span class="muted">무결성 검사 실패' +
      (report && report.error ? ': ' + escapeHtml(report.error) : '') + '</span></div>';
    dom.integrityMeta.innerHTML = '';
    dom.integrityList.innerHTML = '';
    return;
  }
  const s = report.summary || {};
  const tone = s.errors ? 'error' : s.warns ? 'warn' : 'ok';
  dom.integrityScore.innerHTML =
    `<div class="score-badge"><span class="ico">${iconFor(tone)}</span>` +
    `<span class="num">${escapeHtml(s.verdict || '—')}</span>` +
    `<span class="muted">오류 ${s.errors || 0} · 경고 ${s.warns || 0} · ${report.elapsed || 0}ms</span></div>`;

  const meta = [];
  if (report.format) meta.push(['컨테이너', String(report.format).toUpperCase()]);
  if (report.decode) {
    meta.push(['디코드', report.decode.success ? '성공' : '실패']);
    if (report.decode.errors && report.decode.errors.length) {
      meta.push(['디코드 오류', report.decode.errors[0]]);
    }
  }
  dom.integrityMeta.innerHTML = meta.map(([k, v]) =>
    `<div class="kv"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(String(v))}</div></div>`).join('');

  dom.integrityList.innerHTML = (report.checks || []).map((c) =>
    `<li class="check ${c.level}"><span class="ico">${iconFor(c.level)}</span>` +
    `<div><div class="ctitle">${escapeHtml(c.title)}</div>` +
    `<div class="cdesc">${c.desc}</div></div></li>`).join('');
}

/**
 * ffprobe 결과의 핵심 값을 키-값 카드로 렌더한다.
 * @param {object} probe ffprobe JSON 결과
 * @returns {void}
 */
function renderProbeSummary(probe) {
  const fmt = probe.format || {};
  const v = pickStream(probe, 'video');
  const a = pickStream(probe, 'audio');
  const cards = [
    ['컨테이너', fmt.format_name || '-'],
    ['전체 길이', fmt.duration ? Number(fmt.duration).toFixed(2) + 's' : '-'],
    ['크기', fmt.size ? fmtBytes(Number(fmt.size)) : '-'],
    ['전체 비트레이트', fmt.bit_rate ? fmtBitrate(fmt.bit_rate) : '-'],
    ['비디오 코덱', v ? `${v.codec_name} (${v.profile || '-'})` : '없음'],
    ['해상도', v ? `${v.width}×${v.height}` : '-'],
    ['픽셀 포맷', v ? (v.pix_fmt || '-') : '-'],
    ['프레임레이트', v ? `${ratio(v.r_frame_rate)} fps` : '-'],
    ['오디오 코덱', a ? `${a.codec_name} (${a.channels || '?'}ch ${a.sample_rate || '?'}Hz)` : '없음'],
  ];
  dom.probeSummary.innerHTML = cards.map(([k, val]) =>
    `<div class="kv"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(String(val))}</div></div>`).join('');
}

/**
 * 플레이어 하단에 핵심 메타데이터 칩을 렌더한다.
 * @param {object} probe ffprobe JSON 결과
 * @returns {void}
 */
function renderQuickMeta(probe) {
  const v = pickStream(probe, 'video');
  const fmt = probe.format || {};
  const chips = [];
  if (state.playbackKind === 'image') {
    chips.push('<span class="chip"><b>GIF</b> 이미지</span>');
  }
  if (v) chips.push(`<span class="chip"><b>${v.codec_name}</b> ${v.width}×${v.height}</span>`);
  if (v && v.r_frame_rate && state.playbackKind !== 'image') {
    chips.push(`<span class="chip">${ratio(v.r_frame_rate)} fps</span>`);
  }
  if (fmt.duration) chips.push(`<span class="chip">${Number(fmt.duration).toFixed(1)}s</span>`);
  if (fmt.format_name) chips.push(`<span class="chip">${escapeHtml(fmt.format_name)}</span>`);
  dom.quickMeta.innerHTML = chips.join('');
}

/**
 * ffprobe + 박스 구조를 종합해 트랜스코딩 이상 점검 결과를 렌더한다.
 * @param {object} probe ffprobe JSON 결과
 * @param {Array<object>} boxes 박스 트리(최상위)
 * @returns {void}
 */
function renderChecks(probe, boxes) {
  const checks = analyzeTranscoding(probe, boxes);
  const errors = checks.filter((c) => c.level === 'error').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  const tone = errors ? 'error' : warns ? 'warn' : 'ok';
  const verdict = errors ? '문제 발견' : warns ? '주의 필요' : '정상';
  dom.checksScore.innerHTML =
    `<div class="score-badge"><span class="ico">${iconFor(tone)}</span>` +
    `<span class="num">${verdict}</span>` +
    `<span class="muted">오류 ${errors} · 경고 ${warns} · 항목 ${checks.length}</span></div>`;
  dom.checksList.innerHTML = checks.map((c) =>
    `<li class="check ${c.level}"><span class="ico">${iconFor(c.level)}</span>` +
    `<div><div class="ctitle">${escapeHtml(c.title)}</div>` +
    `<div class="cdesc">${c.desc}</div></div></li>`).join('');
}

/**
 * ffprobe와 박스 정보로 트랜스코딩 적합성 점검 항목 배열을 생성한다.
 * @param {object} probe ffprobe JSON 결과
 * @param {Array<object>} boxes 최상위 박스 배열
 * @returns {Array<{level:string,title:string,desc:string}>} 점검 결과 목록
 */
function analyzeTranscoding(probe, boxes) {
  const out = [];
  const fmt = probe.format || {};
  const v = pickStream(probe, 'video');
  const a = pickStream(probe, 'audio');

  out.push({ level: 'info', title: '컨테이너 포맷', desc: `<code>${escapeHtml(fmt.format_name || '?')}</code> · 스트림 ${fmt.nb_streams || 0}개` });

  if (!v) {
    out.push({ level: 'error', title: '비디오 스트림 없음', desc: '비디오 트랙이 감지되지 않았습니다. 트랜스코딩 결과가 이미지/오디오 전용일 수 있습니다.' });
  } else {
    checkVideoCodec(v, out);
    checkResolution(v, out);
    checkPixFmt(v, out);
    checkFrameRate(v, out);
    checkFrameCount(v, out);
    checkStartTime(v, out);
    checkCodecTag(v, out);
  }

  if (!a) out.push({ level: 'info', title: '오디오 스트림 없음', desc: '오디오 트랙이 없습니다(무음 영상이면 정상).' });
  else out.push({ level: 'ok', title: '오디오 스트림', desc: `<code>${escapeHtml(a.codec_name)}</code> · ${a.channels || '?'}ch · ${a.sample_rate || '?'}Hz` });

  checkDurationConsistency(fmt, v, out);
  checkFastStart(boxes, fmt, out);
  return out;
}

/**
 * 비디오 코덱이 정상 영상 코덱인지(이미지 코덱 오인식 여부) 점검한다.
 * @param {object} v 비디오 스트림 객체
 * @param {Array<object>} out 점검 결과 누적 배열
 * @returns {void}
 */
function checkVideoCodec(v, out) {
  const good = ['h264', 'hevc', 'vp9', 'vp8', 'av1', 'mpeg4', 'mpeg2video'];
  const imageLike = ['gif', 'mjpeg', 'png', 'bmp', 'webp', 'apng', 'tiff'];
  const isGif = v.codec_name === 'gif' || state.containerFormat === 'gif';
  if (imageLike.includes(v.codec_name)) {
    if (isGif && v.codec_name === 'gif') {
      out.push({ level: 'ok', title: 'GIF 이미지', desc: `코덱 <code>gif</code> · ${v.width || '?'}×${v.height || '?'} — 애니메이션 이미지 형식` });
    } else {
      out.push({ level: 'error', title: '이미지 계열 코덱 감지', desc: `코덱이 <code>${escapeHtml(v.codec_name)}</code> 입니다. 동영상으로 트랜스코딩되지 않고 이미지(예: GIF)로 처리되었을 가능성이 높습니다.` });
    }
  } else if (good.includes(v.codec_name)) {
    out.push({ level: 'ok', title: '비디오 코덱', desc: `<code>${escapeHtml(v.codec_name)}</code> (${escapeHtml(v.profile || '-')}, level ${v.level})` });
  } else {
    out.push({ level: 'warn', title: '비표준/드문 코덱', desc: `<code>${escapeHtml(v.codec_name)}</code> — 재생 호환성을 확인하세요.` });
  }
}

/**
 * 해상도가 짝수(H.264/HEVC yuv420p 요구)인지 점검한다.
 * @param {object} v 비디오 스트림 객체
 * @param {Array<object>} out 점검 결과 누적 배열
 * @returns {void}
 */
function checkResolution(v, out) {
  if (!v.width || !v.height) {
    out.push({ level: 'warn', title: '해상도 불명', desc: '폭/높이를 읽을 수 없습니다.' });
    return;
  }
  if (v.width % 2 !== 0 || v.height % 2 !== 0) {
    out.push({ level: 'error', title: '홀수 해상도', desc: `${v.width}×${v.height} — 다수 코덱(yuv420p)은 짝수 해상도를 요구합니다. 인코딩 오류 가능.` });
  } else {
    out.push({ level: 'ok', title: '해상도', desc: `${v.width}×${v.height} (짝수, 정상)` });
  }
}

/**
 * 픽셀 포맷이 범용 호환(yuv420p)인지 점검한다.
 * @param {object} v 비디오 스트림 객체
 * @param {Array<object>} out 점검 결과 누적 배열
 * @returns {void}
 */
function checkPixFmt(v, out) {
  if (!v.pix_fmt) return;
  if (v.pix_fmt === 'yuv420p') {
    out.push({ level: 'ok', title: '픽셀 포맷', desc: '<code>yuv420p</code> (범용 호환)' });
  } else {
    out.push({ level: 'warn', title: '비호환 가능 픽셀 포맷', desc: `<code>${escapeHtml(v.pix_fmt)}</code> — 일부 브라우저/기기에서 재생이 안 될 수 있습니다(<code>yuv420p</code> 권장).` });
  }
}

/**
 * r_frame_rate와 avg_frame_rate를 비교해 VFR(가변 프레임레이트) 여부를 점검한다.
 * @param {object} v 비디오 스트림 객체
 * @param {Array<object>} out 점검 결과 누적 배열
 * @returns {void}
 */
function checkFrameRate(v, out) {
  const r = evalRatio(v.r_frame_rate);
  const avg = evalRatio(v.avg_frame_rate);
  if (!r || !avg) return;
  const diff = Math.abs(r - avg) / Math.max(r, 1);
  if (diff > 0.1) {
    out.push({ level: 'warn', title: '가변 프레임레이트(VFR) 의심', desc: `r_frame_rate=${r.toFixed(2)} vs avg_frame_rate=${avg.toFixed(2)} — 편집/싱크 문제 유발 가능. CFR로 재인코딩 고려.` });
  } else {
    out.push({ level: 'ok', title: '프레임레이트 일관성', desc: `${avg.toFixed(2)} fps (CFR로 보임)` });
  }
}

/**
 * nb_frames와 duration×fps의 정합성을 점검한다.
 * @param {object} v 비디오 스트림 객체
 * @param {Array<object>} out 점검 결과 누적 배열
 * @returns {void}
 */
function checkFrameCount(v, out) {
  const fps = evalRatio(v.avg_frame_rate) || evalRatio(v.r_frame_rate);
  const dur = Number(v.duration);
  const nb = Number(v.nb_frames);
  if (!fps || !dur || !nb) return;
  const expected = fps * dur;
  const diff = Math.abs(expected - nb) / Math.max(expected, 1);
  if (diff > 0.15) {
    out.push({ level: 'warn', title: '프레임 수 불일치', desc: `실제 ${nb} 프레임 vs 예상 ${expected.toFixed(0)} (duration×fps) — 프레임 드롭/중복 가능.` });
  } else {
    out.push({ level: 'ok', title: '프레임 수', desc: `${nb} 프레임 (예상치와 일치)` });
  }
}

/**
 * 비디오 start_time이 0이 아닌지(A/V 싱크 지연 가능) 점검한다.
 * @param {object} v 비디오 스트림 객체
 * @param {Array<object>} out 점검 결과 누적 배열
 * @returns {void}
 */
function checkStartTime(v, out) {
  const st = Number(v.start_time);
  if (st && Math.abs(st) > 0.1) {
    out.push({ level: 'warn', title: '0이 아닌 시작 시간', desc: `start_time=${st}s — 재생 시작 지연 또는 A/V 싱크 어긋남 가능.` });
  }
}

/**
 * 코덱 태그가 비어있는지(컨테이너-코덱 매핑 누락) 점검한다.
 * @param {object} v 비디오 스트림 객체
 * @param {Array<object>} out 점검 결과 누적 배열
 * @returns {void}
 */
function checkCodecTag(v, out) {
  if (v.codec_tag_string === '[0][0][0][0]' || v.codec_tag === '0x0000') {
    out.push({ level: 'warn', title: '코덱 태그 없음', desc: '컨테이너에 코덱 태그(fourcc)가 비어 있습니다. MP4가 아닌 단순 컨테이너(예: GIF/raw)일 수 있습니다.' });
  }
}

/**
 * format과 비디오 스트림의 duration 차이가 큰지 점검한다.
 * @param {object} fmt ffprobe format 객체
 * @param {object|null} v 비디오 스트림 객체
 * @param {Array<object>} out 점검 결과 누적 배열
 * @returns {void}
 */
function checkDurationConsistency(fmt, v, out) {
  if (!v || !fmt.duration || !v.duration) return;
  const diff = Math.abs(Number(fmt.duration) - Number(v.duration));
  if (diff > 0.5) {
    out.push({ level: 'warn', title: '길이 불일치', desc: `컨테이너 ${Number(fmt.duration).toFixed(2)}s vs 비디오 스트림 ${Number(v.duration).toFixed(2)}s (차이 ${diff.toFixed(2)}s).` });
  }
}

/**
 * moov 박스가 mdat보다 앞에 있는지(웹 스트리밍 faststart 최적화) 점검한다.
 * @param {Array<object>} boxes 최상위 박스 배열
 * @param {object} fmt ffprobe format 객체
 * @param {Array<object>} out 점검 결과 누적 배열
 * @returns {void}
 */
function checkFastStart(boxes, fmt, out) {
  if (!boxes || !boxes.length) return;
  const isMp4 = (fmt.format_name || '').includes('mp4') || boxes.some((b) => b.type === 'ftyp');
  if (!isMp4) return;
  const moovIdx = boxes.findIndex((b) => b.type === 'moov');
  const mdatIdx = boxes.findIndex((b) => b.type === 'mdat');
  if (moovIdx === -1) {
    out.push({ level: 'warn', title: 'moov 미확인', desc: '읽은 범위에서 moov 박스를 찾지 못했습니다(파일 후미에 있거나 일부만 로드됨).' });
  } else if (mdatIdx !== -1 && moovIdx > mdatIdx) {
    out.push({ level: 'warn', title: 'faststart 미적용', desc: 'moov가 mdat 뒤에 있습니다. 웹 점진적 재생이 느려질 수 있어 <code>-movflags +faststart</code> 재먹싱 권장.' });
  } else {
    out.push({ level: 'ok', title: 'faststart 최적화', desc: 'moov가 mdat 앞에 위치합니다(웹 스트리밍에 적합).' });
  }
}

/**
 * ffprobe 원본 JSON을 클립보드로 복사한다.
 * @returns {void}
 */
export function copyProbeJson() {
  if (!state.probe) return;
  navigator.clipboard.writeText(JSON.stringify(state.probe, null, 2))
    .then(() => { dom.copyProbe.textContent = '복사됨!'; setTimeout(() => { dom.copyProbe.textContent = 'JSON 복사'; }, 1200); })
    .catch(() => {});
}

/**
 * 점검 레벨에 맞는 아이콘 문자를 반환한다.
 * @param {string} level 'ok'|'warn'|'error'|'info'
 * @returns {string} 아이콘 문자
 */
function iconFor(level) {
  return { ok: '✓', warn: '⚠', error: '✕', info: 'ℹ' }[level] || '·';
}

/**
 * "num/den" 비율 문자열을 사람이 읽는 소수로 변환한다.
 * @param {string} r 비율 문자열(예: "30000/1001")
 * @returns {string} 소수 2자리 문자열 또는 '-'
 */
function ratio(r) {
  const v = evalRatio(r);
  return v ? v.toFixed(2) : '-';
}

/**
 * "num/den" 비율 문자열을 실수로 평가한다(0 분모 방지).
 * @param {string} r 비율 문자열
 * @returns {number|null} 평가값 또는 null
 */
function evalRatio(r) {
  if (!r || typeof r !== 'string' || !r.includes('/')) return null;
  const [n, d] = r.split('/').map(Number);
  if (!d) return null;
  return n / d;
}

/**
 * bit/s 값을 사람이 읽는 단위로 변환한다.
 * @param {string|number} bps 초당 비트
 * @returns {string} 예: "1.50 Mbps"
 */
function fmtBitrate(bps) {
  const n = Number(bps);
  if (n >= 1e6) return (n / 1e6).toFixed(2) + ' Mbps';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' kbps';
  return n + ' bps';
}
