// credentials.js — Trae credential handling for zcode-trae-connect.
//
// Ported from dsh-trae-connect (MIT); the decryption and discovery behaviour
// is kept identical because it is what makes the endpoint work at all.
//
// The Trae desktop apps (VS Code forks, "iCube") store their sign-in inside
// `<APPDATA>/<data dir>/User/globalStorage/storage.json` under the
// `iCubeAuthInfo://icube.cloudide` key, encrypted with the "tc" envelope:
//
//   [6B header "tc\x05\x10\x00\x00"][32B random][AES-128-CBC ciphertext]
//   plaintext = [64B SHA-512 hash][PKCS7-padded JSON]
//   key/iv    = SHA-512(SHA-512(random) || SALT_A^SALT_B)[0..16]/[16..32]
//
// The salts are static constants baked into the app's frontend JS; the
// algorithm was documented by the MIT-licensed Trae2api-cn project
// (src/trae_decrypt.py) and is re-implemented here with node:crypto only.
//
// Edition discovery: the data directory name is NOT fixed. The domestic
// edition lives under `%APPDATA%\Trae CN` (tc-encrypted); the international
// edition uses `%APPDATA%\Trae` (tc-encrypted envelope under the same key —
// the CN decryption algorithm applies verbatim; live-verified 2026-10-08).
// TRAE SOLO adds `TRAE SOLO CN` / `TRAE SOLO`. discoverDesktopAuths() probes
// a per-platform table of DATA-directory roots (Windows: both AppData roots,
// Linux: both XDG bases plus the WSL-mounted Windows profile), tries the
// known directory names under each, and then still scans each root for any
// directory whose name contains "trae", so a renamed channel is still found.
// An explicit path (CLI flag or environment variable) always wins over the
// scan.
//
// Which edition a credential belongs to is decided by the INSTALLED app, not
// by the directory name: install.js reads each install root's product.json,
// whose `packageType` (TRAE_CN / TRAE_I18N) and bootConfig host tables say
// which upstream that build talks to. A credential whose `host` matches the
// host table of an installed app belongs to that app's edition. Only when no
// install can be read does classifyEdition()'s host/region/dir-name
// heuristic decide, so the plugin still works uninstalled or headless.
//
// Token renewal follows the same project's auth.py: POST
// `{host}/cloudide/api/v3/trae/oauth/ExchangeToken` with the refresh token
// and the fixed public ClientID.

import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir, release } from "node:os";

const SALT_A = Buffer.from([
	82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
	124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
	84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
	8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
]);
const SALT_B = Buffer.from([
	31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
	96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
	160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
	23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
]);

const STORAGE_KEY = "iCubeAuthInfo://icube.cloudide";
/** Fixed public client id Trae's own clients present at token exchange. */
const CLIENT_ID = "ono9krqynydwx5";
/** API/OAuth host for CN personal accounts (auth.py forces this for cn). */
const CN_API_HOST = "https://api.trae.cn";

/** Reminder shown when the scan finds no usable credential at all. */
export const SIGN_IN_HINT =
	"请确认 Trae 桌面程序已启动并登录过（扫描模型列表与路径期间需保持程序处于启动状态）；首次使用请先在 Trae 里完成一次登录";

function xorInto(a, b) {
	const out = Buffer.alloc(a.length);
	for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
	return out;
}

/** Decrypt one "tc" envelope into its plaintext JSON string. */
export function decryptStorageValue(base64Value) {
	const buffer = Buffer.from(base64Value, "base64");
	if (buffer.length < 38 + 64) throw new Error("trae-connect: tc envelope too short");
	const header = buffer.subarray(0, 6);
	const isTc = header[0] === 0x74 && header[1] === 0x63 &&
		header[2] === 0x05 && header[3] === 0x10 && header[4] === 0x00 && header[5] === 0x00;
	const isPrivate = header[0] === 18 && header[1] === 57 && header[2] === 32 &&
		header[3] === 32 && header[4] === 2 && header[5] === 3;
	if (!isTc && !isPrivate) {
		throw new Error(`trae-connect: unknown Trae encryption header ${header.toString("hex")}`);
	}
	const random = buffer.subarray(6, 38);
	const encrypted = buffer.subarray(38);
	const salt = isPrivate ? xorInto(SALT_A, SALT_B) : xorInto(SALT_A, SALT_B);
	const hashOfRandom = createHash("sha512").update(random).digest();
	const finalHash = createHash("sha512").update(Buffer.concat([hashOfRandom, salt])).digest();
	const key = finalHash.subarray(0, 16);
	const iv = finalHash.subarray(16, 32);
	const decipher = createDecipheriv("aes-128-cbc", key, iv);
	decipher.setAutoPadding(false);
	const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
	const storedHash = decrypted.subarray(0, 64);
	let body = decrypted.subarray(64);
	const pad = body[body.length - 1];
	if (pad >= 1 && pad <= 16 && body.length > pad) {
		let valid = true;
		for (let i = body.length - pad; i < body.length; i++) if (body[i] !== pad) { valid = false; break; }
		if (valid) body = body.subarray(0, body.length - pad);
	}
	const computed = createHash("sha512").update(body).digest();
	if (!storedHash.equals(computed)) throw new Error("trae-connect: Trae credential hash verification failed");
	return body.toString("utf8");
}

