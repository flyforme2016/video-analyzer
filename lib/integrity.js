'use strict';

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const {
  scanTopLevelBoxes,
  readMoovBox,
  extractVideoSampleIndex,
  readSampleBytes,
} = require('./mp4-index');
const { analyzeAvccSample, scanAnnexB } = require('./nal');
const { createIntegrityProgressReporter } = require('./integrity-progress');

const INTEGRITY_TIMEOUT_MS = Number(process.env.INTEGRITY_TIMEOUT_MS) || 10 * 60 * 1000;
const MAX_SAMPLES_SCAN = Number(process.env.MAX_NAL_SAMPLES) || 400;
const MDAT_CHUNK = 2 * 1024 * 1024;

const { extractPacketsViaFfprobe } = require('./ffprobe-packets');
const { logCommand } = require('./cmd-logger');
const { scanGifFile } = require('./gif-integrity');
const { scanFlvFile } = require('./flv-integrity');
const { scanHlsFile } = require('./hls-integrity');
const { scanTsFile } = require('./ts-integrity');

/**
 * 미디어 파일의 컨테이너·인덱스·NAL·디코드 무결성을 종합 검사한다.
 * @param {string} input 로컬 경로 또는 http(s) URL
 * @param {string} ffprobePath ffprobe 실행 경로
 * @param {string} ffmpegPath ffmpeg 실행 경로
 * @param {{onProgress?: (payload: {phase:string, phasePct:number, label:string, detail:string}) => void}} [options] 진행 콜백
 * @returns {Promise<object>} 무결성 검사 리포트
 */
async function analyzeIntegrity(input, ffprobePath, ffmpegPath, options = {}) {
  const started = Date.now();
  const checks = [];
  const isUrl = /^https?:\/\//i.test(input);
  const localPath = isUrl ? null : input;
  const progress = createIntegrityProgressReporter(options.onProgress);

  progress.report('format', 0, '컨테이너 형식 판별 중…');
  const format = await resolveMediaFormat(input, isUrl, ffprobePath);
  progress.report('format', 1, '컨테이너 형식 확인', format.label);

  checks.push(info('container_format', '컨테이너 형식', format.label));

  progress.report('structure', 0, '구조·인덱스 검사 중…');
  switch (format.kind) {
    case 'gif':
      if (localPath) await runGifChecks(localPath, checks);
      else checks.push(info('gif_url', 'GIF 구조 검사', 'URL 소스 — 헤더·블록 파싱 생략, ffprobe·디코드로 보완'));
      break;
    case 'flv':
      if (localPath) await runFlvChecks(localPath, checks);
      else checks.push(info('flv_url', 'FLV 구조 검사', 'URL 소스 — 태그 스캔 생략, ffprobe·디코드로 보완'));
      break;
    case 'hls':
      await runHlsChecks(input, localPath, checks);
      break;
    case 'ts':
      if (localPath) await runTsChecks(localPath, checks);
      else checks.push(info('ts_url', 'MPEG-TS 구조 검사', 'URL 소스 — 패킷 스캔 생략, ffprobe·디코드로 보완'));
      break;
    case 'mp4':
      if (localPath) await runMp4Checks(localPath, checks, ffprobePath, progress);
      else await runUrlChecks(input, checks, ffprobePath);
      break;
    case 'webm':
      if (localPath) await runWebmChecks(localPath, checks, ffprobePath);
      else await runUrlChecks(input, checks, ffprobePath);
      break;
    default:
      checks.push(info('generic_container', '컨테이너 검사',
        'MP4/GIF/WebM 전용 박스 검사 미적용 — 디코드 검사 위주'));
      if (isUrl) await runUrlChecks(input, checks, ffprobePath);
      break;
  }
  progress.report('structure', 1, '구조·인덱스 검사 완료');

  let decode = null;
  if (format.kind === 'hls' && !isUrl) {
    checks.push(info('hls_decode_skip', '디코드 검사 생략',
      '로컬 m3u8은 세그먼트 파일이 없어 디코드 검사를 건너뜁니다.'));
    progress.report('done', 1, '무결성 검사 완료');
  } else {
    progress.report('decode', 0, '전체 디코드 검사 준비…');
    const durationMs = await probeDurationMs(input, ffprobePath);
    decode = await runDecodeTest(input, ffmpegPath, {
      durationMs,
      onDecodeFraction: (fraction, detail) => {
        progress.report('decode', fraction, '전체 디코드 검사 중…', detail);
      },
    });
    mergeDecodeChecks(decode, checks);
    progress.report('done', 1, '무결성 검사 완료');
  }

  const errors = checks.filter((c) => c.level === 'error').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  return {
    elapsed: Date.now() - started,
    format: format.kind,
    summary: { errors, warns, total: checks.length, verdict: errors ? '문제 발견' : warns ? '주의 필요' : '정상' },
    checks,
    decode,
  };
}

/**
 * 입력 소스의 컨테이너 종류를 판별한다.
 * @param {string} input 파일 경로 또는 URL
 * @param {boolean} isUrl URL 여부
 * @param {string} ffprobePath ffprobe 경로
 * @returns {Promise<{kind:string,label:string}>} 컨테이너 종류
 */
