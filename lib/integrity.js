'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const {
  scanTopLevelBoxes,
  readMoovBox,
  extractVideoSampleIndex,
  readSampleBytes,
} = require('./mp4-index');
const { analyzeAvccSample, scanAnnexB } = require('./nal');

const INTEGRITY_TIMEOUT_MS = Number(process.env.INTEGRITY_TIMEOUT_MS) || 10 * 60 * 1000;
const MAX_SAMPLES_SCAN = Number(process.env.MAX_NAL_SAMPLES) || 400;
const MDAT_CHUNK = 2 * 1024 * 1024;

const { extractPacketsViaFfprobe } = require('./ffprobe-packets');
const { scanGifFile } = require('./gif-integrity');

/**
 * 미디어 파일의 컨테이너·인덱스·NAL·디코드 무결성을 종합 검사한다.
 * @param {string} input 로컬 경로 또는 http(s) URL
 * @param {string} ffprobePath ffprobe 실행 경로
 * @param {string} ffmpegPath ffmpeg 실행 경로
 * @returns {Promise<object>} 무결성 검사 리포트
 */
async function analyzeIntegrity(input, ffprobePath, ffmpegPath) {
  const started = Date.now();
  const checks = [];
  const isUrl = /^https?:\/\//i.test(input);
  const localPath = isUrl ? null : input;
  const format = await resolveMediaFormat(input, isUrl, ffprobePath);

  checks.push(info('container_format', '컨테이너 형식', format.label));

  switch (format.kind) {
    case 'gif':
      if (localPath) await runGifChecks(localPath, checks);
      else checks.push(info('gif_url', 'GIF 구조 검사', 'URL 소스 — 헤더·블록 파싱 생략, ffprobe·디코드로 보완'));
      break;
    case 'mp4':
      if (localPath) await runMp4Checks(localPath, checks, ffprobePath);
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

  const decode = await runDecodeTest(input, ffmpegPath);
  mergeDecodeChecks(decode, checks);

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
    const head = await readFileHead(input, 16);
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
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return { kind: 'webm', label: 'WebM/Matroska (EBML)' };
  }
  if (head.length >= 8) {
    const tag = head.toString('ascii', 4, 8);
    if (['ftyp', 'moov', 'mdat', 'styp', 'wide', 'free', 'skip'].includes(tag)) {
      return { kind: 'mp4', label: 'MP4/MOV (ISO BMFF)' };
    }
  }
  return null;
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
  return new Promise((resolve) => {
    execFile(ffprobePath, args, { timeout: 120000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').trim());
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
 * @returns {Promise<void>}
 */
async function runMp4Checks(filePath, checks, ffprobePath) {
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
  await scanSampleNals(filePath, index, checks);
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
 * @returns {Promise<void>}
 */
async function scanSampleNals(filePath, index, checks) {
  const targets = pickSamplesForNalScan(index.samples);
  const allIssues = [];
  const agg = { scanned: 0, slices: 0, idr: 0, truncated: 0, refErrors: 0 };

  for (const s of targets) {
    if (s.size <= 0 || s.size > 8 * 1024 * 1024) continue;
    const buf = await readSampleBytes(filePath, s);
    const r = analyzeAvccSample(buf, index.lengthSize, s.index, s.keyframe);
    agg.scanned += 1;
    agg.slices += r.stats.slices;
    agg.idr += r.stats.idr;
    allIssues.push(...r.issues);
    if (r.issues.some((i) => i.code === 'truncated_nal')) agg.truncated += 1;
    if (r.issues.some((i) => /stss_without_idr|truncated_nal/.test(i.code))) agg.refErrors += 1;
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
 * @returns {Promise<object>} 디코드 결과
 */
function runDecodeTest(input, ffmpegPath) {
  const args = [
    '-v', 'error',
    '-hide_banner',
    '-i', input,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-f', 'null',
    '-',
  ];
  return new Promise((resolve) => {
    execFile(ffmpegPath, args, { timeout: INTEGRITY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const lines = (stderr && stderr.toString()).split('\n').map((l) => l.trim()).filter(Boolean);
      const errors = lines.filter((l) => /error|invalid|corrupt|mismatch|failed/i.test(l));
      resolve({
        success: !err && errors.length === 0,
        exitCode: err && err.code,
        errors: errors.slice(0, 30),
        rawStderr: lines.slice(0, 40),
      });
    });
  });
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
