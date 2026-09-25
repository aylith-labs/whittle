import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { resolvePaths, updateRepos, type WhittlePaths } from "../src/config.js";
import { type DispatchDeps, runHook } from "../src/hook/dispatch.js";
import { readStdinBounded, type StdinRead } from "../src/hook/io.js";
import type { LeverOutput } from "../src/hook/types.js";
import type { LeverDescriptor, LeverRuntime } from "../src/levers/types.js";
import { findRepo } from "../src/repo.js";
import { initRepo, isolatedEnv, makeTempDir, type TempDir } from "./helpers.js";

type Fixture = { temp: TempDir; env: Record<string, string>; repoDir: string; paths: WhittlePaths };

let fixture: Fixture;

beforeEach(async () => {
	const temp = makeTempDir("dispatch");
	const env = isolatedEnv(temp.path);
	const repoDir = join(temp.path, "repo");
	initRepo(repoDir, env);
	fixture = { temp, env, repoDir, paths: resolvePaths(env) };
});

afterEach(() => {
	fixture.temp.remove();
});

async function enableRepo(levers: Record<string, boolean> = {}): Promise<void> {
	const lookup = findRepo(fixture.repoDir);
	if (lookup.kind !== "found") throw new Error("fixture repo not found");
	const { repo } = lookup;
	await updateRepos(fixture.paths, (repos) => ({
		...repos,
		[repo.repoId]: {
			root: repo.root,
			commonDir: repo.commonDir,
			remote: null,
			rootCommit: null,
			enabled: true,
			levers,
			addedAt: "2026-09-14T00:00:00.000Z",
		},
	}));
}

function lever(
	id: string,
	onEvent: LeverRuntime["onEvent"],
	overrides: Partial<LeverDescriptor> = {},
): LeverDescriptor {
	return {
		id,
		layers: ["L3"],
		shape: "hook",
		defaultEnabled: true,
		harnesses: { "claude-code": { enforces: true } },
		dependency: null,
		events: ["tool.pre"],
		capMs: {},
		defaultOptions: {},
		external: [],
		homeWrites: [],
		commands: [],
		load: async () => ({ onEvent }),
		...overrides,
	};
}

function bashPayload(command: string): string {
	return JSON.stringify({
		session_id: "session-1",
		transcript_path: join(fixture.temp.path, "transcript.jsonl"),
		cwd: fixture.repoDir,
		permission_mode: "default",
		hook_event_name: "PreToolUse",
		tool_name: "Bash",
		tool_input: { command, description: "Show working tree status", timeout: 120000 },
	});
}

async function dispatchWith(
	levers: readonly LeverDescriptor[],
	stdin: string | StdinRead,
	args: readonly string[] = ["PreToolUse", "--harness", "claude-code"],
): Promise<{ exitCode: number; stdout: string }> {
	let stdout = "";
	const deps: DispatchDeps = {
		env: fixture.env,
		cwd: fixture.repoDir,
		readStdin: async () => (typeof stdin === "string" ? { kind: "ok", text: stdin } : stdin),
		writeStdout: (text) => {
			stdout += text;
		},
		loadLevers: async () => levers,
		now: () => new Date("2026-09-14T00:00:00.000Z"),
	};
	const exitCode = await runHook(args, deps);
	return { exitCode, stdout };
}