async function resolveMediaFormat(input, isUrl, ffprobePath) {
  if (!isUrl) {
    const head = await readFileHead(input, 512);
    const magic = formatFromMagic(head);
    if (magic) return magic;
  } else {
    const fromUrl = formatFromUrl(input);
    if (fromUrl) return fromUrl;
  }
  const name = await probeFormatName(input, ffprobePath);
  return formatFromFfprobeName(name) || { kind: 'unknown', label: name || '알 수 없음' };
}

/**
 * 파일 선두 바이트를 읽는다.
 * @param {string} filePath 파일 경로
 * @param {number} len 읽을 바이트 수
 * @returns {Promise<Buffer>} 선두 바이트
 */
async function readFileHead(filePath, len) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * 매직 바이트로 컨테이너 종류를 추정한다.
 * @param {Buffer} head 파일 선두 바이트
 * @returns {{kind:string,label:string}|null} 종류 또는 null
 */
function formatFromMagic(head) {
  if (head.length >= 6 && head.toString('ascii', 0, 3) === 'GIF') {
    return { kind: 'gif', label: `GIF (${head.toString('ascii', 3, 6)})` };
  }
  if (head.length >= 3 && head[0] === 0x46 && head[1] === 0x4c && head[2] === 0x56) {
    return { kind: 'flv', label: 'FLV (Flash Video)' };
  }
  if (isExtM3uHead(head)) {
    return { kind: 'hls', label: 'HLS 플레이리스트 (m3u8)' };
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return { kind: 'webm', label: 'WebM/Matroska (EBML)' };
  }
  if (head.length >= 8) {
    const tag = head.toString('ascii', 4, 8);
    if (['ftyp', 'moov', 'mdat', 'styp', 'wide', 'free', 'skip'].includes(tag)) {
      return { kind: 'mp4', label: 'MP4/MOV (ISO BMFF)' };
    }
  }
  if (isTsHead(head)) return { kind: 'ts', label: 'MPEG-TS (Transport Stream)' };
  return null;
}

/**
 * 선두 바이트가 TS/M2TS 동기 패턴(0x47 반복)인지 확인한다.
 * @param {Buffer} head 파일 선두 바이트
 * @returns {boolean} TS면 true
 */
function isTsHead(head) {
  for (const size of [188, 192, 204]) {
    for (let start = 0; start <= 4 && start + size + 1 < head.length; start += 1) {
      if (head[start] === 0x47 && head[start + size] === 0x47) return true;
    }
  }
  return false;
}

/**
 * 선두 바이트가 #EXTM3U로 시작하는지 확인한다(BOM 허용).
 * @param {Buffer} head 파일 선두 바이트
 * @returns {boolean} HLS 플레이리스트면 true
 */
function isExtM3uHead(head) {
  let i = 0;
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;
  return head.length >= i + 7 && head.toString('ascii', i, i + 7) === '#EXTM3U';
}

/**
 * URL 경로 확장자로 컨테이너 종류를 추정한다.
 * @param {string} url 원격 URL
 * @returns {{kind:string,label:string}|null} 종류 또는 null
 */
function formatFromUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith('.gif')) return { kind: 'gif', label: 'GIF' };
    if (path.endsWith('.m3u8')) return { kind: 'hls', label: 'HLS (m3u8)' };
    if (/\.(ts|m2ts|mts)$/.test(path)) return { kind: 'ts', label: 'MPEG-TS' };
    if (/\.(flv|f4v)$/.test(path)) return { kind: 'flv', label: 'FLV' };
    if (/\.(webm|mkv)$/.test(path)) return { kind: 'webm', label: 'WebM/Matroska' };
    if (/\.(mp4|mov|m4v|3gp)$/.test(path)) return { kind: 'mp4', label: 'MP4/MOV' };
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * ffprobe format_name을 조회한다.
 * @param {string} input 파일 경로 또는 URL
 * @param {string} ffprobePath ffprobe 경로
 * @returns {Promise<string>} format_name 문자열
 */
function probeFormatName(input, ffprobePath) {
  const args = [
    '-v', 'quiet',
    '-show_entries', 'format=format_name',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    input,
  ];
  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile(ffprobePath, args, { timeout: 120000 }, (err, stdout, stderr) => {
      logCommand('ffprobe', { bin: ffprobePath, args, startedAt, elapsedMs: Date.now() - startedAt, err, stdout, stderr });
      resolve(err ? '' : String(stdout || '').trim());
    });
  });
}

/**
 * ffprobe로 미디어 전체 길이(초)를 조회해 밀리초로 반환한다.
 * @param {string} input 파일 경로 또는 URL
 * @param {string} ffprobePath ffprobe 경로
 * @returns {Promise<number>} 길이(ms), 알 수 없으면 0
 */
function probeDurationMs(input, ffprobePath) {
  const args = [
    '-v', 'quiet',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    input,
  ];
  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile(ffprobePath, args, { timeout: 120000 }, (err, stdout, stderr) => {
      logCommand('ffprobe', { bin: ffprobePath, args, startedAt, elapsedMs: Date.now() - startedAt, err, stdout, stderr });
      if (err) {
        resolve(0);
        return;
      }
      const sec = parseFloat(String(stdout || '').trim());
      resolve(Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0);
    });
  });
}

