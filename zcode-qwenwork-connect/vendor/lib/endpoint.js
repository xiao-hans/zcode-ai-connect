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
 * VPC 网关普遍使用企业内网自签证书（千问官方桌面 App 自身即以
 * NODE_TLS_REJECT_UNAUTHORIZED=0 运行——%APPDATA%\QwenWorkCN\logs\main.log
 * 有对应 WARN 记录）。宿主进程（DSH）无法注入 NODE_EXTRA_CA_CERTS，
 * 因此与官方 App 行为对齐：命中 VPC 端点时一次性放行 TLS 校验。
 *
 * 只在**进程启动早期、首次 fetch 之前**调用才可靠（undici 在建连时读
 * 该环境变量）。resolveGatewayEndpoint 的所有调用方都在模块加载 /
 * 首次请求前执行，满足该前提。
 *
 * @param {string} endpoint
 */
export function relaxTlsForVpc(endpoint) {
  if (isVpcEndpoint(endpoint) && process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
}
