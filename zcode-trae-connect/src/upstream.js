// upstream.js — Trae remote-session protocol client for zcode-trae-connect.
//
// Ported from dsh-trae-connect (MIT). The protocol functions below are kept
// behaviour-identical — they are what makes the endpoint work at all — and
// `TraeUpstreamClient` at the bottom adapts them to the
// fetchModels / fetchCredits / chatStream contract the loopback endpoint
// expects (the same contract zcode-workbuddy-connect's server speaks).
//
// Endpoints follow the protocol Trae2api-cn documented (MIT) for the CN
// edition:
//   chat   POST {REMOTE}/chat_sessions  → {chat_session_id, message_id}
//          GET  {REMOTE}/chat_sessions/{id}/events?reply_to_message_id=...
//   models GET  {REMOTE}/models?functions=solo_agent_remote&show_custom_model=true
//   credits POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage
// Auth header: `Authorization: Cloud-IDE-JWT <token>` with web-client headers
// and Origin https://solo.trae.cn.
//
// International edition (live-verified 2026-10-08 against a real account):
// the remote gate is NOT a constant — it is per account region, taken from the
// app's own product.json `remote.trae` section (`{normal, SG, US, USTP}`; an
// SG account is served by coresg-normal.trae.ai, a US one by its own mirror).
// install.js reads the installed program and hands the answer to
// applyDetectedInstall() below, which remoteEndpointsFor() prefers over the
// compiled-in `core-normal.trae.ai` table (that mirror only happened to serve
// this machine's account). The web origin is product.json's soloUrl
// (https://work.trae.ai, used as Origin/Referer). The credential record's own
// host (growsg-normal.trae.ai) is the AUTH domain, NOT the remote gate — never
// use it as remoteBase.
// Auth requires BOTH headers at once: `Cloud-IDE-JWT: <token>` AND
// `Authorization: Cloud-IDE-JWT <token>`; either one alone returns 401.
// The intl models payload nests the roster one level deeper than CN:
// `{code:0, data:{list:[{function:"solo_agent", models:[…]}]}}` vs
// the CN `{data:[…]}` — the parser accepts both shapes. The intl catalog is
// fetched from the `solo_agent` bucket (the full per-account tier view, the
// same 19 entries the intl UI shows); CN keeps `solo_agent_remote`.

const REMOTE_BASE = "https://trae-api-cn.mchost.guru/api/remote/v1";
const REMOTE_ORIGIN = "https://solo.trae.cn";
const CREDITS_BASE = "https://api.trae.cn";
const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// Re-exported so cli.js has ONE import site for install discovery. The
// credentials/auth side of the protocol stays here; only "where is the app
// installed, and which mirror does it talk to" comes from install.js.
export { detectInstall } from "./install.js";
import { fetchSoloDirectory, llmChatStream, resolveLlmIdentity } from "./llm-utils.js";

/**
 * Per-edition remote-session endpoints. These are the LAST resort, not the
 * source of truth (2026-10-08): the remote gate is region-dependent, so the
 * live answer comes from applyDetectedInstall() and these constants only cover
 * the no-install / undetected case. A CLI flag / environment override still
 * beats everything.
 */
const REMOTE_ENV = {
	cn: {
		remoteBase: REMOTE_BASE,
		webOrigin: REMOTE_ORIGIN,
		userRegion: "CN",
		language: "zh-cn",
		scope: "marscode-cn",
		tenant: "marscode",
		region: "cn",
	},
	intl: {
		remoteBase: "https://core-normal.trae.ai/api/remote/v1",
		webOrigin: "https://work.trae.ai",
		userRegion: "SG",
		language: "en",
		scope: "marscode",
		tenant: "marscode",
		region: "sg",
	},
};

/**
 * Install-detected remote gate, per edition: {remoteBase} or undefined.
 *
 * Why: a Trae account is served by a regional mirror picked from product.json's
 * `remote.trae` table, so hard-coding the intl gate (core-normal) breaks any
 * account outside that mirror's region. Only the remote gate follows the
 * install — the web origin deliberately does NOT, because the values the
 * desktop client actually sends were live-verified per edition (cn really
 * presents solo.trae.cn, which differs from product.json's soloUrl) and
 * changing it on a detection signal would trade a verified header for an
 * unverified one. `undefined` means "no usable detection" — the compiled-in
 * table applies.
 */
const detectedRemoteByEdition = { cn: undefined, intl: undefined };

/**
 * Record one edition's install detection result (from install.js
 * detectInstall) for remoteEndpointsFor() to prefer. A missing install, or one
 * that fell back to compiled-in hosts, is stored as undefined so a stale
 * detection from a previous account can never outlive the reason for it.
 */
export function applyDetectedInstall(edition, install) {
	const remoteBase = String(install?.remoteBase ?? "").trim().replace(/\/+$/, "");
	const usable = install !== undefined && install !== null && install.source !== "compiled-in" && remoteBase !== "";
	detectedRemoteByEdition[edition] = usable ? { remoteBase } : undefined;
	return detectedRemoteByEdition[edition];
}

/**
 * Effective endpoints for one edition. Precedence is
 *   override (CLI flag / env) > detected (install.js) > compiled-in table.
 * The override stays on top so a user can always pin a host that the local
 * install does not (or does not yet) advertise; the compiled-in table stays last
 * so an undetected install still has something to talk to. Never throws;
 * callers check `remoteBase !== ""` before use.
 */
export function remoteEndpointsFor(edition, overrides = {}) {
	const base = REMOTE_ENV[edition] ?? REMOTE_ENV.cn;
	const overrideRemote = String(overrides.remoteBase ?? "").trim().replace(/\/+$/, "");
	const overrideOrigin = String(overrides.webOrigin ?? "").trim().replace(/\/+$/, "");
	const detectedRemote = String(detectedRemoteByEdition[edition]?.remoteBase ?? "").trim().replace(/\/+$/, "");
	return {
		...base,
		remoteBase: overrideRemote !== "" ? overrideRemote : detectedRemote !== "" ? detectedRemote : base.remoteBase,
		webOrigin: overrideOrigin !== "" ? overrideOrigin : base.webOrigin,
	};
}