/**
 * ffprobe format_name을 컨테이너 종류로 매핑한다.
 * @param {string} name ffprobe format_name
 * @returns {{kind:string,label:string}|null} 종류 또는 null
 */
function formatFromFfprobeName(name) {
  if (!name) return null;
  if (name.includes('gif')) return { kind: 'gif', label: 'GIF' };
  if (name.includes('flv')) return { kind: 'flv', label: 'FLV' };
  if (name.includes('hls') || name.includes('applehttp')) return { kind: 'hls', label: 'HLS' };
  if (name.includes('mpegts')) return { kind: 'ts', label: 'MPEG-TS' };
  if (name.includes('matroska') || name.includes('webm')) return { kind: 'webm', label: 'WebM/Matroska' };
  if (name.includes('mp4') || name.includes('mov') || name.includes('m4v') || name.includes('3gp')) {
    return { kind: 'mp4', label: 'MP4/MOV' };
  }
  return { kind: 'unknown', label: name };
}

/**
 * GIF 파일 구조(헤더·프레임·트레일러)를 검사한다.
 * @param {string} filePath GIF 파일 경로
 * @param {Array<object>} checks 점검 결과 누적 배열
 * @returns {Promise<void>}
 */
async function runGifChecks(filePath, checks) {
  const scan = await scanGifFile(filePath);
  if (!scan.valid) {
    checks.push(error('gif_signature', 'GIF 시그니처 없음', 'GIF87a/GIF89a 헤더가 아닙니다.'));
    return;
  }

  checks.push(ok('gif_header', 'GIF 헤더', `${scan.version} · 논리 화면 ${scan.width}×${scan.height}`));
  if (scan.width === 0 || scan.height === 0) {
    checks.push(error('gif_lsd', '논리 화면 크기', '논리 화면 너비/높이가 0입니다.'));
  }

  if (scan.frames === 0) {
    checks.push(error('gif_no_frames', '이미지 프레임 없음', 'IMG(0x2C) 디스크립터가 없습니다.'));
  } else {
    checks.push(ok('gif_frames', '이미지 프레임', `${scan.frames}개 프레임 · GCE ${scan.gceCount}개`));
  }

  if (scan.truncated || scan.badMarker) {
    checks.push(error('gif_truncated', 'GIF 블록 잘림',
      scan.badMarker ? '알 수 없는 블록 마커 — 파일이 중간에 끊겼을 수 있습니다.' : '블록 파싱 중 버퍼가 부족합니다.'));
  }

  if (!scan.hasTrailer) {
    checks.push(error('gif_trailer', '트레일러 없음', '파일 끝 0x3B 트레일러가 없습니다.'));
  } else {
    checks.push(ok('gif_trailer', '트레일러', `0x3B 종료 마커 확인 · 파싱 끝 ${scan.parsedEnd}/${scan.fileSize}`));
    if (scan.trailingBytes > 0) {
      checks.push(warn('gif_trailing', '트레일러 이후 데이터',
        `종료 마커 뒤 ${scan.trailingBytes}B 추가 데이터`));
    }
  }
}

/**
 * FLV 파일 구조(헤더·태그·타임스탬프·PreviousTagSize)를 검사한다.
 * @param {string} filePath FLV 파일 경로
 * @param {Array<object>} checks 점검 결과 누적 배열
 * @returns {Promise<void>}
 */
async function runFlvChecks(filePath, checks) {
  const scan = await scanFlvFile(filePath);
  if (!scan.valid) {
    checks.push(error('flv_signature', 'FLV 시그니처 없음', '"FLV" 헤더가 아닙니다.'));
    return;
  }

  const streams = [scan.hasVideo ? '비디오' : null, scan.hasAudio ? '오디오' : null].filter(Boolean).join('+') || '없음';
  checks.push(ok('flv_header', 'FLV 헤더', `v${scan.version} · 선언 스트림 ${streams}`));

  const c = scan.counts;
  const total = c.audio + c.video + c.script;
  if (total === 0) {
    checks.push(error('flv_no_tags', '태그 없음', '헤더 이후 태그가 없습니다.'));
  } else {
    checks.push(ok('flv_tags', '태그 통계',
      `총 ${total}개 · 비디오 ${c.video}(키프레임 ${c.keyframes}) · 오디오 ${c.audio} · 스크립트 ${c.script} · ~${(scan.lastTimestamp / 1000).toFixed(1)}s`));
  }

  if (scan.hasVideo && c.video === 0) {
    checks.push(warn('flv_video_flag', '비디오 플래그 불일치', '헤더는 비디오 있음인데 비디오 태그가 없습니다.'));
  }
  if (scan.hasAudio && c.audio === 0) {
    checks.push(warn('flv_audio_flag', '오디오 플래그 불일치', '헤더는 오디오 있음인데 오디오 태그가 없습니다.'));
  }
  if (scan.hasVideo && c.video > 0 && c.keyframes === 0) {
    checks.push(warn('flv_no_keyframe', '키프레임 없음', '비디오 태그에 키프레임이 감지되지 않았습니다.'));
  }

  if (scan.badType > 0) {
    checks.push(error('flv_bad_tag', '알 수 없는 태그', `${scan.badType}개 태그 타입이 8/9/18이 아닙니다 — 손상 의심`));
  }
  if (scan.prevSizeMismatch > 0) {
    checks.push(error('flv_prevsize', 'PreviousTagSize 불일치',
      `${scan.prevSizeMismatch}개 태그에서 PreviousTagSize가 태그 크기와 다릅니다 — 구조 손상`));
  } else if (total > 0) {
    checks.push(ok('flv_prevsize', 'PreviousTagSize 정합성', '모든 태그의 역방향 크기 필드가 일치'));
  }
  if (scan.backwards > 0) {
    checks.push(warn('flv_timestamp', '타임스탬프 역전', `${scan.backwards}개 태그에서 타임스탬프가 감소합니다`));
  }
  if (scan.truncated) {
    checks.push(error('flv_truncated', 'FLV 태그 잘림', `태그 스캔이 ${scan.parsedEnd}/${scan.fileSize}에서 끊겼습니다 — 파일 잘림 의심`));
  } else if (scan.trailingBytes > 0) {
    checks.push(warn('flv_trailing', '잔여 데이터', `마지막 태그 뒤 ${scan.trailingBytes}B 추가 데이터`));
  } else if (total > 0) {
    checks.push(ok('flv_complete', 'FLV 스캔 완료', `파일 끝까지 태그 정상 파싱 (${scan.fileSize}B)`));
  }
}

