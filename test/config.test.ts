import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ConfigFileError,
	defaultConfig,
	leverIsEnabled,
	loadState,
	parseConfig,
	type RepoEntry,
	repoIsEnabled,
	resolvePaths,
	updateState,
} from "../src/config.js";
import { writeFileAtomic } from "../src/fs-atomic.js";
import { VERSION } from "../src/version.js";
import { isolatedEnv, makeTempDir, REPO_ROOT } from "./helpers.js";

describe("resolvePaths", () => {
	test("honours XDG_CONFIG_HOME and XDG_CACHE_HOME", () => {
		const paths = resolvePaths(
			{ HOME: "/h", XDG_CONFIG_HOME: "/x/config", XDG_CACHE_HOME: "/x/cache" },
			"linux",
		);
		expect(paths.configDir).toBe("/x/config/whittle");
		expect(paths.cacheDir).toBe("/x/cache/whittle");
		expect(paths.configFile).toBe("/x/config/whittle/config.json");
		expect(paths.logFile).toBe("/x/config/whittle/log/hooks.jsonl");
	});

	test("falls back to HOME when XDG variables are unset or relative", () => {
		const paths = resolvePaths({ HOME: "/h", XDG_CONFIG_HOME: "relative/config" }, "linux");
		expect(paths.configDir).toBe("/h/.config/whittle");
		expect(paths.cacheDir).toBe("/h/.cache/whittle");
	});

	test("WHITTLE_CONFIG_DIR overrides the config directory and leaves the cache alone", () => {
		const paths = resolvePaths({ HOME: "/h", WHITTLE_CONFIG_DIR: "/arm/control" }, "linux");
		expect(paths.configDir).toBe("/arm/control");
		expect(paths.reposFile).toBe("/arm/control/repos.json");
		expect(paths.cacheDir).toBe("/h/.cache/whittle");
	});

	test("uses APPDATA and LOCALAPPDATA on Windows", () => {
		const paths = resolvePaths(
			{
				USERPROFILE: "C:\\Users\\u",
				APPDATA: "C:\\Users\\u\\AppData\\Roaming",
				LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
			},
			"win32",
		);
		expect(paths.configDir).toBe("C:\\Users\\u\\AppData\\Roaming\\whittle");
		expect(paths.cacheDir).toBe("C:\\Users\\u\\AppData\\Local\\whittle\\cache");
	});
});

describe("parseConfig", () => {
	test("accepts a minimal document and fills defaults", () => {
		const parsed = parseConfig({ version: 1 });
		expect(parsed).toEqual({ kind: "ok", value: defaultConfig() });
	});

	test.each([
		[{ version: 2 }, "version must be 1"],
		[{ version: 1, repos: { default: "sometimes" } }, "repos.default"],
		[{ version: 1, levers: { "shell-output": { enabled: "yes" } } }, "enabled must be a boolean"],
		[{ version: 1, harnesses: { cursor: { enabled: true } } }, "unknown harness"],
		[[], "must be a JSON object"],
	])("rejects %j", (value, reason) => {
		const parsed = parseConfig(value);
		expect(parsed.kind).toBe("invalid");
		if (parsed.kind === "invalid") expect(parsed.reason).toContain(reason);
	});
});

describe("lever enablement", () => {
	const entry: RepoEntry = {
		root: "/r",
		commonDir: "/r/.git",
		remote: null,
		rootCommit: null,
		enabled: true,
		levers: { "shell-output": true },
		addedAt: "2026-09-14T00:00:00.000Z",
	};

	test("a repository override beats config, and config beats the lever default", () => {
		const config = {
			...defaultConfig(),
			levers: { "shell-output": { enabled: false }, "prefix-audit": { enabled: false } },
		};
		expect(leverIsEnabled("shell-output", false, config, entry)).toBe(true);
		expect(leverIsEnabled("prefix-audit", true, config, entry)).toBe(false);
		expect(leverIsEnabled("unlisted", true, defaultConfig(), entry)).toBe(true);
	});

	test("an unregistered repository follows repos.default", () => {
		expect(repoIsEnabled(defaultConfig(), undefined)).toBe(false);
		expect(repoIsEnabled({ ...defaultConfig(), repos: { default: "on" } }, undefined)).toBe(true);
		expect(repoIsEnabled(defaultConfig(), { ...entry, enabled: false })).toBe(false);
	});
});

describe("state files", () => {
	test("updateState writes atomically and leaves no temp files", async () => {
		const temp = makeTempDir("state");
		try {
			const paths = resolvePaths(isolatedEnv(temp.path));
			await updateState(paths, (state) => ({
				...state,
				installs: { "claude-code": { command: "'x'", version: "0", at: "now" } },
			}));
			const loaded = loadState(paths);
			expect(loaded.kind).toBe("ok");
			if (loaded.kind === "ok") expect(loaded.value.installs["claude-code"]?.command).toBe("'x'");
			expect(readdirSync(paths.configDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		} finally {
			temp.remove();
		}
	});

	test("an invalid state file is refused and left byte-identical", async () => {
		const temp = makeTempDir("state-invalid");
		try {
			const paths = resolvePaths(isolatedEnv(temp.path));
			mkdirSync(paths.configDir, { recursive: true });
			writeFileSync(paths.stateFile, "{ not json");
			await expect(updateState(paths, (state) => state)).rejects.toBeInstanceOf(ConfigFileError);
			expect(readFileSync(paths.stateFile, "utf8")).toBe("{ not json");
		} finally {
			temp.remove();
		}
	});

	test("a failed atomic write removes its temp file", () => {
		const temp = makeTempDir("atomic");
		try {
			const target = join(temp.path, "occupied");
			mkdirSync(target);
			expect(() => writeFileAtomic(target, "data")).toThrow();
			expect(readdirSync(temp.path)).toEqual(["occupied"]);
		} finally {
			temp.remove();
		}
	});
});

test("VERSION matches package.json", () => {
	const manifest: unknown = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
	expect(manifest).toMatchObject({ version: VERSION });
});