/** Whether the environment overrides came from the process environment. */
export function environmentOverrides() {
	return {
		remoteBase: process.env.TRAE_INTL_REMOTE_BASE ?? "",
		webOrigin: process.env.TRAE_INTL_WEB_ORIGIN ?? "",
	};
}

/**
 * Fallback roster used only when the live catalog cannot be fetched (e.g. no
 * credential yet at startup). The live catalog from
 * GET /models?functions=solo_agent_remote&show_custom_model=true replaces
 * this list as soon as it is available, and is refreshed periodically, so
 * new upstream models appear without a plugin change.
 */
export const FALLBACK_MODELS = [
	{ id: "auto", name: "Trae Auto", contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "glm-5.3", name: "GLM-5.3", contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "glm-5.2", name: "GLM-5.2", contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "DeepSeek-V4-Flash-Official", name: "DeepSeek-V4-Flash 正式版", contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "kimi-k3", name: "Kimi-K3", contextWindow: 200_000, maxTokens: 64_000 },
];

/**
 * Live model catalog state, per edition. `currentModels(edition)` always
 * answers synchronously (the adapter builds model descriptors from it),
 * `refreshModels(token, signal, edition)` repopulates that edition's roster
 * from the upstream and returns the new list.
 */
const liveModelsByEdition = { cn: [...FALLBACK_MODELS], intl: [...FALLBACK_MODELS] };
const liveFetchedAtByEdition = { cn: 0, intl: 0 };
const MODEL_REFRESH_MS = 10 * 60 * 1000;

/**
 * Per-edition model-catalog bucket. intl uses `solo_agent` — live-verified
 * 2026-10-08: that bucket returns the FULL 19-model per-account roster (the
 * same list the intl UI shows), while `solo_agent_remote` returns a trimmed
 * 10-model subset. Locked models are flagged from their features data (see
 * modelLocked), never filtered, so the picker mirrors the real tier view.
 * CN stays on `solo_agent_remote` (16 fully-usable models, no lock concept).
 */
const CATALOG_FUNCTION = { cn: "solo_agent_remote", intl: "solo_agent" };

/**
 * Whether a catalog entry is locked for the current account tier.
 * Official criterion: `features.access.enable === true`. Reconciled on
 * 2026-10-08 across the 19 intl models against the desktop program's own
 * `restrictedModelKeys` (its ground truth in window1/renderer.log) — 19/19,
 * zero mismatches. The 8 locked ones (gpt-6-astra / gpt-6-sol / gpt-6-luna /
 * gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna / gpt-5.5 / glm-5.2) all carry
 * `access.enable: true`; the other 11 leave it undefined.
 * Superseded heuristic: `access.data.identity_list` contains 5 and NOT 0 —
 * wrong on gpt-6-sol and gpt-6-luna, whose identity_list is [4,1,2,3] (neither
 * 5 nor 0) while the program does consider them locked.
 * Recomputed from the latest catalog on every refresh, so a tier upgrade
 * flips the flag off on its own, with no code change.
 */
function modelLocked(info) {
	try {
		const feats = typeof info?.features === "string" ? JSON.parse(info.features) : info?.features;
		return feats?.access?.enable === true;
	} catch {
		return false;
	}
}

/**
 * Placeholder roster for an edition that never successfully fetched a live
 * catalog (e.g. intl without a configured/verified upstream). Same shape the
 * adapter used for the "intl installed but unconfigured" card state, kept in
 * one place so the two call sites cannot drift.
 */
export const INTL_PLACEHOLDER_MODELS = [
	{ id: "auto", name: "Trae Auto（未配置上游）", contextWindow: 200_000, maxTokens: 64_000 },
];

export function currentModels(edition = "cn") {
	// A live roster is only trusted after THIS edition actually fetched one.
	// An edition that never pulled a catalog must not silently inherit
	// another edition's roster (intl once leaked the CN list this way); the
	// static CN fallback table stays CN-only, and every other unfetched
	// edition gets the single placeholder.
	if (liveFetchedAtByEdition[edition] > 0) return liveModelsByEdition[edition];
	return edition === "cn" ? liveModelsByEdition.cn : INTL_PLACEHOLDER_MODELS;
}

/**
 * Discard one edition's live catalog (account switch / sign-out): the roster
 * falls back to the static table and "never fetched" semantics, so nothing
 * from the departing account is served while the next one is being pulled.
 */
export function resetLiveModels(edition = "cn") {
	liveModelsByEdition[edition] = [...FALLBACK_MODELS];
	liveFetchedAtByEdition[edition] = 0;
}