/**
 * HLS(m3u8) 플레이리스트 구조를 검사한다(로컬 파일은 구조 파싱, URL은 ffprobe 보조).
 * @param {string} input 입력 경로 또는 URL
 * @param {string|null} localPath 로컬 파일 경로(URL이면 null)
 * @param {Array<object>} checks 점검 결과 누적 배열
 * @returns {Promise<void>}
 */
async function runHlsChecks(input, localPath, checks) {
  if (!localPath) {
    checks.push(info('hls_url', 'HLS 플레이리스트', 'URL 소스 — 세그먼트 재생·디코드 검사로 보완'));
    return;
  }

  const scan = await scanHlsFile(localPath);
  if (!scan.valid) {
    checks.push(error('hls_signature', 'EXTM3U 헤더 없음', '#EXTM3U로 시작하지 않습니다.'));
    return;
  }

  checks.push(ok('hls_header', 'HLS 플레이리스트',
    `${scan.kind === 'master' ? '마스터' : '미디어'} 플레이리스트${scan.version ? ' · v' + scan.version : ''}`));

  if (scan.kind === 'master') {
    if (scan.variants === 0) {
      checks.push(error('hls_no_variant', '변형 스트림 없음', '#EXT-X-STREAM-INF 항목이 없습니다.'));
    } else {
      checks.push(ok('hls_variants', '변형 스트림', `${scan.variants}개 변형 · 미디어 그룹 ${scan.mediaCount}개`));
    }
    if (scan.missingBandwidth > 0) {
      checks.push(error('hls_bandwidth', 'BANDWIDTH 누락', `${scan.missingBandwidth}개 변형에 BANDWIDTH 속성이 없습니다.`));
    }
    if (scan.missingUri > 0) {
      checks.push(error('hls_variant_uri', '변형 URI 누락', `${scan.missingUri}개 STREAM-INF 뒤에 URI가 없습니다.`));
    }
  } else {
    if (scan.segments === 0) {
      checks.push(error('hls_no_segments', '세그먼트 없음', '#EXTINF 세그먼트가 없습니다.'));
    } else {
      checks.push(ok('hls_segments', '세그먼트',
        `${scan.segments}개 · 총 ${scan.totalDuration.toFixed(1)}s · 최대 ${scan.maxDuration.toFixed(1)}s`));
    }
    if (!scan.targetDuration) {
      checks.push(warn('hls_no_target', 'TARGETDURATION 없음', '#EXT-X-TARGETDURATION 태그가 없습니다.'));
    } else if (scan.overTarget > 0) {
      checks.push(error('hls_over_target', 'TARGETDURATION 초과',
        `${scan.overTarget}개 세그먼트가 선언된 ${scan.targetDuration}s를 초과합니다.`));
    } else {
      checks.push(ok('hls_target', 'TARGETDURATION', `${scan.targetDuration}s 이내로 모든 세그먼트 적합`));
    }
    if (scan.missingUri > 0) {
      checks.push(error('hls_segment_uri', '세그먼트 URI 누락', `${scan.missingUri}개 EXTINF 뒤에 URI가 없습니다.`));
    }
    checks.push(info('hls_type', '재생 유형', scan.hasEndlist ? 'VOD (ENDLIST 있음)' : 'LIVE/미완결 (ENDLIST 없음)'));
    if (scan.encrypted) checks.push(info('hls_encrypted', '암호화', '#EXT-X-KEY 암호화 세그먼트 포함'));
    checks.push(info('hls_segment_note', '세그먼트 파일', '플레이리스트만 검사 — 실제 세그먼트(.ts/.m4s) 무결성은 URL 소스에서 디코드로 확인'));
  }
}

/**
 * MPEG-TS/M2TS 파일 구조(패킷 동기·PAT/PMT·연속성 카운터)를 검사한다.
 * @param {string} filePath TS 파일 경로
 * @param {Array<object>} checks 점검 결과 누적 배열
 * @returns {Promise<void>}
 */
