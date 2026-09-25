import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "../src/config.js";
import type { NormalisedEvent } from "../src/hook/types.js";
import { describeHomeWrites } from "../src/levers/home-writes.js";
import {
	DEFAULT_ALLOW,
	matchesAllowlist,
	readAllowlist,
} from "../src/levers/shell-output/allowlist.js";
import { shellOutput } from "../src/levers/shell-output/descriptor.js";
import { shellOutputRuntime } from "../src/levers/shell-output/runtime.js";
import type { LeverContext } from "../src/levers/types.js";
import { isolatedEnv, makeTempDir } from "./helpers.js";

describe("allowlist", () => {
	test.each([
		["git status", true],
		["git status -s", true],
		["git diff --stat HEAD~1", true],
		["git log --oneline -5", true],
		["ls -la src", true],
		["grep -rn TODO src", true],
		["git status | head", false],
		["git status && ls", false],
		["git status; rm -rf build", false],
		["git log > log.txt", false],
		["grep foo < input.txt", false],
		["ls `pwd`", false],
		["ls $(pwd)", false],
		["git status &", false],
		["git status\nrm -rf build", false],
		["git statuses", false],
		["gitstatus", false],
		[" git status", false],
		["git status ", false],
		["git  status", false],
		["git push", false],
		["npm test", false],
		["rtk git status", false],
		["", false],
	])("%j → %p", (command, expected) => {
		expect(matchesAllowlist(command, DEFAULT_ALLOW)).toBe(expected);
	});

	test("configured entries that are not plain strings are dropped", () => {
		expect(readAllowlist({ allow: ["git status", 42, "ls | cat", " padded", "", "grep"] })).toEqual(
			["git status", "grep"],
		);
		expect(readAllowlist({ allow: "git status" })).toEqual([]);
		expect(readAllowlist({})).toEqual([]);
	});

	test("the default allowlist carries no test runner", () => {
		expect(DEFAULT_ALLOW.some((entry) => /test|jest|vitest|pytest|cargo/.test(entry))).toBe(false);
	});
});

describe("descriptor", () => {
	test("is off by default, enforces on Claude Code only, and labels the vendor number external", () => {
		expect(shellOutput.defaultEnabled).toBe(false);
		expect(shellOutput.harnesses["claude-code"]?.enforces).toBe(true);
		expect(shellOutput.harnesses.codex?.enforces).toBe(false);
		expect(shellOutput.external).toEqual([
			{ summary: "+7.6% cost", source: "JetBrains paired run, 80 tasks" },
		]);
	});

	test("states rtk's own ledger write instead of claiming zero home writes", () => {
		const [write] = shellOutput.homeWrites;
		expect(write?.by).toBe("rtk");
		expect(write?.path({ HOME: "/h", XDG_DATA_HOME: "/data" }, "linux")).toBe(
			"/data/rtk/history.db",
		);
		expect(write?.path({ HOME: "/h" }, "linux")).toBe("/h/.local/share/rtk/history.db");
		expect(
			write?.path({ HOME: "/h", XDG_DATA_HOME: "/data", RTK_DB_PATH: "/db/rtk.db" }, "linux"),
		).toBe("/db/rtk.db");
		expect(write?.path({ HOME: "/h", XDG_DATA_HOME: "relative" }, "linux")).toBe(
			"/h/.local/share/rtk/history.db",
		);
		expect(write?.path({ HOME: "/Users/u" }, "darwin")).toBe(
			"/Users/u/Library/Application Support/rtk/history.db",
		);
		expect(describeHomeWrites(shellOutput, { HOME: "/h" }, "linux")).toEqual([
			"rtk records each filtered command in /h/.local/share/rtk/history.db",
		]);
	});
});

describe("runtime", () => {
	function context(root: string, pathValue: string, logs: string[]): LeverContext {
		const env = { ...isolatedEnv(root), PATH: pathValue };
		return {
			options: { allow: [...DEFAULT_ALLOW] },
			env,
			paths: resolvePaths(env),
			repo: {
				root,
				gitDir: join(root, ".git"),
				commonDir: join(root, ".git"),
				repoId: "000000000000",
				worktreeId: "000000000000",
				linkedWorktree: false,
			},
			log: (message) => logs.push(message),
		};
	}

	function bash(command: string, sessionId = "session-a"): NormalisedEvent {
		return {
			event: "tool.pre",
			harness: "claude-code",
			sessionId,
			cwd: "/work",
			tool: { name: "Bash", input: { command }, output: null, editedFiles: [], command },
			prompt: null,
			transcriptPath: null,
			raw: {},
		};
	}

	test("prefixes an allowlisted command when rtk is on PATH", async () => {
		const temp = makeTempDir("rtk-present");
		try {
			const binDir = join(temp.path, "bin");
			mkdirSync(binDir);
			writeFileSync(join(binDir, "rtk"), "#!/bin/sh\necho rtk 0.0.0-test\n");
			chmodSync(join(binDir, "rtk"), 0o755);
			const logs: string[] = [];
			const output = await shellOutputRuntime.onEvent(
				bash("git status"),
				context(temp.path, binDir, logs),
			);
			expect(output).toEqual({ updatedInput: { command: "rtk git status" } });
			expect(
				await shellOutputRuntime.onEvent(
					bash("git status | head"),
					context(temp.path, binDir, logs),
				),
			).toBeNull();
			expect(logs).toEqual([]);
		} finally {
			temp.remove();
		}
	});

	test("does nothing without rtk and logs once per session", async () => {
		const temp = makeTempDir("rtk-absent");
		try {
			const emptyBin = join(temp.path, "empty-bin");
			mkdirSync(emptyBin);
			const logs: string[] = [];
			const ctx = context(temp.path, emptyBin, logs);
			expect(await shellOutputRuntime.onEvent(bash("git status"), ctx)).toBeNull();
			expect(await shellOutputRuntime.onEvent(bash("git diff"), ctx)).toBeNull();
			expect(logs).toHaveLength(1);
			expect(await shellOutputRuntime.onEvent(bash("git status", "session-b"), ctx)).toBeNull();
			expect(logs).toHaveLength(2);
		} finally {
			temp.remove();
		}
	});
});