/**
 * Accept either a data directory (…/Trae CN) or a storage.json path and
 * return the storage.json path to read, or undefined for a blank value.
 */
function resolveStoragePath(rawPath) {
	const trimmed = String(rawPath ?? "").trim().replace(/^"|"$/g, "");
	if (trimmed === "") return undefined;
	if (/storage\.json$/i.test(trimmed)) return trimmed;
	return join(trimmed, "User", "globalStorage", "storage.json");
}

/** Read + decrypt one storage.json; undefined when it yields no valid token. */
function readStorageAuth(storagePath) {
	if (!existsSync(storagePath)) return undefined;
	try {
		const storage = JSON.parse(readFileSync(storagePath, "utf8"));
		const encrypted = storage?.[STORAGE_KEY];
		if (typeof encrypted !== "string" || encrypted.length === 0) return undefined;
		const trimmed = encrypted.trim();
		// Both editions use the tc envelope; plain JSON is kept as a
		// community-compat fallback.
		const plain = trimmed.startsWith("{")
			? trimmed
			: decryptStorageValue(trimmed);
		const auth = JSON.parse(plain);
		if (typeof auth?.token === "string" && auth.token.length > 0) return auth;
	} catch {
		// Not a Trae storage.json (or a foreign app sharing the prefix) — skip.
	}
	return undefined;
}

/**
 * Classify one decrypted desktop auth record as "cn" or "intl".
 *
 * This is now the FALLBACK path: the authoritative answer comes from the
 * installed app's product.json (see installEditionIndex / editionFromIndex
 * below), which is what makes the plugin correct on a machine whose edition
 * was renamed, re-branded or moved to another region. This heuristic is still
 * consulted when install.js cannot be loaded or no installed app declares a
 * host that matches the credential — an uninstalled / headless host, or a
 * build whose product.json we could not parse. Its inputs, in order of
 * trust: the auth record's own host / region fields (they point at the
 * upstream the app was signed into), then the directory name as a last
 * resort. Directory-name heuristics: "…CN…" suffixed dirs are domestic
 * ("Trae CN", "TRAE SOLO CN"), everything else ("Trae", "TRAE SOLO",
 * "Trae - Insiders", …) leans international.
 */
export function classifyEdition(dirName, auth) {
	const host = String(auth?.host ?? "");
	if (/trae\.ai|byteintl|growsg|coresg|coreva/i.test(host)) return "intl";
	if (/trae\.cn|mchost\.guru/i.test(host)) return "cn";
	const region = String(auth?.userRegion?.region ?? auth?.region ?? "").toUpperCase();
	if (region === "CN") return "cn";
	if (["SG", "US", "JP", "HK", "VA", "GLOBAL", "INTL"].includes(region)) return "intl";
	return /\bcn\b/i.test(dirName) ? "cn" : "intl";
}

/** Storage.json's location inside a Trae data directory. */
const STORAGE_RELATIVE = ["User", "globalStorage", "storage.json"];

/**
 * Data-directory NAMES Trae is known to use, per platform, in probe order.
 *
 * These are a fast path only: every one of them is also reachable through
 * the "name contains trae" scan below, so a name that is wrong here (or a
 * name added by a future channel release) costs nothing but a miss in the
 * explicit list. Verified 2026-10-08 on this machine for "Trae" and
 * "Trae CN" under %APPDATA%; the SOLO spellings come from the product's
 * published channel names and are unverified here, which is harmless because
 * the scan covers them anyway.
 */