async function runTsChecks(filePath, checks) {
  const scan = await scanTsFile(filePath);
  if (!scan.valid) {
    checks.push(error('ts_sync', 'TS 동기 패턴 없음', '0x47 동기 바이트가 188/192/204 간격으로 반복되지 않습니다.'));
    return;
  }

  const kind = scan.packetSize === 192 ? 'M2TS(192B)' : scan.packetSize === 204 ? 'TS+FEC(204B)' : 'MPEG-TS(188B)';
  checks.push(ok('ts_header', 'TS 패킷', `${kind} · ${scan.packets.toLocaleString()}개${scan.partial ? ' (앞부분 스캔)' : ''} · PID ${scan.pidCount}종`));

  if (!scan.hasPat) {
    checks.push(error('ts_no_pat', 'PAT 없음', 'PID 0(Program Association Table)을 찾지 못했습니다.'));
  } else {
    checks.push(ok('ts_pat', 'PAT', `프로그램 ${scan.programs.length}개`));
  }

  if (!scan.hasPmt) {
    checks.push(warn('ts_no_pmt', 'PMT 없음', 'PMT(Program Map Table)를 찾지 못했습니다 — 스트림 구성 확인 불가'));
  } else if (scan.streams.length) {
    const list = scan.streams.map((s) => `${s.label}(PID ${s.esPid})`).join(', ');
    checks.push(ok('ts_pmt', 'PMT 스트림', `${scan.streams.length}개 · ${list}`));
  }

  if (scan.syncErrors > 0) {
    checks.push(error('ts_sync_err', '동기 손실', `${scan.syncErrors}개 위치에서 0x47 동기 바이트가 어긋났습니다 — 패킷 정렬 손상`));
  }
  if (scan.teiCount > 0) {
    checks.push(error('ts_tei', '전송 오류 표시', `${scan.teiCount}개 패킷에 transport_error_indicator가 설정됨 — 전송 중 손상`));
  }
  if (scan.ccErrors > 0) {
    checks.push(warn('ts_cc', '연속성 카운터 오류', `${scan.ccErrors}개 패킷에서 continuity_counter가 불연속 — 패킷 손실/중복 의심`));
  } else if (scan.packets > 0) {
    checks.push(ok('ts_cc', '연속성 카운터', '모든 PID에서 continuity_counter 연속'));
  }
  if (scan.scrambled > 0) {
    checks.push(info('ts_scrambled', '스크램블', `${scan.scrambled}개 패킷이 스크램블됨 — 디코드가 제한될 수 있습니다.`));
  }
}

/**
 * WebM/Matroska 파일에 대해 EBML 기반 전용 검사 대신 패킷·디코드 보조 검사를 수행한다.
 * @param {string} filePath 파일 경로
 * @param {Array<object>} checks 점검 결과
 * @param {string} ffprobePath ffprobe 경로
 * @returns {Promise<void>}
 */
async function runWebmChecks(filePath, checks, ffprobePath) {
  const head = await readFileHead(filePath, 4);
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45) {
    checks.push(ok('webm_ebml', 'EBML 헤더', 'Matroska/WebM 시그니처(0x1A45DFA3) 확인'));
  } else {
    checks.push(warn('webm_ebml', 'EBML 헤더', '선두 EBML 시그니처를 확인하지 못했습니다.'));
  }
  checks.push(info('webm_note', '컨테이너 구조', 'WebM은 MP4의 mdat/moov 대신 EBML 요소를 사용합니다.'));
  const index = await extractPacketsViaFfprobe(filePath, ffprobePath);
  if (index && index.samples.length) {
    checks.push(info('index_source', '샘플 인덱스', `ffprobe 패킷 ${index.samples.length}개`));
    checks.push(ok('packet_order', '패킷 오프셋', 'ffprobe 패킷 정보 추출 성공'));
  } else {
    checks.push(info('nal_scan', '패킷/NAL 검사', 'ffprobe 패킷 추출 없음 — 디코드 검사로 보완'));
  }
}

/**
 * MP4 로컬 파일에 대해 컨테이너·인덱스·NAL 검사를 수행한다.
 * @param {string} filePath 파일 경로
 * @param {Array<object>} checks 점검 결과 누적 배열
 * @param {string} ffprobePath ffprobe 경로
 * @param {{report: function(string, number, string, string=): void}} [progress] 진행 리포터
 * @returns {Promise<void>}
 */
