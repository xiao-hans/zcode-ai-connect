// install.js — Locate an installed Trae desktop app and read its own
// product.json as the authority on which edition, region and upstream hosts
// that installation actually talks to.
//
// Ported verbatim from dsh-trae-connect (MIT): the discovery behaviour is
// load-bearing — Trae ships its endpoints in `product.json`, so reading the
// installed app beats hard-coding hosts: a regional account, a mirror, or a
// future rename is picked up automatically, and nothing has to be guessed
// from the credential's domain.
//
// Facts this file is built on (verified 2026-10-08 on this machine):
//   intl  C:\Users\<u>\AppData\Local\Programs\Trae\resources\app\product.json
//         packageType=TRAE_I18N  nameAlias=TraeCode
//         bootConfig.remote.trae = {normal, SG, US, USTP}
//   cn    D:\Program Files\Trae CN\resources\app\product.json
//         packageType=TRAE_CN     nameAlias=TraeCode CN
//         bootConfig.remote.trae = {normal}
// The two product.json files contain duplicate keys and are large; parse with
// JSON.parse only (PowerShell's ConvertFrom-Json rejects them).

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Uninstall registry roots, short hive names, in probe order. */
const WINDOWS_UNINSTALL_ROOTS = [
	"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
	"HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
	"HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];
/** Per-step timeout and output ceiling for one discovery subprocess. */
const DISCOVERY_STEP_TIMEOUT_MS = 8_000;
const DISCOVERY_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Full path to reg.exe, or undefined when the environment cannot say. */
function windowsRegPath() {
	const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
	if (systemRoot === undefined || systemRoot === "") return undefined;
	return join(systemRoot, "System32", "reg.exe");
}

/**
 * Run one discovery subprocess and return its stdout, or throw.
 *
 * The shape is taken from dsh-workbuddy-connect's discovery tool, which is
 * known to work unattended: an async `execFile` with only `maxBuffer`,
 * `timeout` and `windowsHide` set. Two things it deliberately does NOT do,
 * both of which broke an earlier attempt at this file on 2026-10-08:
 *   - it does not pass a `stdio` array, because redirecting the child's
 *     handles there made the captured stdout come back empty;
 *   - it does not query subkeys one at a time. A recursive `reg query <root> /s`
 *     already prints every value, and per-subkey `/v` queries flood stderr
 *     with "value not found" errors for entries that simply lack the value.
 * Aborting the whole step (via `signal`) kills the child and rethrows.
 */
function runTool(bin, args, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(new Error(`${bin} was not started: the discovery budget was already spent`));
			return;
		}
		let settled = false;
		const child = execFile(bin, [...args], {
			encoding: "utf8",
			maxBuffer: DISCOVERY_MAX_OUTPUT_BYTES,
			timeout: DISCOVERY_STEP_TIMEOUT_MS,
			windowsHide: true,
		}, (error, stdout) => {
			if (settled) return;
			settled = true;
			if (error !== null && error !== undefined) {
				reject(new Error(`${bin} could not complete (${error.killed === true ? "timed out" : String(error.code ?? "unavailable")})`));
				return;
			}
			resolve(stdout);
		});
		const abort = () => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new Error(`${bin} was abandoned: the discovery budget was spent`));
		};
		signal?.addEventListener("abort", abort, { once: true });
		child.on("close", () => signal?.removeEventListener("abort", abort));
	});
}

/**
 * Read InstallLocation from every uninstall subkey that declares one.
 *
 * The Windows registry is read through a spawned `reg query` rather than a
 * native binding, to keep this plugin dependency-free. Two traps, both hit
 * and fixed on 2026-10-08:
 *   1. `reg` rejects the short hive names (`HKCU\…`) as "invalid key name" —
 *      it only accepts the long form (`HKEY_CURRENT_USER\…`).
 *   2. Redirecting the child's stdio explicitly makes the captured stdout
 *      come back empty, so the stdio option must be left alone.
 *   3. A recursive value search (`/s /f TraeCode`) rejects search strings that
 *      contain spaces, and every Trae display name has one — so subkeys are
 *      enumerated first and each is queried individually.
 */