const KNOWN_DATA_DIR_NAMES = {
	win32: ["Trae", "Trae CN", "Trae SOLO", "TRAE SOLO", "TRAE SOLO CN"],
	darwin: ["Trae", "Trae CN"],
	linux: ["Trae", "Trae CN", "trae", "trae-cn"],
};

/** Whether this Linux process is running inside Windows Subsystem for Linux. */
function isWsl() {
	if (process.platform !== "linux") return false;
	if (process.env.WSL_DISTRO_NAME !== undefined || process.env.WSL_INTEROP !== undefined) return true;
	try {
		return release().toLowerCase().includes("microsoft");
	} catch {
		return false;
	}
}

/**
 * Rewrite a Windows path to WSL's conventional `/mnt/<drive>/…` form, or
 * undefined when the value is not a Windows path.
 */
function windowsPathForWsl(value) {
	const path = value?.trim();
	if (path === undefined || path === "") return undefined;
	if (path.startsWith("/")) return path;
	const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path);
	if (drivePath === null) return undefined;
	return join("/mnt", drivePath[1].toLowerCase(), ...drivePath[2].split(/[\\/]+/u));
}

/**
 * DATA-directory candidates for the running platform, in probe order — the
 * dsh-workbuddy-connect approach, which exists because a single hard-coded
 * base silently reads a signed-in app as signed out:
 *   - Windows: current builds write under %LOCALAPPDATA%, older ones under
 *     %APPDATA% (Roaming). Both are probed, so either channel is found.
 *   - Linux: most distributions write under $XDG_CONFIG_HOME, some (UOS /
 *     deepin and friends) under $XDG_DATA_HOME. Both bases are probed.
 *   - WSL: the Trae desktop app runs on the Windows side, so its data lives
 *     under the mounted Windows profile; those paths are probed first, then
 *     the native Linux bases.
 *   - macOS: `~/Library/Application Support`, which is what VS Code forks
 *     (and therefore Trae) use on Darwin.
 * Returns directories (not storage.json paths) — the caller appends the
 * known data-directory names and, separately, runs the loose scan.
 */
function dataDirCandidates() {
	const home = homedir();
	if (process.platform === "darwin") return [join(home, "Library", "Application Support")];
	if (process.platform === "win32") {
		const roaming = process.env.APPDATA ?? join(home, "AppData", "Roaming");
		const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
		return [...new Set([roaming, local])];
	}
	if (process.platform === "linux") {
		const configHome = process.env.XDG_CONFIG_HOME?.trim()?.startsWith("/") === true
			? process.env.XDG_CONFIG_HOME.trim()
			: join(home, ".config");
		const dataHome = process.env.XDG_DATA_HOME?.trim()?.startsWith("/") === true
			? process.env.XDG_DATA_HOME.trim()
			: join(home, ".local", "share");
		const native = [configHome, dataHome];
		if (!isWsl()) return [...new Set(native)];
		// WSL: translate the Windows profile (USERPROFILE / APPDATA /
		// LOCALAPPDATA when the process inherited them) to /mnt/<drive>/…;
		// fall back to /mnt/c/Users/<linux user> when nothing is inherited.
		const profile = windowsPathForWsl(process.env.USERPROFILE) ?? join("/mnt/c/Users", basename(home));
		const local = windowsPathForWsl(process.env.LOCALAPPDATA) ?? join(profile, "AppData", "Local");
		const roaming = windowsPathForWsl(process.env.APPDATA) ?? join(profile, "AppData", "Roaming");
		return [...new Set([roaming, local, ...native])];
	}
	return [];
}

