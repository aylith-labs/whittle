import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";
import { type HarnessId, isHarnessId } from "./hook/types.js";
import { isRecord, readJsonFile } from "./json.js";
import { withLock } from "./lock.js";

export type Env = Readonly<Record<string, string | undefined>>;

export type WhittlePaths = {
	configDir: string;
	cacheDir: string;
	configFile: string;
	reposFile: string;
	stateFile: string;
	logFile: string;
	locksDir: string;
	backupsDir: string;
	sessionsDir: string;
};

export type RepoDefault = "off" | "on";

export type LeverSettings = Record<string, unknown>;

export type WhittleConfig = {
	version: 1;
	harnesses: Partial<Record<HarnessId, { enabled: boolean }>>;
	repos: { default: RepoDefault };
	levers: Record<string, LeverSettings>;
};

export type RepoEntry = {
	root: string;
	commonDir: string;
	remote: string | null;
	rootCommit: string | null;
	enabled: boolean;
	levers: Record<string, boolean>;
	addedAt: string;
};

export type ReposFile = Record<string, RepoEntry>;

export type LedgerKind = "harness-hooks" | "config-file";

export type LedgerEntry = {
	path: string;
	kind: LedgerKind;
	harness: HarnessId | null;
	recordedAt: string;
};

export type HarnessFileRecord = {
	harness: HarnessId;
	path: string;
	existed: boolean;
	backupPath: string | null;
	backupSha256: string | null;
	createdKeys: string[];
	firstWriteAt: string;
};

export type InstallStamp = { command: string; version: string; at: string };

export type MeasurementSummary = {
	runId: string;
	costDeltaPct: number;
	n: number;
	task: string;
	at: string;
};

export type StateFile = {
	version: 1;
	installs: Partial<Record<HarnessId, InstallStamp>>;
	harnessFiles: Record<string, HarnessFileRecord>;
	ledger: LedgerEntry[];
	measurements: Record<string, MeasurementSummary>;
};

export type Parsed<T> = { kind: "ok"; value: T } | { kind: "invalid"; reason: string };

export type Loaded<T> =
	| { kind: "ok"; value: T; existed: boolean }
	| { kind: "invalid"; path: string; reason: string };

export class ConfigFileError extends Error {
	readonly path: string;

	constructor(path: string, reason: string) {
		super(`${path}: ${reason}`);
		this.path = path;
	}
}

function absoluteOrNull(value: string | undefined, platform: NodeJS.Platform): string | null {
	if (value === undefined || value === "") return null;
	const pathApi = platform === "win32" ? win32 : posix;
	return pathApi.isAbsolute(value) ? value : null;
}

export function homeDirectory(env: Env, platform: NodeJS.Platform = process.platform): string {
	return (
		absoluteOrNull(env.HOME, platform) ?? absoluteOrNull(env.USERPROFILE, platform) ?? homedir()
	);
}

export function resolvePaths(env: Env, platform: NodeJS.Platform = process.platform): WhittlePaths {
	const pathApi = platform === "win32" ? win32 : posix;
	const home = homeDirectory(env, platform);
	const appData = platform === "win32" ? absoluteOrNull(env.APPDATA, platform) : null;
	const localAppData = platform === "win32" ? absoluteOrNull(env.LOCALAPPDATA, platform) : null;
	const configDir =
		absoluteOrNull(env.WHITTLE_CONFIG_DIR, platform) ??
		(appData !== null
			? pathApi.join(appData, "whittle")
			: pathApi.join(
					absoluteOrNull(env.XDG_CONFIG_HOME, platform) ?? pathApi.join(home, ".config"),
					"whittle",
				));
	const cacheDir =
		localAppData !== null
			? pathApi.join(localAppData, "whittle", "cache")
			: pathApi.join(
					absoluteOrNull(env.XDG_CACHE_HOME, platform) ?? pathApi.join(home, ".cache"),
					"whittle",
				);
	return {
		configDir,
		cacheDir,
		configFile: pathApi.join(configDir, "config.json"),
		reposFile: pathApi.join(configDir, "repos.json"),
		stateFile: pathApi.join(configDir, "state.json"),
		logFile: pathApi.join(configDir, "log", "hooks.jsonl"),
		locksDir: pathApi.join(configDir, "locks"),
		backupsDir: pathApi.join(configDir, "backups"),
		sessionsDir: pathApi.join(cacheDir, "sessions"),
	};
}

export function defaultConfig(): WhittleConfig {
	return { version: 1, harnesses: {}, repos: { default: "off" }, levers: {} };
}

export function emptyState(): StateFile {
	return { version: 1, installs: {}, harnessFiles: {}, ledger: [], measurements: {} };
}