function logRecords(): Record<string, unknown>[] {
	try {
		return readFileSync(fixture.paths.logFile, "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

const rewrite = async (): Promise<LeverOutput> => ({ updatedInput: { command: "rtk git status" } });

describe("runHook", () => {
	test("an unregistered repository produces no output, no log and exit 0", async () => {
		let ran = false;
		const result = await dispatchWith(
			[
				lever("probe", async () => {
					ran = true;
					return null;
				}),
			],
			bashPayload("git status"),
		);
		expect(result).toEqual({ exitCode: 0, stdout: "" });
		expect(ran).toBe(false);
		expect(logRecords()).toEqual([]);
	});

	test("a throwing lever fails open with exactly one log line", async () => {
		await enableRepo();
		const result = await dispatchWith(
			[
				lever("boom", async () => {
					throw new Error("kaboom");
				}),
			],
			bashPayload("git status"),
		);
		expect(result).toEqual({ exitCode: 0, stdout: "" });
		const records = logRecords();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			level: "error",
			lever: "boom",
			event: "PreToolUse",
			harness: "claude-code",
		});
		expect(String(records[0]?.message)).toContain("kaboom");
	});

	test("a lever that overruns its cap is abandoned and logged", async () => {
		await enableRepo();
		const started = Date.now();
		const hang = lever("slow", () => new Promise<null>(() => {}), { capMs: { "tool.pre": 20 } });
		const result = await dispatchWith([hang], bashPayload("git status"));
		expect(Date.now() - started).toBeLessThan(2000);
		expect(result).toEqual({ exitCode: 0, stdout: "" });
		expect(logRecords()).toMatchObject([{ level: "warn", lever: "slow" }]);
	});

	test("malformed stdin exits 0 with one log line", async () => {
		await enableRepo();
		const result = await dispatchWith([lever("rewrite", rewrite)], "{not json");
		expect(result).toEqual({ exitCode: 0, stdout: "" });
		expect(logRecords()).toHaveLength(1);
	});

	test("oversized stdin is reported as stopped early, not as empty", async () => {
		await enableRepo();
		const result = await dispatchWith([lever("rewrite", rewrite)], {
			kind: "too-large",
			limitBytes: 1024 * 1024,
		});
		expect(result.stdout).toBe("");
		expect(String(logRecords()[0]?.message)).toContain("stopped early");
	});

	test("an enabled lever's updatedInput becomes exactly one JSON document", async () => {
		await enableRepo();
		const result = await dispatchWith([lever("rewrite", rewrite)], bashPayload("git status"));
		expect(result.exitCode).toBe(0);
		const document = JSON.parse(result.stdout);
		expect(document).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				updatedInput: {
					command: "rtk git status",
					description: "Show working tree status",
					timeout: 120000,
				},
			},
		});
	});

	test("a second updatedInput claim is logged and never merged", async () => {
		await enableRepo();
		const second = lever("second", async () => ({ updatedInput: { command: "other" } }));
		const result = await dispatchWith([lever("first", rewrite), second], bashPayload("git status"));
		expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.command).toBe(
			"rtk git status",
		);
		expect(logRecords()).toMatchObject([{ level: "warn", lever: "second" }]);
	});

	test("levers that are disabled, unsubscribed, or not enforcing on the harness do not run", async () => {
		await enableRepo({ disabled: false });
		const calls: string[] = [];
		const record = (id: string) => async () => {
			calls.push(id);
			return null;
		};
		await dispatchWith(
			[
				lever("disabled", record("disabled")),
				lever("other-event", record("other-event"), { events: ["prompt.submit"] }),
				lever("codex-only", record("codex-only"), { harnesses: { codex: { enforces: true } } }),
				lever("runs", record("runs")),
			],
			bashPayload("git status"),
		);
		expect(calls).toEqual(["runs"]);
	});

	test("an invalid repos.json is logged and nothing runs", async () => {
		await enableRepo();
		writeFileSync(fixture.paths.reposFile, "{ broken");
		const result = await dispatchWith([lever("rewrite", rewrite)], bashPayload("git status"));
		expect(result).toEqual({ exitCode: 0, stdout: "" });
		expect(logRecords()).toMatchObject([{ level: "error" }]);
	});

	test("bad arguments and unknown events exit 0", async () => {
		expect((await dispatchWith([], "{}", ["PreToolUse"])).exitCode).toBe(0);
		expect((await dispatchWith([], "{}", ["Nonsense", "--harness", "claude-code"])).exitCode).toBe(
			0,
		);
		expect((await dispatchWith([], "{}", ["PreToolUse", "--harness", "cursor"])).exitCode).toBe(0);
		expect(logRecords()).toHaveLength(3);
	});
});

describe("readStdinBounded", () => {
	test("stops early past the byte limit", async () => {
		const read = await readStdinBounded(Readable.from([Buffer.alloc(64, 97)]), 16, 1000);
		expect(read).toEqual({ kind: "too-large", limitBytes: 16 });
	});

	test("times out on a stream that never ends", async () => {
		const never = new Readable({ read() {} });
		const read = await readStdinBounded(never, 1024, 30);
		expect(read).toEqual({ kind: "timed-out", afterMs: 30 });
	});

	test("returns the full text when the stream ends in time", async () => {
		const read = await readStdinBounded(
			Readable.from([Buffer.from('{"a":'), Buffer.from("1}")]),
			1024,
			1000,
		);
		expect(read).toEqual({ kind: "ok", text: '{"a":1}' });
	});
});
