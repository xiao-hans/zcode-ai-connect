/**
 * 网关端点解析（VPC 支持的核心）。
 *
 * ── 背景 ─────────────────────────────────────────────────────
 * 企业 VPC 租户（如 <tenant>.vpc.qwenwork.cn）的 access token 只在
 * **本租户的 VPC 网关**上有效；打公有云 gateway.qwenwork.cn 会得到
 * 401 INVALID_TOKEN（"token is invalid"），与登录态无关。
 *
 * 网关地址的可靠来源 = 凭据 access token（JWT）的 **iss claim**：
 *   - VPC 租户：iss = https://<tenant>.vpc.qwenwork.cn/realms/qwenwork
 *     → 网关 = https://<tenant>.vpc.qwenwork.cn（实测 200）；
 *   - 公有云租户：iss 落在公有云 Keycloak 域（不含 ".vpc."）→ 回落
 *     DEFAULT_ENDPOINT（公有云网关），行为与旧版完全一致。
 *
 * 实测依据（2026-10-23，企业 VPC 租户探针脚本，已清理）：
 *   - VPC /api/v1/adapter/user/account-context → 200（quota/plan 齐全）；
 *   - VPC /algo/api/v2/model/list?Encode=1（WASM 签名）→ 200 真实目录；
 *   - VPC /algo/.../agent_chat_generation（WASM 签名）→ 200 流式推理；
 *   - 同一 token 打公有云 → 401 INVALID_TOKEN。
 *
 * @module dsh-qwen-connect/endpoint
 */

/** 公有云网关（与 auth.js / signer-session.js 的缺省值保持一致）。 */
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { DEFAULT_BASE_URL } from './auth.js';

/** 企业 VPC 端点的判定标记：iss origin / 网关 origin 含此子域即视为 VPC。 */
export const VPC_MARKER = '.vpc.';

/**
 * 粗解 JWT payload（不改名、不校验签名——这里只读 iss）。
 * @param {string} token
 * @returns {object|null}
 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return typeof payload === 'object' && payload !== null ? payload : null;
  } catch {
    return null;
  }
}

/**
 * 从凭据派生网关端点。
 *
 * 规则：JWT iss 的 origin 若含 ".vpc." → 该租户网关；否则公有云缺省。
 * 解析失败 / 无 token → 公有云缺省（保持旧行为，绝不抛错——端点选择
 * 失败只应降级，不应打断登录链路）。
 *
 * @param {object|null} credential 归一化凭据（至少含 token）
 * @returns {string} 网关 origin（无尾斜杠）
 */
export function resolveGatewayEndpoint(credential) {
  const iss = decodeJwtPayload(credential?.token ?? '')?.iss ?? '';
  if (typeof iss === 'string' && iss.length > 0) {
    try {
      const origin = new URL(iss).origin;
      if (origin.startsWith('https://') && origin.includes(VPC_MARKER)) return origin;
    } catch {
      /* iss 不是合法 URL → 回落公有云 */
    }
  }
  return DEFAULT_BASE_URL;
}

/**
 * 是否企业 VPC 端点。
 * @param {string} endpoint
 */
export function isVpcEndpoint(endpoint) {
  return typeof endpoint === 'string' && endpoint.includes(VPC_MARKER);
}

/**
 * 只给这一跳 VPC HTTPS 关掉证书校验。keepAlive 关闭，避免测试进程被空闲套接字挂住。
 * 公有云和其他主机继续走全局 fetch，进程级 NODE_TLS_REJECT_UNAUTHORIZED 不动。
 */
const insecureAgent = new https.Agent({ keepAlive: false, rejectUnauthorized: false });

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade',
  'content-encoding', 'content-length',
]);

function headerRecord(headers) {
  const out = {};
  const list = new Headers(headers ?? {});
  for (const [key, value] of list) out[key] = value;
  return out;
}

function decodedBody(res) {
  const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
  if (encoding.includes('gzip')) return res.pipe(zlib.createGunzip());
  if (encoding.includes('deflate')) return res.pipe(zlib.createInflate());
  if (encoding.includes('br')) return res.pipe(zlib.createBrotliDecompress());
  return res;
}

function responseHeaders(res) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (HOP_BY_HOP.has(key) || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      try { headers.append(key, String(item)); } catch { /* fetch 禁止的头 */ }
    }
  }
  return headers;
}

/**
 * VPC 网关这一跳的 fetch。证书校验只在这次请求上放行，不改全局 dispatcher，
 * 也不碰 NODE_TLS_REJECT_UNAUTHORIZED。响应体按 content-encoding 解开，
 * 使调用方拿到的字节与全局 fetch 一致。
 *
 * @param {string | URL} url
 * @param {RequestInit} [init]
 */
export function fetchWithoutTlsVerify(url, init = {}) {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const transport = secure ? https : http;
  const signal = init.signal;
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted'));
  }
  const payload = init.body === undefined || init.body === null ? null : Buffer.from(init.body);
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: init.method ?? 'GET',
      headers: headerRecord(init.headers),
      agent: secure ? insecureAgent : undefined,
      rejectUnauthorized: false,
    }, (res) => {
      const stream = decodedBody(res);
      resolve(new Response(Readable.toWeb(stream), {
        status: res.statusCode ?? 0,
        headers: responseHeaders(res),
      }));
    });
    const fail = (error) => reject(error);
    req.on('error', fail);
    if (signal) {
      const onAbort = () => {
        req.destroy(signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }
    if (payload) req.end(payload);
    else req.end();
  });
}

/**
 * VPC 网关普遍使用企业内网自签证书。只返回这一跳要用的 fetch：
 * VPC 端点走 fetchWithoutTlsVerify，其余返回全局 fetch。
 * 不设置 NODE_TLS_REJECT_UNAUTHORIZED，进程里其他 HTTPS 仍校验证书。
 *
 * @param {string} endpoint
 * @returns {typeof fetch}
 */
export function relaxTlsForVpc(endpoint) {
  if (!isVpcEndpoint(endpoint)) return globalThis.fetch;
  return fetchWithoutTlsVerify;
}
