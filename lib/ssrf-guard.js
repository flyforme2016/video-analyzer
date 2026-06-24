'use strict';

const net = require('net');
const dns = require('dns');

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const ALLOWED_PORTS = parsePortAllowlist(process.env.SSRF_ALLOWED_PORTS);
const HOST_ALLOWLIST = parseHostAllowlist(process.env.SSRF_HOST_ALLOWLIST);

/**
 * SSRF 검증 실패를 나타내는 오류. HTTP 400 매핑용 statusCode를 가진다.
 */
class SsrfError extends Error {
  /**
   * @param {string} message 사용자에게 노출 가능한 사유
   */
  constructor(message) {
    super(message);
    this.name = 'SsrfError';
    this.statusCode = 400;
  }
}

/**
 * URL 문자열의 프로토콜/포트/호스트 allowlist를 동기 검증한다(DNS 조회 없음).
 * 리다이렉트 각 홉마다 호출해 형식 수준 우회를 막는다.
 * @param {unknown} value 검사할 URL 문자열
 * @returns {URL} 파싱된 URL 객체
 * @throws {SsrfError} 프로토콜/포트/호스트가 허용되지 않을 때
 */
function validateUrlSyntax(value) {
  if (typeof value !== 'string' || !value) {
    throw new SsrfError('유효한 http(s) URL이 필요합니다.');
  }
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new SsrfError('잘못된 URL 형식입니다.');
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new SsrfError('http/https 프로토콜만 허용됩니다.');
  }
  const port = effectivePort(url);
  if (ALLOWED_PORTS && !ALLOWED_PORTS.has(port)) {
    throw new SsrfError(`허용되지 않은 포트입니다: ${port}`);
  }
  if (HOST_ALLOWLIST && !isHostAllowed(url.hostname)) {
    throw new SsrfError('허용되지 않은 호스트입니다.');
  }
  return url;
}

/**
 * URL을 검증하고 호스트를 DNS 조회해 모든 결과 IP가 안전한지 확인한다.
 * ffprobe처럼 직접 URL을 여는 경로의 사전 점검용이다(연결 시점 고정은 아님).
 * @param {unknown} value 검사할 URL 문자열
 * @returns {Promise<URL>} 검증을 통과한 URL 객체
 * @throws {SsrfError} 형식 위반 또는 차단 IP로 해석될 때
 */
async function assertUrlAllowed(value) {
  const url = validateUrlSyntax(value);
  const literal = literalIp(url.hostname);
  if (literal) {
    if (isBlockedIp(literal)) throw new SsrfError('내부/예약 IP 주소로의 접근은 차단됩니다.');
    return url;
  }
  const addresses = await resolveAll(url.hostname);
  if (!addresses.length) throw new SsrfError('호스트를 확인할 수 없습니다.');
  for (const addr of addresses) {
    if (isBlockedIp(addr)) throw new SsrfError('내부/예약 IP 주소로의 접근은 차단됩니다.');
  }
  return url;
}

/**
 * http/https 요청 옵션에 넣을 안전한 lookup 함수를 만든다.
 * 실제 TCP 연결이 검증된 IP로만 향하게 해 DNS 리바인딩(TOCTOU)을 막는다.
 * @returns {(hostname: string, options: object, callback: Function) => void} dns.lookup 호환 함수
 */
function createSafeLookup() {
  return function safeLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options ? options : {};
    const literal = literalIp(hostname);
    if (literal) {
      if (isBlockedIp(literal)) {
        cb(new SsrfError('내부/예약 IP 주소로의 접근은 차단됩니다.'));
        return;
      }
      const family = net.isIP(literal);
      if (opts.all) cb(null, [{ address: literal, family }]);
      else cb(null, literal, family);
      return;
    }
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) {
        cb(err);
        return;
      }
      const safeList = addresses.filter((a) => a && a.address && !isBlockedIp(a.address));
      if (!safeList.length) {
        cb(new SsrfError('내부/예약 IP 주소로의 접근은 차단됩니다.'));
        return;
      }
      if (opts.all) {
        cb(null, safeList.map((a) => ({ address: a.address, family: a.family })));
      } else {
        cb(null, safeList[0].address, safeList[0].family);
      }
    });
  };
}

/**
 * 호스트명을 모든 IP(IPv4/IPv6)로 해석한다.
 * @param {string} hostname 호스트명
 * @returns {Promise<string[]>} 해석된 IP 주소 배열
 */
function resolveAll(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(new SsrfError('호스트를 확인할 수 없습니다.'));
      else resolve(addresses.map((a) => a.address));
    });
  });
}

/**
 * IP 주소가 차단 대상(사설/루프백/링크로컬/예약 등)인지 판정한다.
 * @param {string} ip 점검할 IP 주소
 * @returns {boolean} 차단해야 하면 true
 */
function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true;
}

/**
 * IPv4 주소가 차단 대역에 속하는지 검사한다.
 * @param {string} ip IPv4 문자열
 * @returns {boolean} 차단이면 true
 */
function isBlockedV4(ip) {
  const n = v4ToInt(ip);
  if (n == null) return true;
  return V4_BLOCKS.some(([base, bits]) => inCidr(n, base, bits));
}