async function runMp4Checks(filePath, checks, ffprobePath, progress) {
  progress?.report('structure', 0.1, 'MP4 박스 구조 검사 중…');
  const { fileSize, boxes } = await scanTopLevelBoxes(filePath);
  const mdat = boxes.find((b) => b.type === 'mdat');
  const moovBox = boxes.find((b) => b.type === 'moov');
  const ftyp = boxes.find((b) => b.type === 'ftyp');

  if (!ftyp) checks.push(warn('no_ftyp', 'ftyp 없음', 'MP4/MOV 시그니처 박스가 없습니다.'));
  if (!mdat) {
    checks.push(error('no_mdat', 'mdat 없음', '미디어 데이터 박스가 없습니다.'));
    return;
  }
  if (!moovBox) checks.push(error('no_moov', 'moov 없음', '메타데이터(moov) 박스가 없습니다.'));

  const mdatBodyStart = mdat.offset + mdat.headerSize;
  const mdatBodyEnd = mdat.end;
  const mdatBodySize = mdatBodyEnd - mdatBodyStart;

  if (mdat.end > fileSize) {
    checks.push(error('mdat_truncated', 'mdat 파일 잘림',
      `mdat 선언 끝 ${mdat.end} > 파일 크기 ${fileSize} (${mdat.end - fileSize}B 초과 선언)`));
  } else {
    checks.push(ok('mdat_size', 'mdat 범위', `mdat ${fmtBytes(mdatBodySize)} · 파일 ${fmtBytes(fileSize)} 내 포함`));
  }

  const moovBuf = await readMoovBox(filePath, boxes, fileSize);
  if (!moovBuf) {
    checks.push(warn('moov_read_fail', 'moov 읽기 실패', 'moov 파싱 불가 — 인덱스/NAL 검사 생략'));
    return;
  }

  let index = extractVideoSampleIndex(moovBuf);
  if (!index || !index.samples.length) {
    index = await extractPacketsViaFfprobe(filePath, ffprobePath);
    if (index) checks.push(info('index_source', '샘플 인덱스', 'ffprobe 패킷 정보로 추출'));
  } else {
    checks.push(info('index_source', '샘플 인덱스', 'moov stbl(stco/stsz)로 추출'));
  }

  if (!index || !index.samples.length) {
    checks.push(warn('no_sample_index', '샘플 인덱스 없음', '샘플 테이블/ffprobe 패킷 추출 실패'));
    await scanMdatAnnexB(filePath, mdatBodyStart, mdatBodyEnd, checks);
    return;
  }

  validateSampleIndex(index.samples, mdatBodyStart, mdatBodyEnd, fileSize, checks);
  await scanSampleNals(filePath, index, checks, progress);
}

/**
 * URL 소스에 대해 ffprobe 패킷·디코드 기반 검사를 수행한다.
 * @param {string} url 미디어 URL
 * @param {Array<object>} checks 점검 결과
 * @param {string} ffprobePath ffprobe 경로
 * @returns {Promise<void>}
 */
async function runUrlChecks(url, checks, ffprobePath) {
  const index = await extractPacketsViaFfprobe(url, ffprobePath);
  if (index && index.samples.length) {
    checks.push(info('index_source', '샘플 인덱스', `ffprobe 패킷 ${index.samples.length}개`));
    const last = index.samples[index.samples.length - 1];
    const estSize = last.offset + last.size;
    let outOfOrder = 0;
    for (let i = 1; i < index.samples.length; i += 1) {
      if (index.samples[i].offset < index.samples[i - 1].offset) outOfOrder += 1;
    }
    if (outOfOrder > 0) {
      checks.push(error('packet_order', '패킷 오프셋 역전', `${outOfOrder}개 패킷 순서 이상`));
    } else {
      checks.push(ok('packet_order', '패킷 오프셋', 'ffprobe 패킷 pos 순서 정상'));
    }
    checks.push(info('packet_span', '패킷 범위', `0 ~ ${estSize} (${fmtBytes(estSize)})`));
    checks.push(info('nal_scan', 'NAL 검사', 'URL 소스는 패킷 바이트 직접 읽기 생략 — 디코드 검사로 보완'));
  } else {
    checks.push(warn('url_packets', 'URL 패킷 정보', 'ffprobe 패킷 추출 실패 — 디코드 검사만 수행'));
  }
}

/**
 * 샘플 인덱스가 mdat·파일 범위 안에 있는지 검증한다.
 * @param {Array<object>} samples 샘플 목록
 * @param {number} mdatStart mdat 본문 시작
 * @param {number} mdatEnd mdat 본문 끝
 * @param {number} fileSize 파일 크기
 * @param {Array<object>} checks 점검 결과
 * @returns {void}
 */
function validateSampleIndex(samples, mdatStart, mdatEnd, fileSize, checks) {
  let outOfMdat = 0;
  let outOfFile = 0;
  let zeroSize = 0;
  let overlap = 0;
  let prevEnd = -1;

  for (const s of samples) {
    if (s.size === 0) zeroSize += 1;
    if (s.offset < mdatStart || s.offset + s.size > mdatEnd) outOfMdat += 1;
    if (s.offset + s.size > fileSize) outOfFile += 1;
    if (prevEnd > 0 && s.offset < prevEnd) overlap += 1;
    prevEnd = s.offset + s.size;
  }

  checks.push(info('sample_count', '샘플 수', `${samples.length}개 (stsz/stco 기준)`));
  if (outOfFile > 0) {
    checks.push(error('sample_past_eof', '샘플 파일 범위 초과',
      `${outOfFile}개 샘플이 파일 끝을 넘습니다 — mdat/인덱스 손상`));
  } else if (outOfMdat > 0) {
    checks.push(error('sample_outside_mdat', '샘플 mdat 범위 초과',
      `${outOfMdat}개 샘플 오프셋이 mdat 본문 밖을 가리킵니다`));
  } else {
    checks.push(ok('sample_in_mdat', '샘플↔mdat 정합성', '모든 샘플이 mdat 범위 내'));
  }
  if (zeroSize > 0) checks.push(error('zero_size_samples', '0바이트 샘플', `${zeroSize}개 — 인덱스 손상`));
  if (overlap > 0) checks.push(warn('sample_overlap', '샘플 오버랩', `${overlap}개 샘플이 이전 샘플과 겹침`));
}