async function windowsInstallLocations(signal) {
	const locations = [];
	for (const hive of WINDOWS_UNINSTALL_ROOTS) {
		const regPath = windowsRegPath();
		if (regPath === undefined) break;
		let listing;
		try {
			listing = await runTool(regPath, ["query", hive, "/s"], signal);
		} catch {
			continue; // hive absent, or the step was abandoned
		}
		// One recursive query already carries every value, so the subkey line
		// being scanned is tracked by hand: a location belongs to the key line
		// directly above it.
		let currentKey = "";
		for (const line of listing.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (/^(?:HKEY_[A-Z_]+|HK[A-Z]{2,4})\\/.test(trimmed)) {
				currentKey = trimmed;
				continue;
			}
			const match = /^\s*InstallLocation\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i.exec(line);
			if (match !== null) locations.push({ key: currentKey, location: match[1].trim() });
		}
	}
	return locations;
}

/** Path segments from an install root down to the app's product.json. */
const PRODUCT_JSON_RELATIVE = ["resources", "app", "product.json"];

/** Compiled-in fallbacks, used only when no installed app can be read. */
const FALLBACK_INSTALLS = {
	cn: { remoteBase: "https://trae-api-cn.mchost.guru/api/remote/v1", webOrigin: "https://work.trae.cn" },
	intl: { remoteBase: "https://core-normal.trae.ai/api/remote/v1", webOrigin: "https://work.trae.ai" },
};

/** Read a product.json and return its `bootConfig`, or undefined. */
function readProductJson(appRoot) {
	const path = join(appRoot, ...PRODUCT_JSON_RELATIVE);
	if (!existsSync(path)) return undefined;
	try {
		const document = JSON.parse(readFileSync(path, "utf8"));
		const boot = document?.bootConfig;
		if (boot === undefined || typeof boot !== "object") return undefined;
		return {
			path,
			packageType: document.packageType ?? "",
			nameAlias: document.nameAlias ?? "",
			version: document.version ?? "",
			date: document.date ?? "",
			remote: boot.remote?.trae ?? {},
			account: boot.account?.trae ?? {},
			agent: boot.agent?.trae ?? {},
			soloUrl: boot.soloUrl ?? "",
			consoleHost: boot.consoleHost ?? "",
		};
	} catch {
		// Truncated or unreadable product.json (an app mid-update): not fatal.
		return undefined;
	}
}

/** One directory that looks like a Trae install root. */
function looksLikeInstall(dir) {
	if (!existsSync(join(dir, ...PRODUCT_JSON_RELATIVE))) return false;
	// A bare resources/app/product.json could belong to any Electron app; the
	// Trae marker is one of these two fields being present with a Trae value.
	const info = readProductJson(dir);
	if (info === undefined) return false;
	return /^TRAE_/.test(info.packageType) || /^TraeCode/.test(info.nameAlias);
}

/**
 * Candidate install roots for the running platform, in probe order. Mirrors
 * dsh-workbuddy-connect's per-platform candidate tables: on Windows the real
 * roots come from the uninstall registry (user or machine scope, plus the
 * published per-user installer), so an install on any drive is found without
 * guessing directories; macOS and Linux use the conventional locations.
 *
 * Only the Windows branch is live-verified on this machine (2026-10-08, both
 * editions found — the domestic one lives on D:, which is exactly the case a
 * hard-coded C:-only fallback would miss); the macOS/Linux entries are the
 * documented conventions and are marked as such in the README.
 */