function invalid<T>(reason: string): Parsed<T> {
	return { kind: "invalid", reason };
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

export function parseConfig(value: unknown): Parsed<WhittleConfig> {
	if (!isRecord(value)) return invalid("must be a JSON object");
	if (value.version !== 1)
		return invalid(`version must be 1, got ${JSON.stringify(value.version)}`);
	const config = defaultConfig();
	const harnesses = value.harnesses;
	if (harnesses !== undefined) {
		if (!isRecord(harnesses)) return invalid("harnesses must be an object");
		for (const [id, settings] of Object.entries(harnesses)) {
			if (!isHarnessId(id)) return invalid(`harnesses: unknown harness "${id}"`);
			if (!isRecord(settings) || typeof settings.enabled !== "boolean") {
				return invalid(`harnesses.${id}.enabled must be a boolean`);
			}
			config.harnesses[id] = { enabled: settings.enabled };
		}
	}
	const repos = value.repos;
	if (repos !== undefined) {
		const repoDefault = isRecord(repos) ? repos.default : undefined;
		if (repoDefault !== "off" && repoDefault !== "on") {
			return invalid('repos.default must be "off" or "on"');
		}
		config.repos.default = repoDefault;
	}
	const levers = value.levers;
	if (levers !== undefined) {
		if (!isRecord(levers)) return invalid("levers must be an object");
		for (const [id, settings] of Object.entries(levers)) {
			if (!isRecord(settings)) return invalid(`levers.${id} must be an object`);
			if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") {
				return invalid(`levers.${id}.enabled must be a boolean`);
			}
			config.levers[id] = settings;
		}
	}
	return { kind: "ok", value: config };
}

function parseRepoEntry(id: string, value: unknown): Parsed<RepoEntry> {
	if (!isRecord(value)) return invalid(`${id} must be an object`);
	const { root, commonDir, remote, rootCommit, enabled, levers, addedAt } = value;
	if (typeof root !== "string" || typeof commonDir !== "string" || typeof addedAt !== "string") {
		return invalid(`${id}: root, commonDir and addedAt must be strings`);
	}
	if (!isNullableString(remote) || !isNullableString(rootCommit)) {
		return invalid(`${id}: remote and rootCommit must be strings or null`);
	}
	if (typeof enabled !== "boolean") return invalid(`${id}.enabled must be a boolean`);
	if (!isRecord(levers)) return invalid(`${id}.levers must be an object`);
	const overrides: Record<string, boolean> = {};
	for (const [leverId, flag] of Object.entries(levers)) {
		if (typeof flag !== "boolean") return invalid(`${id}.levers.${leverId} must be a boolean`);
		overrides[leverId] = flag;
	}
	return {
		kind: "ok",
		value: { root, commonDir, remote, rootCommit, enabled, levers: overrides, addedAt },
	};
}

export function parseRepos(value: unknown): Parsed<ReposFile> {
	if (!isRecord(value)) return invalid("must be a JSON object");
	const repos: ReposFile = {};
	for (const [id, entry] of Object.entries(value)) {
		const parsed = parseRepoEntry(id, entry);
		if (parsed.kind === "invalid") return parsed;
		repos[id] = parsed.value;
	}
	return { kind: "ok", value: repos };
}

function parseLedgerEntry(value: unknown): LedgerEntry | null {
	if (!isRecord(value)) return null;
	const { path, kind, harness, recordedAt } = value;
	if (typeof path !== "string" || typeof recordedAt !== "string") return null;
	if (kind !== "harness-hooks" && kind !== "config-file") return null;
	if (harness !== null && !(typeof harness === "string" && isHarnessId(harness))) return null;
	return { path, kind, harness, recordedAt };
}

function parseHarnessFileRecord(value: unknown): HarnessFileRecord | null {
	if (!isRecord(value)) return null;
	const { harness, path, existed, backupPath, backupSha256, createdKeys, firstWriteAt } = value;
	if (typeof harness !== "string" || !isHarnessId(harness)) return null;
	if (typeof path !== "string" || typeof existed !== "boolean") return null;
	if (!isNullableString(backupPath) || !isNullableString(backupSha256)) return null;
	if (!isStringArray(createdKeys) || typeof firstWriteAt !== "string") return null;
	return { harness, path, existed, backupPath, backupSha256, createdKeys, firstWriteAt };
}

function parseMeasurement(value: unknown): MeasurementSummary | null {
	if (!isRecord(value)) return null;
	const { runId, costDeltaPct, n, task, at } = value;
	if (typeof runId !== "string" || typeof task !== "string" || typeof at !== "string") return null;
	if (typeof costDeltaPct !== "number" || !Number.isFinite(costDeltaPct)) return null;
	if (typeof n !== "number" || !Number.isInteger(n)) return null;
	return { runId, costDeltaPct, n, task, at };
}

function parseInstallStamp(value: unknown): InstallStamp | null {
	if (!isRecord(value)) return null;
	const { command, version, at } = value;
	if (typeof command !== "string" || typeof version !== "string" || typeof at !== "string") {
		return null;
	}
	return { command, version, at };
}