/**
 * 대표 샘플(키프레임·앞·뒤)에서 NAL 구조·참조를 검사한다.
 * @param {string} filePath 파일 경로
 * @param {{lengthSize:number,samples:Array<object>}} index 샘플 인덱스
 * @param {Array<object>} checks 점검 결과
 * @param {{report: function(string, number, string, string=): void}} [progress] 진행 리포터
 * @returns {Promise<void>}
 */
async function scanSampleNals(filePath, index, checks, progress) {
  const targets = pickSamplesForNalScan(index.samples);
  const allIssues = [];
  const agg = { scanned: 0, slices: 0, idr: 0, truncated: 0, refErrors: 0 };
  const scannable = targets.filter((s) => s.size > 0 && s.size <= 8 * 1024 * 1024);
  progress?.report('nal', 0, 'NAL 샘플 검사 중…');

  for (let i = 0; i < scannable.length; i += 1) {
    const s = scannable[i];
    const buf = await readSampleBytes(filePath, s);
    const r = analyzeAvccSample(buf, index.lengthSize, s.index, s.keyframe);
    agg.scanned += 1;
    agg.slices += r.stats.slices;
    agg.idr += r.stats.idr;
    allIssues.push(...r.issues);
    if (r.issues.some((issue) => issue.code === 'truncated_nal')) agg.truncated += 1;
    if (r.issues.some((issue) => /stss_without_idr|truncated_nal/.test(issue.code))) agg.refErrors += 1;
    if (scannable.length > 0) {
      progress?.report('nal', (i + 1) / scannable.length,
        'NAL 샘플 검사 중…', `${i + 1} / ${scannable.length}`);
    }
  }

  checks.push(info('nal_scan', 'NAL 샘플 스캔',
    `${agg.scanned}개 샘플 검사 (키프레임+앞/뒤 구간) · lengthSize=${index.lengthSize}`));

  if (agg.truncated > 0) {
    checks.push(error('nal_truncated', 'NAL 잘림',
      `${agg.truncated}개 샘플에서 NAL 길이가 버퍼를 초과 — mdat 데이터 손상`));
  }
  if (agg.refErrors > 0) {
    checks.push(error('nal_reference', '프레임 참조 이상',
      `${agg.refErrors}개 샘플에서 IDR/키프레임 불일치 또는 NAL 잘림`));
  }
  if (agg.truncated === 0 && agg.refErrors === 0 && agg.scanned > 0) {
    checks.push(ok('nal_structure', 'NAL 구조', `스캔 ${agg.scanned}개 샘플에서 NAL 경계·참조 정상`));
  }

  const preview = allIssues.slice(0, 12);
  for (const iss of preview) {
    checks.push(warn(`nal_${iss.code}`, `샘플 #${iss.sampleIndex} NAL`,
      `${iss.message} (offset ${iss.offset})`));
  }
  if (allIssues.length > preview.length) {
    checks.push(info('nal_more', '추가 NAL 이슈', `… 외 ${allIssues.length - preview.length}건`));
  }
}

/**
 * NAL 스캔 대상 샘플을 고른다(키프레임 + 앞뒤 + 균등 샘플링).
 * @param {Array<object>} samples 전체 샘플
 * @returns {Array<object>} 스캔 대상
 */
function pickSamplesForNalScan(samples) {
  const picked = new Map();
  const add = (s) => picked.set(s.index, s);
  samples.slice(0, 5).forEach(add);
  samples.slice(-3).forEach(add);
  samples.filter((s) => s.keyframe).forEach(add);
  const step = Math.max(1, Math.floor(samples.length / 50));
  for (let i = 0; i < samples.length; i += step) add(samples[i]);
  return Array.from(picked.values()).slice(0, MAX_SAMPLES_SCAN);
}

/**
 * mdat를 Annex B start code로 스트리밍 스캔한다(AVCC 인덱스 없을 때 폴백).
 * @param {string} filePath 파일 경로
 * @param {number} start mdat 본문 시작
 * @param {number} end mdat 본문 끝
 * @param {Array<object>} checks 점검 결과
 * @returns {Promise<void>}
 */
async function scanMdatAnnexB(filePath, start, end, checks) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    let offset = start;
    let chunks = 0;
    let totalNals = 0;
    while (offset < end && chunks < 8) {
      const len = Math.min(MDAT_CHUNK, end - offset);
      const buf = Buffer.allocUnsafe(len);
      await fh.read(buf, 0, len, offset);
      const r = scanAnnexB(buf, offset, 200);
      totalNals += r.nals.length;
      offset += len;
      chunks += 1;
      if (r.nals.length > 0) break;
    }
    if (totalNals > 0) {
      checks.push(info('annexb_scan', 'mdat Annex B 스캔', `${totalNals}개 NAL start code 발견`));
    } else {
      checks.push(info('annexb_none', 'mdat 스캔', 'Annex B start code 없음 — AVCC(length-prefixed) 형식일 수 있음'));
    }
  } finally {
    await fh.close();
  }
}

