'use strict';

const NAL_NAMES = {
  1: 'Non-IDR slice',
  5: 'IDR slice',
  6: 'SEI',
  7: 'SPS',
  8: 'PPS',
  9: 'AUD',
};

/**
 * AVCC(length-prefixed) 샘플에서 NAL 유닛을 파싱하고 구조·참조를 검증한다.
 */

/**
 * 샘플 버퍼에서 NAL 유닛 목록과 이슈를 추출한다.
 * @param {Buffer} sample 샘플 바이트
 * @param {number} lengthSize NAL 길이 필드 크기(1|2|4)
 * @param {number} sampleIndex 1-based 샘플 번호
 * @param {boolean} isKeyframe 키프레임 여부
 * @returns {{nals:Array<object>, issues:Array<object>, stats:object}} 파싱 결과
 */
function analyzeAvccSample(sample, lengthSize, sampleIndex, isKeyframe) {
  const nals = [];
  const issues = [];
  const stats = { slices: 0, idr: 0, sps: 0, pps: 0, sei: 0 };
  let pos = 0;
  let seenIdr = false;

  while (pos + lengthSize <= sample.length) {
    const len = readLength(sample, pos, lengthSize);
    pos += lengthSize;
    if (len <= 0) {
      issues.push(issue('invalid_nal_length', sampleIndex, pos, `NAL 길이 0`));
      break;
    }
    if (pos + len > sample.length) {
      issues.push(issue('truncated_nal', sampleIndex, pos, `선언 ${len}B, 남은 ${sample.length - pos}B`));
      break;
    }
    const nalType = sample[pos] & 0x1f;
    nals.push({ type: nalType, name: NAL_NAMES[nalType] || `type ${nalType}`, offset: pos, size: len });
    if (nalType === 7) stats.sps += 1;
    if (nalType === 8) stats.pps += 1;
    if (nalType === 5) { stats.idr += 1; stats.slices += 1; seenIdr = true; }
    if (nalType === 1) stats.slices += 1;
    if (nalType === 6) stats.sei += 1;
    pos += len;
  }

  if (pos < sample.length) {
    issues.push(issue('trailing_bytes', sampleIndex, pos, `샘플 끝 ${sample.length - pos}B 잔여`));
  }
  if (nals.length === 0 && sample.length > 0) {
    issues.push(issue('empty_sample', sampleIndex, 0, 'NAL 유닛 없음'));
  }

  validateReferences(sampleIndex, isKeyframe, nals, issues);
  return { nals, issues, stats };
}

/**
 * Annex B(start code) 바이트 스트림에서 NAL을 스캔한다(mdat 폴백용).
 * @param {Buffer} chunk 바이트 청크
 * @param {number} baseOffset 파일 내 청크 시작 오프셋
 * @param {number} maxNals 최대 NAL 개수
 * @returns {{nals:Array<object>, issues:Array<object>}} 스캔 결과
 */
function scanAnnexB(chunk, baseOffset, maxNals) {
  const nals = [];
  const issues = [];
  let i = 0;
  while (i < chunk.length - 4 && nals.length < maxNals) {
    const sc = findStartCode(chunk, i);
    if (sc < 0) break;
    const nalStart = sc + startCodeLen(chunk, sc);
    const next = findStartCode(chunk, nalStart);
    const nalEnd = next >= 0 ? next : chunk.length;
    if (nalStart < nalEnd) {
      const nalType = chunk[nalStart] & 0x1f;
      nals.push({
        type: nalType,
        name: NAL_NAMES[nalType] || `type ${nalType}`,
        offset: baseOffset + nalStart,
        size: nalEnd - nalStart,
      });
    }
    i = nalEnd;
  }
  if (nals.length === 0 && chunk.length > 0) {
    issues.push({ code: 'no_start_code', offset: baseOffset, message: 'Annex B start code 미발견(AVCC일 수 있음)' });
  }
  return { nals, issues };
}

/**
 * 프레임 참조 관계를 검증한다(MP4 AVCC: SPS/PPS는 avcC에 있으므로 샘플 내 불필요).
 * @param {number} sampleIndex 샘플 번호
 * @param {boolean} isKeyframe 키프레임 여부
 * @param {Array<object>} nals NAL 목록
 * @param {Array<object>} issues 이슈 누적 배열
 * @returns {void}
 */
function validateReferences(sampleIndex, isKeyframe, nals, issues) {
  const hasSlice = nals.some((n) => n.type === 1 || n.type === 5);
  if (!hasSlice) return;

  const hasIdr = nals.some((n) => n.type === 5);
  const hasNonIdrSlice = nals.some((n) => n.type === 1);

  if (sampleIndex === 1 && !hasIdr && !isKeyframe && hasNonIdrSlice) {
    issues.push(issue('no_idr_start', sampleIndex, 0, '첫 샘플이 non-IDR 슬라이스 — SPS/PPS는 avcC에 있을 수 있음'));
  }
  if (isKeyframe && !hasIdr && hasSlice) {
    issues.push(issue('stss_without_idr', sampleIndex, 0, '키프레임 플래그인데 IDR(type 5) NAL 없음'));
  }
}

/**
 * 이슈 객체를 생성한다.
 * @param {string} code 이슈 코드
 * @param {number} sampleIndex 샘플 번호
 * @param {number} offset 오프셋
 * @param {string} message 설명
 * @returns {object} 이슈
 */
function issue(code, sampleIndex, offset, message) {
  return { code, sampleIndex, offset, message };
}

/**
 * length-prefixed NAL 길이를 읽는다.
 * @param {Buffer} buf 버퍼
 * @param {number} pos 위치
 * @param {number} lengthSize 길이 필드 크기
 * @returns {number} NAL 길이
 */
function readLength(buf, pos, lengthSize) {
  if (lengthSize === 1) return buf.readUInt8(pos);
  if (lengthSize === 2) return buf.readUInt16BE(pos);
  return buf.readUInt32BE(pos);
}

/**
 * Annex B start code 위치를 찾는다.
 * @param {Buffer} buf 버퍼
 * @param {number} from 검색 시작
 * @returns {number} 인덱스 또는 -1
 */
function findStartCode(buf, from) {
  for (let i = from; i < buf.length - 3; i += 1) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) return i;
      if (i + 3 < buf.length && buf[i + 2] === 0 && buf[i + 3] === 1) return i;
    }
  }
  return -1;
}

/**
 * start code 길이(3 또는 4)를 반환한다.
 * @param {Buffer} buf 버퍼
 * @param {number} pos start code 위치
 * @returns {number} 3 또는 4
 */
function startCodeLen(buf, pos) {
  return buf[pos + 2] === 1 ? 3 : 4;
}

module.exports = {
  analyzeAvccSample,
  scanAnnexB,
  NAL_NAMES,
};