/**
 * IPv6 주소가 차단 대상인지 검사한다(IPv4-mapped는 내부 v4로 환원).
 * @param {string} ip IPv6 문자열
 * @returns {boolean} 차단이면 true
 */
function isBlockedV6(ip) {
  const lower = ip.toLowerCase().split('%')[0];
  const mapped = extractMappedV4(lower);
  if (mapped) return isBlockedV4(mapped);
  if (lower === '::1' || lower === '::') return true;
  const head = v6FirstHextet(lower);
  if (head == null) return true;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (head === 0x2001 && v6SecondHextet(lower) === 0x0db8) return true; // 2001:db8::/32 doc
  return false;
}

/**
 * IPv6 문자열에서 IPv4-mapped/translated 주소를 추출한다.
 * @param {string} ip 소문자 IPv6
 * @returns {string|null} 내장 IPv4 또는 null
 */
function extractMappedV4(ip) {
  const m = /(?:::ffff:|::ffff:0:|64:ff9b::)((?:\d{1,3}\.){3}\d{1,3})$/.exec(ip);
  if (m) return m[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
  }
  return null;
}

/**
 * IPv4 점-십진 문자열을 32비트 정수로 변환한다.
 * @param {string} ip IPv4 문자열
 * @returns {number|null} 부호 없는 32비트 정수 또는 null
 */
function v4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

/**
 * 정수 IPv4가 CIDR 블록에 속하는지 검사한다.
 * @param {number} n 대상 IPv4 정수
 * @param {number} base 블록 시작 IPv4 정수
 * @param {number} bits 프리픽스 길이
 * @returns {boolean} 포함되면 true
 */
function inCidr(n, base, bits) {
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) === (base & mask);
}

/**
 * IPv6 첫 헥스텟을 정수로 반환한다.
 * @param {string} ip 소문자 IPv6
 * @returns {number|null} 첫 16비트 값 또는 null
 */
function v6FirstHextet(ip) {
  if (ip.startsWith('::')) return 0;
  const first = ip.split(':')[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return null;
  return parseInt(first, 16);
}

/**
 * IPv6 둘째 헥스텟을 정수로 반환한다(없으면 0).
 * @param {string} ip 소문자 IPv6
 * @returns {number} 둘째 16비트 값
 */
function v6SecondHextet(ip) {
  const parts = ip.split(':');
  if (parts.length < 2 || parts[1] === '') return 0;
  return /^[0-9a-f]{1,4}$/.test(parts[1]) ? parseInt(parts[1], 16) : 0;
}

/**
 * 호스트명이 IP 리터럴이면 그 IP를, 아니면 null을 반환한다.
 * @param {string} hostname URL hostname(대괄호 포함 가능)
 * @returns {string|null} IP 리터럴 또는 null
 */
function literalIp(hostname) {
  const h = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return net.isIP(h) ? h : null;
}

/**
 * URL의 실효 포트를 반환한다(미지정 시 프로토콜 기본값).
 * @param {URL} url URL 객체
 * @returns {number} 포트 번호
 */
function effectivePort(url) {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/**
 * 호스트가 allowlist에 포함되는지 검사한다(정확히 일치하거나 하위 도메인).
 * @param {string} hostname 호스트명
 * @returns {boolean} 허용되면 true
 */
function isHostAllowed(hostname) {
  const h = hostname.toLowerCase();
  return [...HOST_ALLOWLIST].some((allowed) => h === allowed || h.endsWith('.' + allowed));
}

/**
 * 포트 allowlist 환경변수를 파싱한다.
 * @param {string|undefined} raw 쉼표 구분 포트 목록
 * @returns {Set<number>|null} 포트 집합 또는 null(제한 없음)
 */
function parsePortAllowlist(raw) {
  if (!raw || !raw.trim()) return null;
  const ports = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return ports.length ? new Set(ports) : null;
}

/**
 * 호스트 allowlist 환경변수를 파싱한다.
 * @param {string|undefined} raw 쉼표 구분 호스트 목록
 * @returns {Set<string>|null} 호스트 집합 또는 null(제한 없음)
 */
function parseHostAllowlist(raw) {
  if (!raw || !raw.trim()) return null;
  const hosts = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return hosts.length ? new Set(hosts) : null;
}

const V4_BLOCKS = [
  [v4ToInt('0.0.0.0'), 8],
  [v4ToInt('10.0.0.0'), 8],
  [v4ToInt('100.64.0.0'), 10],
  [v4ToInt('127.0.0.0'), 8],
  [v4ToInt('169.254.0.0'), 16],
  [v4ToInt('172.16.0.0'), 12],
  [v4ToInt('192.0.0.0'), 24],
  [v4ToInt('192.0.2.0'), 24],
  [v4ToInt('192.168.0.0'), 16],
  [v4ToInt('198.18.0.0'), 15],
  [v4ToInt('198.51.100.0'), 24],
  [v4ToInt('203.0.113.0'), 24],
  [v4ToInt('224.0.0.0'), 4],
  [v4ToInt('240.0.0.0'), 4],
];

module.exports = {
  SsrfError,
  validateUrlSyntax,
  assertUrlAllowed,
  createSafeLookup,
  isBlockedIp,
};