export function parseState(value: unknown): Parsed<StateFile> {
	if (!isRecord(value)) return invalid("must be a JSON object");
	if (value.version !== 1)
		return invalid(`version must be 1, got ${JSON.stringify(value.version)}`);
	const state = emptyState();
	const { installs, harnessFiles, ledger, measurements } = value;
	if (!isRecord(installs) || !isRecord(harnessFiles) || !isRecord(measurements)) {
		return invalid("installs, harnessFiles and measurements must be objects");
	}
	if (!Array.isArray(ledger)) return invalid("ledger must be an array");
	for (const [id, stamp] of Object.entries(installs)) {
		const parsed = parseInstallStamp(stamp);
		if (!isHarnessId(id) || parsed === null) return invalid(`installs.${id} is malformed`);
		state.installs[id] = parsed;
	}
	for (const [path, record] of Object.entries(harnessFiles)) {
		const parsed = parseHarnessFileRecord(record);
		if (parsed === null) return invalid(`harnessFiles["${path}"] is malformed`);
		state.harnessFiles[path] = parsed;
	}
	for (const [index, entry] of ledger.entries()) {
		const parsed = parseLedgerEntry(entry);
		if (parsed === null) return invalid(`ledger[${index}] is malformed`);
		state.ledger.push(parsed);
	}
	for (const [leverId, summary] of Object.entries(measurements)) {
		const parsed = parseMeasurement(summary);
		if (parsed === null) return invalid(`measurements.${leverId} is malformed`);
		state.measurements[leverId] = parsed;
	}
	return { kind: "ok", value: state };
}

function load<T>(path: string, parse: (value: unknown) => Parsed<T>, fallback: () => T): Loaded<T> {
	const read = readJsonFile(path);
	switch (read.kind) {
		case "missing":
			return { kind: "ok", value: fallback(), existed: false };
		case "unreadable":
		case "invalid":
			return { kind: "invalid", path, reason: read.reason };
		case "ok": {
			const parsed = parse(read.value);
			return parsed.kind === "ok"
				? { kind: "ok", value: parsed.value, existed: true }
				: { kind: "invalid", path, reason: parsed.reason };
		}
	}
}

export function loadConfig(paths: WhittlePaths): Loaded<WhittleConfig> {
	return load(paths.configFile, parseConfig, defaultConfig);
}

export function loadRepos(paths: WhittlePaths): Loaded<ReposFile> {
	return load(paths.reposFile, parseRepos, () => ({}));
}

export function loadState(paths: WhittlePaths): Loaded<StateFile> {
	return load(paths.stateFile, parseState, emptyState);
}

export function orThrow<T>(loaded: Loaded<T>): T {
	if (loaded.kind === "invalid") throw new ConfigFileError(loaded.path, loaded.reason);
	return loaded.value;
}

export function serialiseJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

async function updateFile<T>(
	paths: WhittlePaths,
	path: string,
	mode: number,
	loader: (paths: WhittlePaths) => Loaded<T>,
	mutate: (current: T) => T,
): Promise<T> {
	const lockName = `${path.slice(paths.configDir.length + 1).replaceAll(/[\\/]/g, "_")}.lock`;
	return withLock(join(paths.locksDir, lockName), () => {
		const next = mutate(orThrow(loader(paths)));
		writeFileAtomic(path, serialiseJson(next), mode);
		return next;
	});
}

export function updateRepos(
	paths: WhittlePaths,
	mutate: (repos: ReposFile) => ReposFile,
): Promise<ReposFile> {
	return updateFile(paths, paths.reposFile, 0o600, loadRepos, mutate);
}

export function updateState(
	paths: WhittlePaths,
	mutate: (state: StateFile) => StateFile,
): Promise<StateFile> {
	return updateFile(paths, paths.stateFile, 0o600, loadState, mutate);
}

export async function ensureConfigFile(
	paths: WhittlePaths,
	initial: WhittleConfig,
): Promise<"created" | "existing"> {
	return withLock(join(paths.locksDir, "config.json.lock"), () => {
		const loaded = loadConfig(paths);
		if (loaded.kind === "invalid") throw new ConfigFileError(loaded.path, loaded.reason);
		if (loaded.existed) return "existing";
		writeFileAtomic(paths.configFile, serialiseJson(initial), 0o644);
		return "created";
	});
}

export function repoIsEnabled(config: WhittleConfig, entry: RepoEntry | undefined): boolean {
	return entry === undefined ? config.repos.default === "on" : entry.enabled;
}

export function leverIsEnabled(
	leverId: string,
	defaultEnabled: boolean,
	config: WhittleConfig,
	entry: RepoEntry | undefined,
): boolean {
	const override = entry?.levers[leverId];
	if (override !== undefined) return override;
	const configured = config.levers[leverId]?.enabled;
	return typeof configured === "boolean" ? configured : defaultEnabled;
}