function catalogModel(info) {
	// Agent-tier context windows: dev = default, max = 1M when the model
	// declares max_mode. The descriptor publishes the default window and, for
	// max-mode models, `maxContextWindow` too — the adapter swaps the effective
	// window when the "use maximum context window" preference is on.
	const ctx = info?.context_window_tokens ?? {};
	// Live intl observation (2026-10-08): max may be 0, meaning the model has
	// no max tier at all — fall back to dev instead of publishing 0.
	const devWindow = Number(ctx.dev) > 0 ? Number(ctx.dev) : 200_000;
	const contextWindow = devWindow;
	const maxContextWindow = info?.max_mode === true && Number(ctx.max) > 0 ? Number(ctx.max) : undefined;
	const display = String(info?.display_name ?? info?.display_model_name ?? "").trim();
	const name = display !== "" ? display : String(info?.name ?? info?.config_name ?? "");
	// Thinking capability: the capability flag is `features.reasoning.enable`
	// inside the features JSON (string or object), verified true on 19/19 live
	// intl models. `reasoning_effort_config` is NOT the capability flag: on the
	// live intl catalog only kimi-k3 carries it, so keying thinking off it
	// marked the other 18 reasoning models as `reasoning: false`. Its
	// `options` list is still the most precise source when present (kimi-k3
	// declares light/high/extra_high), but it is optional — a capable model
	// without it falls back to Trae's online three-tier spelling. A model that
	// is not capable (or whose features JSON fails to parse) publishes no
	// efforts at all, so the descriptor still labels it `reasoning: false`;
	// this stays edition-agnostic, CN included.
	let reasoningCapable = false;
	let declaredEfforts = [];
	try {
		const feats = typeof info?.features === "string" ? JSON.parse(info.features) : info?.features;
		reasoningCapable = feats?.reasoning?.enable === true;
		const effortConfig = info?.reasoning_effort_config;
		if (reasoningCapable && Array.isArray(effortConfig?.options)) {
			declaredEfforts = effortConfig.options.filter((level) => typeof level === "string");
		}
	} catch {
		reasoningCapable = false;
		declaredEfforts = [];
	}
	const traeEfforts = !reasoningCapable
		? []
		: declaredEfforts.length > 0 ? declaredEfforts : ["light", "high", "extra_high"];
	// Consumption rate (credit multiplier) lives inside the features JSON,
	// which arrives as either a string or an object. CN declares
	// `consumption_rate.data.rate`; intl (live-verified 2026-10-08) declares
	// `cost.data.manual_usage` instead. A missing/disabled rate stays
	// undefined — never fabricate a number.
	let traeRate;
	try {
		const feats = typeof info?.features === "string" ? JSON.parse(info.features) : info?.features;
		const cnRate = feats?.consumption_rate;
		if (cnRate?.enable === true && Number.isFinite(Number(cnRate?.data?.rate))) traeRate = Number(cnRate.data.rate);
		if (traeRate === undefined && Number.isFinite(Number(feats?.cost?.data?.manual_usage))) {
			traeRate = Number(feats.cost.data.manual_usage);
		}
	} catch {}
	const locked = modelLocked(info);
	// Locked models show the lock badge instead of a credit multiplier: drop
	// the rate so no `· x1` suffix shows on top of it.
	if (locked) traeRate = undefined;
	// Display name: unlocked keeps the rate suffix logic (owned by the CLI's
	// modelLabel — nothing appended here); locked models drop the rate and show
	// the lock badge instead. Locked is recomputed from the live catalog on
	// every refresh, never cached or hard-coded.
	const displayName = locked ? `${name} · 🔒 未解锁` : name;
	return {
		id: String(info?.name ?? ""),
		name: displayName,
		...(locked ? { locked } : {}),
		contextWindow,
		...(maxContextWindow === undefined ? {} : { maxContextWindow }),
		...(traeEfforts.length === 0 ? {} : { traeEfforts }),
		...(traeRate === undefined ? {} : { traeRate }),
		maxTokens: 64_000,
		// The remote-session protocol is text-only as ported (flattenQuery
		// carries text blocks), so no image input is advertised.
		supportsImages: false,
		// Raw identity flags kept on the descriptor so createSession can build
		// the custom_model object verbatim for manual sessions.
		rawInfo: info,
	};
}

/** Whether a live catalog model runs in 1M max mode. */
export function isMaxModeModel(model) {
	return model?.maxContextWindow !== undefined && model.maxContextWindow > model.contextWindow;
}

/** Parse the model-list payload into a filtered roster (no side effects).
 * Two verified payload shapes are accepted:
 *   CN: `{data:[…models…]}` — the data field IS the model array;
 *   intl (2026-10-08): `{code:0, data:{list:[{function:"solo_agent",
 *   models:[…]}]}}` — the roster hides in data.list[].models, and the
 *   edition's own function bucket (CATALOG_FUNCTION) wins when several
 *   function groups come back. */
