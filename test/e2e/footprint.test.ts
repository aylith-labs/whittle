import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	initRepo,
	isolatedEnv,
	makeTempDir,
	runWhittle,
	snapshotRepo,
	writeFile,
} from "../helpers.js";

test("every command and hook event leaves the repository untouched", async () => {
	const temp = makeTempDir("footprint");
	try {
		const home = join(temp.path, "home");
		const claudeDir = join(home, ".claude");
		const binDir = join(temp.path, "bin");
		mkdirSync(claudeDir, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(binDir, "rtk"), "#!/bin/sh\necho rtk 0.0.0-test\n");
		chmodSync(join(binDir, "rtk"), 0o755);
		const baseEnv = isolatedEnv(temp.path, { CLAUDE_CONFIG_DIR: claudeDir });
		const env = { ...baseEnv, PATH: `${binDir}:${baseEnv.PATH}` };

		const repo = join(temp.path, "repo");
		initRepo(repo, env, {
			".gitignore": "graft/\n.graft/\n",
			".claude/settings.json": `${JSON.stringify({ statusLine: { type: "command", command: "echo project" }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo foreign" }] }] } }, null, 2)}\n`,
			"CLAUDE.md": "# Demo\nKeep it small.\n",
			"src/index.ts": "export const answer = 42;\n",
		});
		const transcriptDir = join(claudeDir, "projects", repo.replaceAll(/[^A-Za-z0-9]/g, "-"));
		writeFile(
			join(transcriptDir, "session-1.jsonl"),
			`${JSON.stringify({ type: "user", cwd: repo, message: { content: "hello" } })}\n${JSON.stringify({ type: "assistant", cwd: repo, message: { usage: { input_tokens: 5, cache_creation_input_tokens: 9000, cache_read_input_tokens: 0 } } })}\n`,
		);

		const before = snapshotRepo(repo, env);
		const run = (args: string[], stdin?: string) =>
			runWhittle(args, stdin === undefined ? { cwd: repo, env } : { cwd: repo, env, stdin });
		const base = {
			session_id: "session-1",
			transcript_path: join(transcriptDir, "session-1.jsonl"),
			cwd: repo,
			permission_mode: "default",
		};

		expect((await run(["install"])).exitCode).toBe(0);
		expect((await run(["enable", "--lever", "shell-output"])).exitCode).toBe(0);

		const hookRuns: [string, Record<string, unknown>][] = [
			["SessionStart", { ...base, hook_event_name: "SessionStart", source: "startup" }],
			[
				"UserPromptSubmit",
				{ ...base, hook_event_name: "UserPromptSubmit", prompt: "where is answer defined?" },
			],
			[
				"PreToolUse",
				{
					...base,
					hook_event_name: "PreToolUse",
					tool_name: "Bash",
					tool_input: { command: "git status", description: "Show status" },
				},
			],
			[
				"PostToolUse",
				{
					...base,
					hook_event_name: "PostToolUse",
					tool_name: "Write",
					tool_input: { file_path: join(repo, "src", "index.ts"), content: "x" },
					tool_response: { success: true },
				},
			],
			["Stop", { ...base, hook_event_name: "Stop", stop_hook_active: false }],
		];
		for (const [event, payload] of hookRuns) {
			const result = await run(
				["hook", event, "--harness", "claude-code"],
				JSON.stringify(payload),
			);
			expect(result.exitCode).toBe(0);
			if (event === "PreToolUse") {
				expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput).toEqual({
					command: "rtk git status",
					description: "Show status",
				});
			} else {
				expect(result.stdout).toBe("");
			}
		}

		const rtkLedgerLine = `rtk records each filtered command in ${join(home, ".local", "share", "rtk", "history.db")}`;
		const levers = await run(["levers"]);
		expect(levers.exitCode).toBe(0);
		expect(levers.stdout).toContain(rtkLedgerLine);
		const status = await run(["status", "--json"]);
		expect(status.exitCode).toBe(0);
		expect(JSON.parse(status.stdout).harnesses[0]).toMatchObject({
			id: "claude-code",
			installed: true,
			wired: true,
		});
		const doctor = await run(["doctor"]);
		expect([0, 1]).toContain(doctor.exitCode);
		expect(doctor.stdout).toContain(`NOTE shell-output: ${rtkLedgerLine}`);
		expect((await run(["footprint"])).exitCode).toBe(0);
		const audit = await run(["prefix-audit", "--json", "--calibrate"]);
		expect(audit.exitCode).toBe(0);
		expect(JSON.parse(audit.stdout).calibration.kind).toBe("ok");
		expect((await run(["disable", "--lever", "shell-output"])).exitCode).toBe(0);
		expect((await run(["uninstall"])).exitCode).toBe(0);

		const after = snapshotRepo(repo, env);
		expect(after.tree).toBe(before.tree);
		expect(after.status).toBe(before.status);

		const logText = (() => {
			try {
				return readFileSync(join(home, ".config", "whittle", "log", "hooks.jsonl"), "utf8");
			} catch {
				return "";
			}
		})();
		expect(logText.split("\n").filter((line) => line.includes('"level":"error"'))).toEqual([]);

		mkdirSync(join(repo, "graft"), { recursive: true });
		writeFileSync(join(repo, "graft", "stray.json"), "{}\n");
		const control = snapshotRepo(repo, env);
		expect(control.tree).not.toBe(before.tree);
		expect(control.status).not.toBe(before.status);
	} finally {
		temp.remove();
	}
}, 180_000);