async function candidateInstallRoots(signal) {
	const home = homedir();
	if (process.platform === "darwin") {
		return ["/Applications/Trae.app", "/Applications/Trae CN.app", join(home, "Applications", "Trae.app")];
	}
	if (process.platform === "linux") {
		const dataHome = process.env.XDG_DATA_HOME?.startsWith("/") === true
			? process.env.XDG_DATA_HOME
			: join(home, ".local", "share");
		return [
			join(dataHome, "Trae"),
			join(dataHome, "trae"),
			join(dataHome, "Trae CN"),
			"/opt/Trae",
			"/opt/trae",
		].filter((dir) => existsSync(dir));
	}
	if (process.platform !== "win32") return [];

	// Windows: the uninstall registry is authoritative for "where was it put".
	const roots = [];
	const push = (value) => {
		const dir = String(value ?? "").trim().replace(/^"|"$/g, "");
		if (dir !== "" && !roots.includes(dir)) roots.push(dir);
	};
	for (const { location } of await windowsInstallLocations(signal)) push(location);
	// Published fallbacks, for installs that never wrote an uninstall entry.
	push(join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "Trae"));
	push(join(process.env.ProgramFiles ?? "C:\\Program Files", "Trae CN"));
	return roots;
}

/** Which edition a product.json describes, from its own declared fields. */
function editionOf(info) {
	if (/TRAE_CN/i.test(info.packageType)) return "cn";
	if (/TRAE_I18N/i.test(info.packageType)) return "intl";
	if (/CN/i.test(info.nameAlias)) return "cn";
	return "intl";
}

/**
 * Pick the host for an account region out of a product.json host table.
 * Trae's tables key by deployment region: `normal` is the default mirror,
 * `SG`/`US` are regional ones, and an unknown region falls back to `normal`
 * rather than to a host that may not serve that account.
 */
function hostForRegion(table, region) {
	if (table === undefined || table === null || typeof table !== "object") return undefined;
	const key = String(region ?? "").trim().toUpperCase();
	if (key !== "" && typeof table[key] === "string" && table[key] !== "") return table[key].trim();
	const normal = table.normal;
	return typeof normal === "string" && normal !== "" ? normal.trim() : undefined;
}

const installCache = new Map();

/**
 * Discover one edition's installed app and the upstream it talks to.
 *
 * `region` is the signed-in account's region (from the credential record),
 * because Trae selects the regional mirror per account, not per install.
 * Returns {edition, source, appRoot, appVersion, remoteBase, webOrigin,
 * consoleHost, accountHost}. Results are cached per edition and region: the
 * install layout cannot change while the plugin runs, and this is consulted on
 * every credential sweep, so the registry is only read on the first call.
 */
export async function detectInstall(edition, region, signal) {
	const cacheKey = `${edition}:${String(region ?? "").toUpperCase()}`;
	const cached = installCache.get(cacheKey);
	if (cached !== undefined) return cached;

	let detected;
	for (const root of await candidateInstallRoots(signal)) {
		if (!looksLikeInstall(root)) continue;
		const info = readProductJson(root);
		if (info === undefined || editionOf(info) !== edition) continue;
		const remoteBase = hostForRegion(info.remote, region);
		if (remoteBase === undefined) continue;
		detected = {
			edition,
			source: "product-json",
			appRoot: root,
			appVersion: info.version,
			remoteBase: `${remoteBase.replace(/\/+$/, "")}/api/remote/v1`,
			webOrigin: info.soloUrl === "" ? FALLBACK_INSTALLS[edition].webOrigin : info.soloUrl,
			consoleHost: info.consoleHost,
			accountHost: hostForRegion(info.account, region) ?? hostForRegion(info.account, undefined),
		};
		break;
	}

	// No readable install (headless host, uninstalled app, or a layout we have
	// not seen): fall back to the compiled-in hosts so the plugin still works.
	detected ??= {
		edition,
		source: "compiled-in",
		appRoot: undefined,
		appVersion: "",
		remoteBase: FALLBACK_INSTALLS[edition].remoteBase,
		webOrigin: FALLBACK_INSTALLS[edition].webOrigin,
		consoleHost: "",
		accountHost: undefined,
	};

	installCache.set(cacheKey, detected);
	return detected;
}

/** Candidate install roots with the ones that look like Trae flagged. */
export async function surveyInstalls(signal) {
	const found = [];
	for (const root of await candidateInstallRoots(signal)) {
		const info = readProductJson(root);
		found.push({
			root,
			exists: existsSync(root),
			isTrae: info !== undefined,
			edition: info === undefined ? undefined : editionOf(info),
			version: info?.version ?? "",
		});
	}
	return found;
}