export function parseModelList(payload, functionBucket = "solo_agent_remote") {
	const data = payload?.data;
	let raw;
	if (Array.isArray(data)) {
		raw = data;
	} else {
		const groups = data?.list ?? [];
		const list = Array.isArray(groups) ? groups : [];
		// Prefer this edition's agent group; fall back to the first group
		// that actually carries models.
		const agentGroup = list.find(
			(group) => String(group?.function ?? group?.agent_type ?? "") === functionBucket,
		) ?? list.find((group) => Array.isArray(group?.models) && group.models.length > 0);
		raw = Array.isArray(agentGroup?.models) ? agentGroup.models : [];
	}
	const seen = new Set();
	const models = [{ id: "auto", name: "Trae Auto", contextWindow: 200_000, maxTokens: 64_000, supportsImages: false }];
	for (const info of raw) {
		// User-configured custom models (the user's own API endpoints) never
		// carry a consumption_rate and must not be offered here. Identify them
		// by their identity flags, NOT by the absence of a rate — a future
		// official model could temporarily lack rate data.
		if (info?.is_preset === false || info?.custom_model_id != null || Number(info?.config_source) === 3) continue;
		const model = catalogModel(info);
		if (model.id === "" || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return models;
}

/** Fetch the agent-tier catalog and replace the live roster for one edition. */
export async function refreshModels(token, signal, edition = "cn", overrides) {
	const endpoints = remoteEndpointsFor(edition, overrides);
	if (endpoints.remoteBase === "") {
		throw new Error(`trae model list: 未配置 ${edition === "intl" ? "国际版" : "国内版"} 上游地址`);
	}
	const functionBucket = CATALOG_FUNCTION[edition] ?? "solo_agent_remote";
	const url = `${endpoints.remoteBase}/models?functions=${encodeURIComponent(functionBucket)}&show_custom_model=true`;
	const response = await fetch(url, { headers: buildHeaders(token, edition, {}, endpoints), signal });
	if (!response.ok) throw new Error(`trae model list [${response.status}]`);
	const payload = await response.json();
	const models = parseModelList(payload, functionBucket);
	if (models.length <= 1) throw new Error("trae model list returned no models");
	liveModelsByEdition[edition] = models;
	liveFetchedAtByEdition[edition] = Date.now();
	return liveModelsByEdition[edition];
}

/** Refresh when the cached roster is older than the TTL; never throws. */
export async function refreshModelsIfStale(token, logger, edition = "cn", overrides) {
	if (Date.now() - liveFetchedAtByEdition[edition] < MODEL_REFRESH_MS) return currentModels(edition);
	try {
		return await refreshModels(token, undefined, edition, overrides);
	} catch (error) {
		if (liveFetchedAtByEdition[edition] === 0) {
			logger?.warn?.(`zcode-trae-connect: live catalog unavailable, serving the fallback roster (${String(error?.message ?? error).slice(0, 160)})`);
		}
		return currentModels(edition);
	}
}

function buildHeaders(token, edition, { stream = false } = {}, endpoints) {
	const env = endpoints ?? remoteEndpointsFor(edition);
	return {
		Authorization: `Cloud-IDE-JWT ${token}`,
		// intl (live-verified 2026-10-08) requires BOTH auth headers at once —
		// either one alone returns 401. CN keeps the single header it always
		// used (zero regression).
		...(edition === "intl" ? { "Cloud-IDE-JWT": token } : {}),
		"Content-Type": "application/json",
		"X-Trae-Client-Type": "web",
		"X-Preferenced-Language": edition === "intl" ? "en-US" : "zh-CN",
		"x-user-region": env.userRegion,
		Origin: env.webOrigin,
		Referer: `${env.webOrigin}/`,
		"User-Agent": BROWSER_UA,
		...(stream ? { Accept: "text/event-stream" } : {}),
	};
}

function commonParams(edition, mode, sessionId, endpoints) {
	const env = endpoints ?? remoteEndpointsFor(edition);
	return JSON.stringify({
		language: env.language,
		app_language: edition === "intl" ? "en-US" : "zh-CN",
		quality: "stable",
		app_version: "1.0.0.1229",
		web_id: "",
		user_identity: "Free",
		is_freshman: "0",
		biz_user_id: "",
		user_unique_id: "",
		scope: env.scope,
		tenant: env.tenant,
		region: env.region,
		aiRegion: env.region,
		is_privacy_mode: 0,
		privacy_mode: "off",
		solo_chat_mode: mode,
		...(sessionId ? { biz_session_id: sessionId } : {}),
	});
}

/** Flatten OpenAI messages into the query payload the remote session expects. */
export function flattenQuery(messages) {
	// One query block per message, conversation order preserved, no role
	// markers. Live-verified 2026-10-24: the remote runtime treats each text
	// block as its own message turn. The old shape (everything merged into a
	// single block with literal "[System]"/"[Assistant]" labels) made the
	// model read the caller's system prompt as quoted text and ignore it —
	// CANARY instruction-following failed 0/2 through /v1 and at the protocol
	// level, while per-message blocks pass CANARY and keep multi-turn
	// semantics (a system + user/assistant/user flow answers correctly).
	const blocks = [];
	for (const message of messages) {
		let content = message.content;
		if (Array.isArray(content)) {
			content = content
				.map((block) => (typeof block === "string" ? block : block?.text ?? ""))
				.join("\n");
		}
		if (content == null) content = "";
		blocks.push({ type: "text", data: { content } });
	}
	return JSON.stringify(blocks);
}

function modelSessionId(edition, model) {
	return `zcode-trae-${edition === "intl" ? "intl-" : ""}${model}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Remote model configs for manual selection, cached per edition. The upstream
// silently falls back to its default model when a manual session omits the
// complete model object, so a specific model id must resolve to its
// custom_model before createSession.
const modelConfigCacheByEdition = { cn: undefined, intl: undefined };
const modelConfigFetchedAtByEdition = { cn: 0, intl: 0 };
const MODEL_CONFIG_TTL_MS = 5 * 60 * 1000;

function buildModelConfig(raw) {
	const config = { ...raw };
	if (typeof config.features === "string") {
		try { config.features = JSON.parse(config.features); } catch { config.features = {}; }
	}
	const name = config.name ?? "";
	config.config_name = config.config_name ?? name;
	config.model_name = config.model_name ?? name;
	config.config_source = config.config_source ?? 1;
	config.provider = config.provider ?? "";
	config.multimodal = Boolean(config.multimodal);
	config.ak = config.ak ?? "";
	config.sk = config.sk ?? "";
	config.base_url = config.base_url ?? "";
	config.auth_type = config.auth_type ?? 0;
	config.use_remote_service = !config.client_connect;
	return config;
}

async function fetchModelConfig(token, edition, modelName, signal, overrides) {
	const now = Date.now();
	if (modelConfigCacheByEdition[edition] === undefined || now - modelConfigFetchedAtByEdition[edition] > MODEL_CONFIG_TTL_MS) {
		const endpoints = remoteEndpointsFor(edition, overrides);
		if (endpoints.remoteBase === "") throw new Error(`trae model list: 未配置 ${edition === "intl" ? "国际版" : "国内版"} 上游地址`);
		// Same bucket as refreshModels: the config cache must index the same
		// roster the picker shows (intl = solo_agent full tier view).
		const functionBucket = CATALOG_FUNCTION[edition] ?? "solo_agent_remote";
		const url = `${endpoints.remoteBase}/models?functions=${encodeURIComponent(functionBucket)}&show_custom_model=true`;
		const response = await fetch(url, { headers: buildHeaders(token, edition, {}, endpoints), signal });
		if (!response.ok) throw new Error(`trae model list [${response.status}]`);
		const payload = await response.json();
		const configs = {};
		// Same dual-shape tolerance as parseModelList: data is either the model
		// array itself (CN) or a {list:[{function, models:[…]}]} wrapper (intl).
		const data = payload?.data;
		const groups = Array.isArray(data) ? [{ models: data }] : (data?.list ?? []);
		for (const group of Array.isArray(groups) ? groups : []) {
			for (const raw of Array.isArray(group?.models) ? group.models : []) {
				const name = String(raw?.name ?? "").trim();
				if (name === "" || configs[name] !== undefined) continue;
				configs[name] = buildModelConfig(raw);
				// Case-insensitive alias so a picker id like "DeepSeek-V4.1-Flash"
				// (the display name) still resolves to config name deepseek-v4.1-flash.
				const display = String(raw?.display_name ?? "").trim();
				if (display !== "" && configs[display] === undefined) configs[display] = configs[name];
			}
		}
		modelConfigCacheByEdition[edition] = configs;
		modelConfigFetchedAtByEdition[edition] = now;
	}
	const cache = modelConfigCacheByEdition[edition] ?? {};
	const exact = cache[modelName];
	if (exact !== undefined) return exact;
	const lowered = modelName.toLowerCase();
	for (const [name, config] of Object.entries(cache)) {
		if (name.toLowerCase() === lowered) return config;
	}
	return undefined;
}

/** Create one remote chat session; returns {sessionId, messageId}.
 * `options.useMaximumContextWindow` pins a max-mode-capable model to its 1M
 * profile (mirrors the desktop client's max session fields). */
export async function createSession(token, model, messages, signal, options = {}, edition = "cn") {
	const endpoints = remoteEndpointsFor(edition, options.endpoints);
	if (endpoints.remoteBase === "") {
		throw new Error(`trae ${edition === "intl" ? "国际版" : "国内版"} 上游地址未配置`);
	}
	const mode = "code";
	const modelName = model === "auto" ? "" : model;
	const sessionId = modelSessionId(edition, model);
	const initialMessage = {
		chat_session_id: "",
		content: [],
		query: flattenQuery(messages),
		model_name: modelName,
		// Must match the edition's catalog bucket (CATALOG_FUNCTION): the
		// upstream resolves model configs by Function(=agent_type) +
		// ConfigName(=model_name), so a model registered in the intl
		// `solo_agent` bucket is invisible under `solo_agent_remote` and the
		// event stream fails with 4001 "config item is empty".
		agent_type: CATALOG_FUNCTION[edition] ?? "solo_agent_remote",
		agent_id: CATALOG_FUNCTION[edition] ?? "solo_agent_remote",
		model_selection_strategy: model === "auto" ? "auto" : "manual",
		common_params: commonParams(edition, mode, sessionId, endpoints),
	};
	if (model !== "auto") {
		const customModel = await fetchModelConfig(token, edition, model, signal, options.endpoints);
		if (customModel === undefined) throw new Error(`trae model "${model}" is not available for this account`);
		initialMessage.model_name = String(customModel.config_name ?? model);
		initialMessage.custom_model = customModel;
		// Reasoning effort: the picker sends the mapped wire spelling
		// (light/high/extra_high); stamp it on the model config like the
		// desktop client does. Invalid values are dropped, not clamped —
		// the catalog decides what a model may take.
		const requestedEffort = typeof options.reasoningEffort === "string" ? options.reasoningEffort : "";
		const declared = Array.isArray(customModel?.reasoning_effort_config?.options)
			? customModel.reasoning_effort_config.options
			: [];
		if (requestedEffort !== "" && (declared.length === 0 || declared.includes(requestedEffort))) {
			initialMessage.custom_model = {
				...customModel,
				reasoning_effort_level: requestedEffort,
			};
		}
		if (options.useMaximumContextWindow === true && customModel.max_mode === true) {
			const tokens = customModel.context_window_tokens ?? {};
			const maxContext = Number(tokens.max) > 0 ? Number(tokens.max) : 1_000_000;
			const promptMax = Number(customModel.prompt_max_tokens) > 0 ? Number(customModel.prompt_max_tokens) : 936_000;
			const outputMax = Number(customModel.max_tokens) > 0 ? Number(customModel.max_tokens) : 64_000;
			initialMessage.model_auto_selection = {
				strategy: "max",
				fallback_to_advance_model: null,
				entitlement_id: null,
			};
			initialMessage.model_selection_strategy = "max";
			initialMessage.mode_type = 1;
			initialMessage.context_window_size = maxContext;
			initialMessage.prompt_max_tokens = promptMax;
			initialMessage.max_tokens = outputMax;
		}
	}
	const body = {
		mode,
		environment_id: "default",
		initial_message: initialMessage,
		env: "remote",
		auto_create_project: false,
		origin: "web",
	};
	const response = await fetch(`${endpoints.remoteBase}/chat_sessions`, {
		method: "POST",
		headers: buildHeaders(token, edition, {}, endpoints),
		body: JSON.stringify(body),
		signal,
	});
	const text = await response.text();
	if (!response.ok) {
		let message = `trae create_session [${response.status}]: ${text.slice(0, 400)}`;
		// Locked models stay selectable (the roster mirrors the full tier
		// view), so the upstream rejects them here. Point at the tier upgrade
		// instead of the bare protocol error.
		if (edition === "intl" && text.includes("not available")) {
			message += "（该模型需升级 Trae 付费档后使用）";
		}
		throw new Error(message);
	}
	let payload;
	try { payload = JSON.parse(text); } catch { throw new Error(`trae create_session non-JSON: ${text.slice(0, 200)}`); }
	const data = payload?.data ?? payload ?? {};
	const chatSessionId = String(data.chat_session_id ?? "");
	const messageId = String(data.message_id ?? "");
	if (chatSessionId === "" || messageId === "") throw new Error(`trae create_session missing ids: ${text.slice(0, 200)}`);
	return { sessionId: chatSessionId, messageId };
}

/** Read one SSE frame stream; yields {event, data} objects until done. */
async function* readSse(response) {
	const decoder = new TextDecoder();
	let buffer = "";
	let eventName;
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				line = line.replace(/\r$/, "");
				if (line.startsWith(":")) continue;
				if (line.startsWith("event:")) { eventName = line.slice(6).trim(); continue; }
				if (line === "") { eventName = undefined; continue; }
				if (!line.startsWith("data:")) continue;
				const payload = line.slice(5).trim();
				if (payload === "[DONE]") return;
				let data;
				try { data = JSON.parse(payload); } catch { data = { _raw: payload }; }
				yield { event: eventName ?? String(data?.event ?? "message"), data };
				eventName = undefined;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Stream one turn: create the session, read the event stream, and yield
 * OpenAI-style deltas {type:'text'|'reasoning'|'usage'|'done', ...}.
 * `thought`/`reasoning_content` plan snapshots are cumulative; message text
 * events are snapshots too, so deltas are computed by diffing lengths.
 */
export async function* streamChat(token, model, messages, signal, options = {}, edition = "cn") {
	const { sessionId, messageId } = await createSession(token, model, messages, signal, options, edition);
	// Broadcast the remote session id BEFORE the event fetch: even if the
	// stream fails immediately, the consumer already holds the sessionId and
	// can clean the session up (即用即焚 delete).
	yield { type: "session", sessionId };
	const endpoints = remoteEndpointsFor(edition, options.endpoints);
	const url = `${endpoints.remoteBase}/chat_sessions/${sessionId}/events?reply_to_message_id=${encodeURIComponent(messageId)}`;
	const response = await fetch(url, { headers: buildHeaders(token, edition, { stream: true }, endpoints), signal });
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`trae events [${response.status}]: ${text.slice(0, 400)}`);
	}
	const thoughts = new Map();
	const contents = new Map();
	let sawTerminal = false;
	// Whether any content piece was already yielded: when the upstream closes
	// the event stream without a done frame after delivering text, the answer
	// is complete and must not be judged a failed turn.
	let emittedAny = false;
	try {
		for await (const { event, data } of readSse(response)) {
			const normalized = event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
			if (data && typeof data === "object" && (normalized === "error" || normalized === "response_error")) {
				throw new Error(`trae upstream error ${data.code ?? ""}: ${data.message ?? data.error ?? "unknown"}`);
			}
			if (normalized === "token_usage") {
				const usage = data?.usage ?? data;
				yield {
					type: "usage",
					input: Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0) || 0,
					output: Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0) || 0,
				};
				continue;
			}
			if (normalized === "plan_item") {
				const id = String(data?.id ?? "plan");
				// Remote plan snapshots grow `thought` (visible answer) and
				// `reasoning_content` (thinking) cumulatively, BUT the stream
				// also re-sends OLDER snapshots after newer ones (duplicate
				// frames out of order) and ends with a reset frame
				// (thought:"") once the answer was delivered. So: only accept
				// a snapshot that strictly extends the newest one seen; never
				// regress the stored value, and never re-emit.
				// Reasoning is diffed BEFORE the answer text: a client pins the
				// thinking panel at the first reasoning delta, so a frame that
				// advances both fields must yield thinking first.
				const reasoning = typeof data?.reasoning_content === "string" ? data.reasoning_content : "";
				const previousReasoning = thoughts.get(`r:${id}`) ?? "";
				if (reasoning.length > previousReasoning.length && reasoning.startsWith(previousReasoning)) {
					yield { type: "reasoning", text: reasoning.slice(previousReasoning.length) };
					emittedAny = true;
					thoughts.set(`r:${id}`, reasoning);
				}
				const thought = typeof data?.thought === "string" ? data.thought : "";
				const previousThought = thoughts.get(`t:${id}`) ?? "";
				if (thought.length > previousThought.length && thought.startsWith(previousThought)) {
					yield { type: "text", text: thought.slice(previousThought.length) };
					emittedAny = true;
					thoughts.set(`t:${id}`, thought);
				} else if (previousThought.length > 0 && thought.length === 0) {
					// Reset frame: the answer was already streamed; nothing to emit.
				}				const content = typeof data?.content === "string" ? data.content : "";
				if (content) {
					const previous = contents.get(id) ?? "";
					if (content.length > previous.length && content.startsWith(previous)) {
						yield { type: "text", text: content.slice(previous.length) };
						emittedAny = true;
						contents.set(id, content);
					} else if (content !== previous && !content.startsWith(previous)) {
						yield { type: "text", text: content };
						emittedAny = true;
						contents.set(id, content);
					}
				}
				continue;
			}
			if (["message", "assistant_message", "response", "text", "output"].includes(normalized)) {
				const nested = data?.message ?? data?.agent_message ?? data?.assistant_message ?? data;
				let text = nested?.content;
				if (Array.isArray(text)) text = text.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("");
				if (typeof text !== "string" || text.length === 0) text = typeof nested?.response === "string" ? nested.response : "";
				if (text) {
					const previous = contents.get("__msg__") ?? "";
					if (text.length > previous.length && text.startsWith(previous)) {
						yield { type: "text", text: text.slice(previous.length) };
						emittedAny = true;
						contents.set("__msg__", text);
					} else if (text !== previous) {
						yield { type: "text", text };
						emittedAny = true;
						contents.set("__msg__", text);
					}
				}
				continue;
			}
			if (normalized === "done" || normalized === "response_done" || normalized === "stream_done") {
				sawTerminal = true;
				break;
			}
		}
	} finally {
		response.body?.cancel?.().catch?.(() => {});
	}
	if (!sawTerminal && !emittedAny) throw new Error("trae events stream ended without a done event");
	yield { type: "done" };
}

/** Fetch the account's remaining credits (entitlement usage).
 * The credits endpoint is CN-verified (`https://api.trae.cn/…`). For the intl
 * edition the official credits host is UNKNOWN (unverified) and is NOT
 * guessed: callers must pass an explicit `creditsBase`, the call throws
 * otherwise. */
export async function fetchCredits(token, { edition = "cn", creditsBase } = {}) {
	const base = String(creditsBase ?? "").trim().replace(/\/+$/, "");
	if (base === "") {
		if (edition === "intl") throw new Error("国际版积分接口未配置（官方域名未经实测，请填写后使用）");
		return fetchCredits(token, { edition, creditsBase: CREDITS_BASE });
	}
	const url = `${base}/trae/api/v2/pay/ide_user_ent_usage`;
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Cloud-IDE-JWT ${token}`,
			"Content-Type": "application/json",
			"x-device-id": "0".repeat(16),
		},
		body: JSON.stringify({ require_usage: true, req_source: 1 }),
		signal: AbortSignal.timeout(30_000),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`trae credits [${response.status}]: ${text.slice(0, 300)}`);
	const payload = JSON.parse(text);
	return payload;
}

/** Best-effort deletion of one remote chat session (即用即焚). Fire-and-forget
 * use only: a failed delete must never fail the turn. */
export async function deleteSession(token, sessionId, edition = "cn", overrides) {
	if (typeof sessionId !== "string" || sessionId === "") return false;
	try {
		const endpoints = remoteEndpointsFor(edition, overrides);
		if (endpoints.remoteBase === "") return false;
		const response = await fetch(`${endpoints.remoteBase}/chat_sessions/${encodeURIComponent(sessionId)}`, {
			method: "DELETE",
			headers: buildHeaders(token, edition, {}, endpoints),
			signal: AbortSignal.timeout(15_000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Loopback-service adapter
// ---------------------------------------------------------------------------

/**
 * Map a Trae protocol failure onto the endpoint's error taxonomy.
 *
 * The upstream speaks plain `Error`s whose text carries the HTTP status
 * (`trae create_session [401]: …`) or a protocol code (`trae upstream error
 * 4001: …`). The endpoint needs a kind + status to answer with, so the text is
 * classified here — ordered so the specific patterns win over the generic
 * status sniffing.
 */
function classifyTraeError(error) {
	const message = String(error?.message ?? error).slice(0, 400);
	if (/not signed in|unauthor|expired|invalid token|token/i.test(message)) {
		return { kind: "session_dead", status: 401, message };
	}
	if (/\b429\b|rate|limit|throttl/i.test(message)) {
		return { kind: "soft_rate", status: 429, message };
	}
	if (/\b402\b|credit|quota|insufficient|entitlement/i.test(message)) {
		return { kind: "hard_credit", status: 402, message };
	}
	if (/not available for this account|locked|需升级|付费档/i.test(message)) {
		return { kind: "client", status: 400, message };
	}
	if (/\b404\b/.test(message)) return { kind: "not_found", status: 502, message };
	return { kind: "server", status: 502, message };
}

/**
 * Wrap the piece generator into a Web ReadableStream of OpenAI SSE bytes.
 *
 * The endpoint's SSE normalizer consumes exactly that shape, so heartbeats,
 * non-streaming reassembly and the `[DONE]` terminator all apply unchanged.
 * The upstream's `done` piece (or a spent generator) emits the finish frame;
 * the normalizer writes `[DONE]` itself, so none is written here.
 *
 * `first` carries the piece already pulled by the caller (the session
 * broadcast) so no event is lost between the eager first step and the stream.
 * `onDone` runs exactly once — normal end, error, or consumer cancel — which
 * is where the 即用即焚 session deletion fires.
 */
export function piecesToOpenAIStream(iterator, { model, first, onDone }) {
	const encoder = new TextEncoder();
	const id = `chatcmpl-trae-${Date.now().toString(36)}`;
	const created = Math.floor(Date.now() / 1000);
	let finished = false;
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		onDone?.();
	};
	const chunk = (delta, finishReason) => ({
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
	});
	const encode = value => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
	const chunkFor = piece => {
		if (piece?.type === "text") return chunk({ content: piece.text });
		if (piece?.type === "reasoning") return chunk({ reasoning_content: piece.text });
		if (piece?.type === "usage") {
			const input = Number(piece.input) || 0;
			const output = Number(piece.output) || 0;
			return {
				id,
				object: "chat.completion.chunk",
				created,
				model,
				choices: [],
				usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
			};
		}
		if (piece?.type === "done") {
			finished = true;
			return chunk({}, "stop");
		}
		return undefined; // the session broadcast never reaches the wire
	};
	return new ReadableStream({
		start(controller) {
			if (first !== undefined) {
				const encoded = chunkFor(first);
				if (encoded !== undefined) controller.enqueue(encode(encoded));
			}
		},
		async pull(controller) {
			try {
				for (;;) {
					const { done, value } = await iterator.next();
					if (done === true) {
						cleanup();
						if (!finished) controller.enqueue(encode(chunk({}, "stop")));
						controller.close();
						return;
					}
					const encoded = chunkFor(value);
					if (encoded !== undefined) {
						controller.enqueue(encode(encoded));
						return;
					}
					// A piece that maps to no chunk (the session broadcast, an
					// unknown event type) must not end the pull: a pull that
					// enqueues nothing is never followed by another one, so the
					// stream would stall forever with a live connection and no
					// bytes. Keep pulling until something actually lands.
				}
			} catch (error) {
				cleanup();
				controller.error(error);
			}
		},
		cancel() {
			cleanup();
			// Closing the generator runs its finally blocks — the SSE fetch
			// abort and any per-turn teardown — so a client that disconnects
			// mid-stream does not leave the upstream connection open.
			void iterator.return?.(undefined).catch(() => {});
		},
	});
}

/**
 * One edition's upstream, behind the interface the loopback endpoint speaks.
 *
 * The edition is fixed per instance: the two editions share model ids
 * (glm-5.3, kimi-k3, …) but bill against separate accounts, so one client
 * cannot serve both — the endpoint mounts them at different URL paths and
 * gives each mount its own client.
 */
export class TraeUpstreamClient {
	constructor({ edition = "cn", preferences = {}, logger = console, overrides = {} } = {}) {
		this.edition = edition;
		this.preferences = preferences;
		this.logger = logger;
		/** CLI-flag / environment endpoint overrides (intl remote gate, origin). */
		this.overrides = overrides ?? {};
		/** Provenance of the roster last fetched, mirroring the WorkBuddy client. */
		this.lastCatalog = { source: "fallback", fetchedAtMs: undefined };
		/** config_name → owning directory function, from the llm_utils_chat
		 * directory union. Null until the first directory fetch succeeds. */
		this.ownedFunctions = null;
	}

	/** Effective endpoints for this edition, honouring CLI/env overrides. */
	endpoints() {
		return remoteEndpointsFor(this.edition, this.overrides);
	}

	/** Pull the live roster for this edition; throws when unavailable.
	 *
	 * Preferred source: the llm_utils_chat directory union (one get_detail_param
	 * call per directory function, first function to publish a config_name owns
	 * it). That roster carries real roles + pending tool_calls on chat, which
	 * the chat_sessions path cannot offer. Falls back to the legacy
	 * chat_sessions catalog when the directory answers nothing. */
	async fetchModels(credential) {
		// Legacy chat_sessions catalog is still the best source for the max-mode
		// tier (max_mode + ctx.max): the llm directory under-reports it
		// (deepseek-v4.1-flash: dev 200000 here, yet a live 205000-token probe
		// was accepted on llm_utils_chat, and the legacy catalog declares
		// max 1000000). Advertise the maximum declared window per model.
		let legacyModels = null;
		try {
			legacyModels = await refreshModels(credential?.token ?? "", undefined, this.edition, this.endpoints());
		} catch (error) {
			this.logger?.warn?.(`[trae] legacy catalog failed: ${String(error).slice(0, 120)}`);
		}
		try {
			const { byId, failures } = await fetchSoloDirectory({
				token: credential?.token ?? "",
				userId: credential?.userId,
				baseUrl: this.endpoints().remoteBase,
			});
			if (byId.size > 0) {
				this.ownedFunctions = byId;
				const legacyById = new Map((legacyModels ?? []).map((m) => [m.id, m]));
				const models = [...byId.values()]
					.filter((entry) => entry.id !== "auto")
					.map((entry) => {
						const legacy = legacyById.get(entry.id);
						const maxContextWindow = Math.max(entry.maxContextWindow ?? 0, legacy?.maxContextWindow ?? 0) || undefined;
						return {
							id: entry.id,
							name: entry.name,
							contextWindow: maxContextWindow ?? entry.contextWindow ?? 200_000,
							maxContextWindow,
							maxTokens: entry.maxTokens ?? legacy?.maxTokens ?? 64_000,
							efforts: entry.efforts ?? [],
							traeEfforts: entry.efforts ?? [],
							ownedFunction: entry.ownedFunction,
							supportsImages: false,
							locked: false,
						};
					});
				this.lastCatalog = { source: "llm-directory", fetchedAtMs: Date.now() };
				return models;
			}
			if (failures.length > 0) this.logger?.warn?.(`[trae] llm directory empty: ${failures.join("; ")}`);
		} catch (error) {
			this.logger?.warn?.(`[trae] llm directory failed, falling back: ${String(error).slice(0, 140)}`);
		}
		// Legacy fallback (llm directory answered nothing): drop the internal
		// auto router entry — it is not a real model.
		const models = (legacyModels ?? await refreshModels(credential?.token ?? "", undefined, this.edition, this.endpoints()))
			.filter((model) => model.id !== "auto");
		this.ownedFunctions = null;
		this.lastCatalog = { source: "live", fetchedAtMs: Date.now() };
		return models;
	}

	/** Remaining credits; throws for intl without a configured credits host. */
	async fetchCredits(credential) {
		return fetchCredits(credential?.token ?? "", { edition: this.edition });
	}

	/**
	 * One chat turn as an OpenAI SSE byte stream.
	 *
	 * `prepared` is the raw request body the client sent (JSON). The session
	 * is created eagerly — the first generator step resolves only after
	 * `createSession` answers — so a locked model, an expired token or an
	 * upstream outage surfaces as a real HTTP error instead of a stream that
	 * dies after the headers went out.
	 */
	async chatStream(credential, prepared, signal) {
		const token = credential?.token ?? "";
		if (token === "") {
			return { ok: false, kind: "session_dead", status: 401, message: "no Trae credential resolved" };
		}
		let body;
		try {
			body = JSON.parse(prepared);
		} catch (error) {
			return { ok: false, kind: "client", status: 400, message: `invalid JSON body: ${String(error?.message ?? error)}` };
		}
		// Messages-based models are served by llm_utils_chat: the caller's
		// system prompt is honored as a real system message and pending
		// tool_calls stream back to the caller instead of being executed
		// inside Trae's cloud sandbox. Lazy directory fetch on first chat so
		// a fresh process routes correctly without waiting for a refresh.
		if (this.ownedFunctions === null) {
			try {
				await this.fetchModels(credential);
			} catch {}
		}
		const owned = typeof body?.model === "string" ? this.ownedFunctions?.get(body.model) : undefined;
		if (owned) {
			const identity = await resolveLlmIdentity();
			let result = await llmChatStream({
				credential: { token: credential?.token ?? "", userId: credential?.userId },
				identity,
				baseUrl: this.endpoints().remoteBase,
				openaiBody: body,
				ownedFunction: owned.ownedFunction,
				signal,
			});
			// 4001 = "config_name is not served by this function": the gateway
			// rotates models across directory functions, so a cached mapping
			// goes stale. Refresh the directory once and retry with the
			// function that owns the model NOW.
			if (!result.ok && result.status === 400 && /4001/.test(result.message ?? "")) {
				this.logger?.warn?.(`[trae] 4001 for ${body.model} under ${owned.ownedFunction} — refreshing the llm directory and retrying`);
				try {
					const refreshed = await this.fetchModels(credential);
					const fresh = this.ownedFunctions?.get(body.model);
					if (fresh && fresh.ownedFunction !== owned.ownedFunction) {
						result = await llmChatStream({
							credential: { token: credential?.token ?? "", userId: credential?.userId },
							identity,
							baseUrl: this.endpoints().remoteBase,
							openaiBody: body,
							ownedFunction: fresh.ownedFunction,
							signal,
						});
					} else if (refreshed.length > 0) {
						this.logger?.warn?.(`[trae] directory refreshed: ${body.model} still owned by ${fresh?.ownedFunction ?? "nobody"}`);
					}
				} catch (error) {
					this.logger?.warn?.(`[trae] directory refresh failed: ${String(error).slice(0, 140)}`);
				}
			}
			return result;
		}
		const model = typeof body?.model === "string" && body.model !== "" ? body.model : "auto";
		const messages = Array.isArray(body?.messages) ? body.messages : [];
		const options = {
			useMaximumContextWindow: this.preferences.useMaximumContextWindow?.() === true,
			...(typeof body?.reasoning_effort === "string" && body.reasoning_effort !== ""
				? { reasoningEffort: body.reasoning_effort }
				: {}),
			endpoints: this.endpoints(),
		};

		const iterator = streamChat(token, model, messages, signal, options, this.edition)[Symbol.asyncIterator]();
		let sessionId;
		let firstPiece;
		try {
			const first = await iterator.next();
			if (first.done === true) {
				return { ok: false, kind: "server", status: 502, message: "trae stream ended before the first event" };
			}
			if (first.value?.type === "session") sessionId = first.value.sessionId;
			else firstPiece = first.value;
		} catch (error) {
			// createSession failed (locked model, expired token, upstream
			// down): no remote session exists, so there is nothing to clean up.
			return { ok: false, ...classifyTraeError(error) };
		}

		const cleanup = () => {
			if (this.preferences.autoDeleteSession?.() === false) return;
			if (typeof sessionId !== "string" || sessionId === "") return;
			void deleteSession(token, sessionId, this.edition).catch(() => {});
		};
		const stream = piecesToOpenAIStream(iterator, { model, first: firstPiece, onDone: cleanup });
		return { ok: true, response: { body: stream } };
	}
}