/**
 * ffmpeg으로 전체 디코드(엔트로피 디코딩 포함)를 시도한다.
 * @param {string} input 입력 경로/URL
 * @param {string} ffmpegPath ffmpeg 경로
 * @param {{durationMs?:number, onDecodeFraction?:(fraction:number, detail:string)=>void}} [options] 진행 콜백
 * @returns {Promise<object>} 디코드 결과
 */
function runDecodeTest(input, ffmpegPath, options = {}) {
  const { durationMs = 0, onDecodeFraction } = options;
  const args = ['-hide_banner', '-v', 'error', '-progress', 'pipe:1', '-nostats'];
  if (/\.m3u8(\?|#|$)/i.test(String(input))) args.push('-allowed_extensions', 'ALL');
  args.push(
    '-i', input,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-f', 'null',
    '-',
  );
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let progressBuf = '';
    let lastDetail = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, INTEGRITY_TIMEOUT_MS);

    /**
     * ffmpeg progress stdout에서 out_time_ms를 파싱해 디코드 진행률을 보고한다.
     * @param {string} chunk progress 스트림 청크
     * @returns {void}
     */
    function handleProgressChunk(chunk) {
      if (!onDecodeFraction) return;
      progressBuf += chunk;
      const lines = progressBuf.split('\n');
      progressBuf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq);
        const value = trimmed.slice(eq + 1);
        if (key !== 'out_time_ms') continue;
        if (value === 'N/A') {
          onDecodeFraction(0, '디코드 시작…');
          continue;
        }
        const raw = parseInt(value, 10);
        if (!Number.isFinite(raw) || raw < 0) continue;
        // ffmpeg progress의 out_time_ms는 이름과 달리 마이크로초(µs) 단위다.
        const outMs = Math.round(raw / 1000);
        if (durationMs > 0) {
          const frac = Math.min(0.99, outMs / durationMs);
          const detail = `${formatDecodeTime(outMs)} / ${formatDecodeTime(durationMs)}`;
          if (detail !== lastDetail) {
            lastDetail = detail;
            onDecodeFraction(frac, detail);
          }
        } else {
          onDecodeFraction(0, `경과 ${formatDecodeTime(outMs)}`);
        }
      }
    }

    child.stdout.on('data', (chunk) => handleProgressChunk(chunk.toString()));
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (progressBuf) handleProgressChunk('\n');
      if (onDecodeFraction && durationMs > 0) onDecodeFraction(1, '디코드 완료');
      const err = code !== 0 || signal
        ? { code, signal, killed: timedOut || signal === 'SIGTERM', message: stderr.trim() }
        : null;
      logCommand('ffmpeg', {
        bin: ffmpegPath,
        args,
        startedAt,
        elapsedMs: Date.now() - startedAt,
        err,
        stdout: '',
        stderr,
      });
      const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
      const errors = lines.filter((l) => /error|invalid|corrupt|mismatch|failed/i.test(l));
      resolve({
        success: !err && errors.length === 0,
        exitCode: err && (err.code ?? (timedOut ? 'TIMEOUT' : undefined)),
        errors: errors.slice(0, 30),
        rawStderr: lines.slice(0, 40),
      });
    });

    child.on('error', (spawnErr) => {
      clearTimeout(timer);
      logCommand('ffmpeg', {
        bin: ffmpegPath,
        args,
        startedAt,
        elapsedMs: Date.now() - startedAt,
        err: spawnErr,
        stdout: '',
        stderr,
      });
      resolve({
        success: false,
        exitCode: spawnErr.code,
        errors: [String(spawnErr.message || spawnErr)],
        rawStderr: [],
      });
    });
  });
}

/**
 * 밀리초를 mm:ss 형식으로 포맷한다.
 * @param {number} ms 밀리초
 * @returns {string} mm:ss
 */
function formatDecodeTime(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

/**
 * 디코드 결과를 checks 배열에 반영한다.
 * @param {object} decode 디코드 결과
 * @param {Array<object>} checks 점검 결과
 * @returns {void}
 */
function mergeDecodeChecks(decode, checks) {
  if (decode.success) {
    checks.push(ok('decode', '엔트로피 디코드', 'ffmpeg 전체 디코드 성공 — 프레임 데이터 디코드 가능'));
    return;
  }
  if (decode.errors.length) {
    checks.push(error('decode_failed', '디코드 실패',
      `ffmpeg 오류 ${decode.errors.length}건: ${escapeHtml(decode.errors[0] || 'unknown')}`));
    decode.errors.slice(1, 6).forEach((e, i) => {
      checks.push(warn(`decode_err_${i}`, '디코드 상세', escapeHtml(e)));
    });
  } else {
    checks.push(error('decode_exit', '디코드 비정상 종료', `exit code ${decode.exitCode || '?'}`));
  }
}

function ok(id, title, desc) { return { level: 'ok', id, title, desc }; }
function warn(id, title, desc) { return { level: 'warn', id, title, desc }; }
function error(id, title, desc) { return { level: 'error', id, title, desc }; }
function info(id, title, desc) { return { level: 'info', id, title, desc }; }

/**
 * 바이트를 사람이 읽는 크기로 변환한다.
 * @param {number} n 바이트
 * @returns {string} 포맷 문자열
 */
function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

/**
 * HTML 특수문자를 이스케이프한다.
 * @param {string} s 문자열
 * @returns {string} 이스케이프됨
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

module.exports = { analyzeIntegrity };