/** Hostname of a URL-ish string, lowercased; "" when there is none. */
function hostOf(value) {
	const text = String(value ?? "").trim().toLowerCase();
	if (text === "") return "";
	const withScheme = text.includes("://") ? text : `https://${text}`;
	try {
		return new URL(withScheme).hostname.toLowerCase();
	} catch {
		return text.replace(/^[a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].split(":")[0];
	}
}

/** Same hostname (registrable-ish: identical host, or one is a subdomain). */
function sameDomain(a, b) {
	const left = hostOf(a);
	const right = hostOf(b);
	if (left === "" || right === "") return false;
	if (left === right) return true;
	// api.trae.cn vs trae.cn, core-normal.trae.ai vs trae.ai: the app ships
	// service hosts, the credential carries the account host, and they differ
	// by one label more often than not.
	return left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

/**
 * Host values a product.json declares for one Trae build, flattened from its
 * `bootConfig.account.trae` and `bootConfig.remote.trae` tables. Both tables
 * are read because the credential's `host` may be either the account domain
 * (api.trae.cn / grow-normal.trae.ai) or the remote gate
 * (trae-api-cn.mchost.guru / core-normal.trae.ai), and which one appears
 * depends on the account's region. Same fields install.js reads.
 */
function installHostValues(bootConfig) {
	const values = [];
	const push = (table) => {
		if (table === undefined || table === null || typeof table !== "object") return;
		for (const value of Object.values(table)) if (typeof value === "string" && value.trim() !== "") values.push(value.trim());
	};
	push(bootConfig?.account?.trae);
	push(bootConfig?.remote?.trae);
	return values;
}

/**
 * Ask the INSTALLED apps which edition owns a credential.
 *
 * surveyInstalls() enumerates install roots; install.js reads each one's
 * product.json and reports {root, isTrae, edition}. For every Trae install
 * found we read its product.json host tables (account.trae + remote.trae)
 * and index them by hostname. A credential whose `host` matches an indexed
 * host belongs to that install, and that install's `packageType`
 * (TRAE_CN / TRAE_I18N) — carried through as its edition — is the answer.
 * This inverts the obvious circularity: you cannot call detectInstall(edition)
 * without already knowing the edition, so instead we match on the host FIRST
 * and read the edition off the install that matched.
 *
 * Returns [{edition, hosts}] or undefined for "no opinion" (install.js
 * absent/unloadable, survey failed, nothing installed) — the caller then
 * falls back to classifyEdition(). Measured 2026-10-08: the cn install
 * declares api.trae.cn / trae-api-cn.mchost.guru, the intl install declares
 * grow-normal.trae.ai / core-normal.trae.ai, and each real credential
 * matches exactly one of the two tables.
 */
async function installEditionIndex(signal) {
	let surveyInstalls;
	try {
		({ surveyInstalls } = await import("./install.js"));
	} catch {
		// install.js absent or unloadable (partial checkout): stay on the
		// heuristic path rather than failing the whole discovery.
		return undefined;
	}
	if (typeof surveyInstalls !== "function") return undefined;
	let installs = [];
	try {
		installs = await surveyInstalls(signal);
	} catch {
		return undefined;
	}
	if (!Array.isArray(installs) || installs.length === 0) return undefined;
	const index = [];
	for (const entry of installs) {
		if (entry?.isTrae !== true) continue;
		const edition = entry.edition === "cn" || entry.edition === "intl" ? entry.edition : undefined;
		if (edition === undefined) continue;
		let info;
		try {
			info = JSON.parse(readFileSync(join(entry.root, "resources", "app", "product.json"), "utf8"));
		} catch {
			continue; // vanished or unreadable since the survey; try the next.
		}
		const hosts = installHostValues(info?.bootConfig).map(hostOf).filter((host) => host !== "");
		if (hosts.length === 0) continue;
		index.push({ edition, hosts, root: entry.root });
	}
	return index.length === 0 ? undefined : index;
}

/** Cached survey index; the install layout cannot change between turns. */
let installIndexCache;
let installIndexAt = 0;
/**
 * Re-surveying shells out to `reg query /s` on Windows, and discovery runs on
 * every credential resolve, so the index is held for a minute. That keeps a
 * freshly installed edition visible within one sweep without paying the
 * registry sweep per resolve (2026-10-08).
 */
const INSTALL_INDEX_TTL_MS = 60_000;

async function cachedInstallEditionIndex(signal) {
	const now = Date.now();
	if (installIndexCache !== undefined && now - installIndexAt < INSTALL_INDEX_TTL_MS) return installIndexCache;
	const index = await installEditionIndex(signal);
	installIndexCache = index;
	installIndexAt = now;
	return index;
}

/** The edition of the installed app whose host table owns this credential. */
function editionFromIndex(index, auth) {
	const host = hostOf(auth?.host);
	if (index === undefined || host === "") return undefined;
	for (const { edition, hosts } of index) {
		for (const declared of hosts) if (sameDomain(host, declared)) return edition;
	}
	return undefined;
}

/** Install root behind an edition, for the startup log line; "" if unknown. */
function installRootFor(index, edition) {
	return index?.find((entry) => entry.edition === edition)?.root ?? "";
}

/**
 * Find every Trae desktop data directory worth trying and read the
 * storage.json of each that decrypts to a valid token. Explicit paths
 * (CLI flag / environment) are considered first and win over the scan
 * per edition.
 *
 * Candidates come from two places, both tried:
 *   1. the per-platform data-directory bases (dataDirCandidates) crossed
 *      with the known directory names — deterministic and cheap;
 *   2. a loose scan of each base for any child directory whose name
 *      contains "trae" (case-insensitive) — this is what survives a rename,
 *      a new channel or a third-party repackage, and it is why the name list
 *      above is a fast path rather than the source of truth.
 *
 * ASYNC: edition resolution consults the installed app (installEditionIndex),
 * which shells out to the Windows uninstall registry on first use, so it
 * cannot be done synchronously. Callers must await the result before reading
 * `results` (the service does: buildStores() in cli.js awaits one pass and
 * publishes the records into a cache the stores' sync `discover` callbacks
 * read).
 *
 * Returns { results, attempts, appData } where results.cn / results.intl
 * hold the first successful auth per edition ({...auth, _path, _edition})
 * and attempts is the per-candidate report used for startup logging.
 */
export async function discoverDesktopAuths({ logger, explicitCnPath, explicitIntlPath, quiet, signal } = {}) {
	const bases = dataDirCandidates();
	/** Back-compat field for callers/logs that named the old single root. */
	const appData = bases[0] ?? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"));
	const results = { cn: undefined, intl: undefined };
	const attempts = [];
	const seen = new Set();

	const consider = (rawPath, forcedEdition, origin) => {
		const storage = resolveStoragePath(rawPath);
		if (storage === undefined) return;
		const key = storage.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		// storage.json sits at <dataDir>/User/globalStorage/storage.json.
		attempts.push({
			storage,
			dir: basename(dirname(dirname(dirname(storage)))),
			edition: forcedEdition,
			origin,
			ok: false,
			resolved: undefined,
		});
	};

	if (typeof explicitCnPath === "string" && explicitCnPath.trim() !== "") consider(explicitCnPath, "cn", "explicit");
	if (typeof explicitIntlPath === "string" && explicitIntlPath.trim() !== "") consider(explicitIntlPath, "intl", "explicit");

	// (1) Known names under every platform base.
	const knownNames = KNOWN_DATA_DIR_NAMES[process.platform] ?? KNOWN_DATA_DIR_NAMES.linux;
	for (const base of bases) {
		for (const name of knownNames) consider(join(base, name), undefined, "known-name");
	}

	// (2) Loose scan under every platform base: any child whose name contains
	// "trae", regardless of case or channel suffix. A rename or a repackage
	// still turns up here, which is the whole point.
	for (const base of bases) {
		let entries = [];
		try {
			entries = readdirSync(base, { withFileTypes: true });
		} catch (error) {
			if (!quiet) logger?.warn?.(`zcode-trae-connect: cannot list ${base} while scanning for Trae data directories`, error);
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name.toLowerCase().includes("trae")) continue;
			consider(join(base, entry.name), undefined, "scan");
		}
	}

	// Decrypt first, then resolve editions — reading is the expensive part and
	// is synchronous, so every candidate is tried before the install survey.
	for (const attempt of attempts) {
		const auth = readStorageAuth(attempt.storage);
		if (auth === undefined) continue;
		attempt.ok = true;
		attempt.auth = auth;
	}
	const decrypted = attempts.filter((attempt) => attempt.ok === true && attempt.auth !== undefined);
	// One survey covers every candidate: the same host tables decide for all
	// of them, so this stays a single install.js call per sweep.
	const index = decrypted.length === 0 ? undefined : await cachedInstallEditionIndex(signal);
	for (const attempt of decrypted) {
		// An explicit path already names its edition, and only an unforced
		// candidate is worth a host lookup against the installed apps.
		const installed = attempt.edition === undefined && attempt.origin !== "explicit"
			? editionFromIndex(index, attempt.auth)
			: undefined;
		const edition = attempt.edition ?? installed ?? classifyEdition(attempt.dir, attempt.auth);
		attempt.resolved = edition;
		attempt.installed = installed;
		attempt.installRoot = installed === undefined ? undefined : installRootFor(index, installed);
		if (results[edition] === undefined) {
			results[edition] = { ...attempt.auth, _path: attempt.storage, _edition: edition };
		}
		delete attempt.auth; // the decrypted record itself never enters the report
	}

	if (!quiet) {
		if (attempts.length === 0) {
			logger?.info?.(`zcode-trae-connect: Trae 目录扫描 — ${bases.join("、") || appData} 下未发现 Trae* 数据目录`);
		} else {
			const detail = attempts
				.map((a) => a.ok ? `${a.dir} → ${a.resolved} 凭据可用（${a.storage}）` : `${a.dir} → 无可用凭据`)
				.join("；");
			logger?.info?.(`zcode-trae-connect: Trae 目录扫描（${attempts.length} 个候选，${bases.join("、")}）— ${detail}`);
			// Which installed app owned each credential, or "未安装/未读到安装" —
			// the difference between an authoritative and a guessed edition.
			const decided = attempts
				.filter((a) => a.ok === true && a.installed !== undefined)
				.map((a) => `${a.dir} → ${a.installed} 版（${a.installRoot}）`)
				.join("；");
			logger?.info?.(
				`zcode-trae-connect: Trae 版本判定 — ${decided === "" ? "未读到已安装 Trae 的 product.json，版本由凭据域名/目录名推断" : decided}`,
			);
		}
	}

	return { results, attempts, appData };
}

/**
 * Back-compat wrapper: the first usable domestic-edition desktop credential
 * (explicit path overrides the scan). Returns a Promise of
 * {...auth, _path} or undefined — async for the same reason as
 * discoverDesktopAuths.
 */
export async function readDesktopAuth(explicitPath) {
	return (await discoverDesktopAuths({ quiet: true, explicitCnPath: explicitPath })).results.cn;
}

/** Milliseconds until expiry; undefined when the record carries none. */
function expiresAtMs(auth) {
	const raw = String(auth?.expiredAt ?? "").trim();
	if (raw.length === 0) return undefined;
	const numeric = Number(raw);
	if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000;
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export class TraeCredentialStore {
	constructor(options = {}) {
		this.edition = options.edition ?? "cn";
		this.label = options.label ?? (this.edition === "cn" ? "Trae 国内版" : "Trae 国际版");
		const defaultCopy = this.edition === "cn" ? ".trae-credentials.json" : ".trae-credentials-intl.json";
		const home = process.env.ZCODE_TRAE_CONNECT_HOME ?? join(homedir(), ".zcode-trae-connect");
		this.path = options.path ?? join(home, defaultCopy);
		/** Optional override for the international ExchangeToken host. */
		this.refreshHost = typeof options.refreshHost === "string" && options.refreshHost.trim() !== ""
			? options.refreshHost.trim().replace(/\/+$/, "")
			: undefined;
		/** Desktop discovery callback: () => {...auth, _path}|undefined. */
		this.discover = options.discover ?? (this.edition === "cn"
			? () => readDesktopAuth()
			: () => undefined);
		this.logger = options.logger;
		/** @type {{auth: object, source: string}|undefined} */
		this.current = undefined;
		this.inflightRefresh = undefined;
	}

	/** Load whatever credential exists: plugin copy first, desktop fallback. */
	load() {
		if (existsSync(this.path)) {
			try {
				const saved = JSON.parse(readFileSync(this.path, "utf8"));
				if (typeof saved?.auth?.token === "string" && saved.auth.token.length > 0) {
					this.current = { auth: saved.auth, source: "plugin-copy" };
					return this.current;
				}
			} catch {
				// fall through to desktop discovery
			}
		}
		const desktop = this.discover();
		if (desktop !== undefined) {
			const { _path, _edition, ...auth } = desktop;
			this.current = { auth, source: "desktop" };
			this.persist();
		}
		return this.current;
	}

	persist() {
		if (this.current === undefined) return;
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			const temporary = `${this.path}.tmp`;
			writeFileSync(temporary, `${JSON.stringify({ version: 1, auth: this.current.auth }, null, 2)}\n`, { mode: 0o600 });
			renameSync(temporary, this.path);
		} catch (error) {
			this.logger?.warn?.("zcode-trae-connect: could not persist the plugin credential copy", error);
		}
	}

	/** The live credential, resolving the desktop app when nothing is held. */
	async resolve() {
		if (this.current === undefined) this.load();
		if (this.current === undefined) {
			throw new Error(`trae-connect: 未找到可用的 ${this.label} 登录凭据 — ${SIGN_IN_HINT}`);
		}
		// Follow the desktop app on every resolve: re-login or token rotation
		// in the desktop app must be picked up within one turn, not after a
		// restart. A failed read keeps the current credential — an unreadable
		// file is not proof of sign-out.
		{
			const desktop = this.discover();
			if (desktop !== undefined) {
				const { _path, _edition, ...auth } = desktop;
				if (auth.token !== this.current.auth.token) {
					this.current = { auth, source: "desktop" };
					this.persist();
				}
			}
		}
		await this.maybeRefresh();
		return this.current.auth;
	}

	async maybeRefresh() {
		const auth = this.current?.auth;
		if (auth === undefined) return;
		const expiry = expiresAtMs(auth);
		if (expiry === undefined || expiry - Date.now() > 30 * 60 * 1000) return;
		if (this.inflightRefresh !== undefined) return this.inflightRefresh;
		this.inflightRefresh = this.refresh(auth).finally(() => {
			this.inflightRefresh = undefined;
		});
		return this.inflightRefresh;
	}

	async refresh(auth) {
		const refreshToken = auth.refreshToken;
		if (typeof refreshToken !== "string" || refreshToken.length === 0) {
			this.logger?.warn?.("zcode-trae-connect: token near expiry but no refresh token; keeping the current token");
			return;
		}
		let host;
		if (this.edition === "cn") {
			host = typeof auth.host === "string" && auth.host.includes("api.trae") ? auth.host : CN_API_HOST;
		} else {
			// International: the desktop record's own host IS the auth domain
			// (live-verified 2026-10-08: intl credentials carry
			// growsg-normal.trae.ai — the ExchangeToken host, NOT the remote
			// gate; the official trae2api PROTOCOL.md records the same). It
			// therefore wins over the remoteBase-derived refreshHost override.
			host = (typeof auth.host === "string" && /trae\.(ai|cn)/i.test(auth.host)
				? auth.host
				: undefined) ?? this.refreshHost;
			if (host === undefined) {
				this.logger?.warn?.("zcode-trae-connect: 国际版令牌临近过期，但凭据记录未携带鉴权域名；跳过自动续期，沿用当前令牌");
				return;
			}
		}
		const url = `${host.replace(/\/+$/, "")}/cloudide/api/v3/trae/oauth/ExchangeToken`;
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					ClientID: CLIENT_ID,
					RefreshToken: refreshToken,
					ClientSecret: "-",
					UserID: auth.userId ?? "",
				}),
				signal: AbortSignal.timeout(30_000),
			});
			if (!response.ok) throw new Error(`http ${response.status}`);
			const payload = await response.json();
			const result = payload?.Result ?? payload?.result ?? {};
			const token = result.Token ?? result.token ?? "";
			if (token.length === 0) throw new Error("exchange returned no token");
			const next = {
				...auth,
				token,
				refreshToken: result.RefreshToken ?? result.refreshToken ?? refreshToken,
			};
			const expireRaw = result.TokenExpireAt ?? result.tokenExpireAt ?? "";
			if (expireRaw !== "") next.expiredAt = String(expireRaw);
			this.current = { auth: next, source: this.current.source };
			this.persist();
			this.logger?.info?.("zcode-trae-connect: Trae token refreshed");
		} catch (error) {
			this.logger?.warn?.("zcode-trae-connect: Trae token refresh failed; keeping the current token", error);
		}
	}

	/** Card status summary; never throws. */
	async status() {
		try {
			const auth = await this.resolve();
			const expiry = expiresAtMs(auth);
			return {
				state: "signed-in",
				edition: this.edition,
				userId: auth.userId ?? "",
				host: auth.host ?? "",
				...(expiry === undefined ? {} : { expiresAt: expiry }),
				source: this.current?.source,
			};
		} catch (error) {
			return { state: "signed-out", edition: this.edition, reason: String(error?.message ?? error).slice(0, 300) };
		}
	}

	/**
	 * Drop the held credential (desktop sign-out sweep): forget the in-memory
	 * copy and delete the plugin copy so the next resolve() re-reads the
	 * desktop state instead of resurrecting a stale token.
	 */
	forget() {
		this.current = undefined;
		this.inflightRefresh = undefined;
		try {
			if (existsSync(this.path)) unlinkSync(this.path);
		} catch (error) {
			this.logger?.warn?.("zcode-trae-connect: could not remove the plugin credential copy", error);
		}
	}
}
