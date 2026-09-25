import { describe, expect, test } from "bun:test";
import { isAbsolute, join } from "node:path";
import { CLAUDE_CODE_HOOK_SPECS, claudeCode } from "../src/harness/claude-code.js";
import { resolveBinCommand } from "../src/self.js";
import { BIN_ENTRY } from "./helpers.js";

const BIN = "'/opt/whittle/bin/whittle'";

describe("event map", () => {
	test("wires the five events with matchers, async flags and second-based timeouts", () => {
		expect(
			CLAUDE_CODE_HOOK_SPECS.map((spec) => [
				spec.nativeEvent,
				spec.matcher,
				spec.async,
				spec.timeout,
			]),
		).toEqual([
			["SessionStart", null, false, 5],
			["UserPromptSubmit", null, false, 8],
			["PreToolUse", "Bash", false, 3],
			["PostToolUse", "Write|Edit|MultiEdit", true, 5],
			["Stop", null, true, 5],
		]);
		expect(claudeCode.timeoutUnit).toBe("seconds");
	});

	test("maps native names both ways", () => {
		expect(claudeCode.eventFromNative("PreToolUse")).toBe("tool.pre");
		expect(claudeCode.eventFromNative("Notification")).toBeNull();
	});
});

describe("hook command", () => {
	test("uses the absolute, quoted executable path", () => {
		const bin = resolveBinCommand([process.execPath, BIN_ENTRY], process.execPath, "linux");
		expect(bin.kind).toBe("ok");
		if (bin.kind !== "ok") return;
		expect(bin.executables.every((path) => isAbsolute(path))).toBe(true);
		const group = claudeCode
			.desiredGroups(bin.command)
			.find((want) => want.nativeEvent === "PreToolUse")?.group;
		expect(group).toEqual({
			matcher: "Bash",
			hooks: [
				{
					type: "command",
					command: `${bin.command} hook PreToolUse --harness claude-code`,
					timeout: 3,
				},
			],
		});
		expect(bin.command.startsWith("'/")).toBe(true);
	});

	test("refuses a path that cannot be single-quoted", () => {
		expect(resolveBinCommand(["x"], "/tmp/it's/whittle", "linux").kind).toBe("refused");
	});

	test("recognises its own entries and nobody else's", () => {
		expect(claudeCode.isOurCommand(`${BIN} hook Stop --harness claude-code`, BIN)).toBe(true);
		expect(claudeCode.isOurCommand("'/moved/whittle' hook Stop --harness claude-code", BIN)).toBe(
			true,
		);
		expect(
			claudeCode.isOurCommand(
				"'/usr/bin/node' '/x/node_modules/@aylith/whittle/dist/bin.js' hook Stop --harness claude-code",
				null,
			),
		).toBe(true);
		expect(claudeCode.isOurCommand(`${BIN} hook Stop --harness codex`, BIN)).toBe(false);
		expect(
			claudeCode.isOurCommand('node "/home/u/.claude/helpers/graft-hooks.cjs" session-start', BIN),
		).toBe(false);
		expect(claudeCode.isOurCommand("'/opt/other-tool' hook Stop --harness claude-code", BIN)).toBe(
			false,
		);
	});
});

describe("settings location", () => {
	test("honours CLAUDE_CONFIG_DIR and falls back to HOME", () => {
		expect(claudeCode.hookFile({ HOME: "/h", CLAUDE_CONFIG_DIR: "/profiles/work" })).toBe(
			"/profiles/work/settings.json",
		);
		expect(claudeCode.hookFile({ HOME: "/h" })).toBe(join("/h", ".claude", "settings.json"));
	});
});

describe("normalise and render", () => {
	const writePayload = {
		session_id: "abc",
		transcript_path: "/t.jsonl",
		cwd: "/work/repo",
		hook_event_name: "PostToolUse",
		tool_name: "Write",
		tool_input: { file_path: "/work/repo/src/a.ts", content: "x" },
		tool_response: { success: true },
	};

	test("normalise extracts the fields levers need", () => {
		const event = claudeCode.normalise("tool.post", writePayload, "/fallback");
		expect(event).toMatchObject({
			sessionId: "abc",
			cwd: "/work/repo",
			transcriptPath: "/t.jsonl",
		});
		expect(event.tool).toMatchObject({
			name: "Write",
			editedFiles: ["/work/repo/src/a.ts"],
			command: null,
		});
		expect(claudeCode.normalise("tool.pre", { cwd: "relative" }, "/fallback").cwd).toBe(
			"/fallback",
		);
	});

	test("context goes out only in the nested hookSpecificOutput shape", () => {
		const normalised = claudeCode.normalise("prompt.submit", { prompt: "hi" }, "/w");
		const rendered = claudeCode.render(
			"prompt.submit",
			{ contexts: ["one", "two"], updatedInput: null },
			normalised,
		);
		const document = JSON.parse(rendered ?? "null");
		expect(document).toEqual({
			hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "one\n\ntwo" },
		});
		expect("additionalContext" in document).toBe(false);
	});

	test("updatedInput keeps the rest of the tool input and asserts no permission decision", () => {
		const normalised = claudeCode.normalise(
			"tool.pre",
			{
				tool_name: "Bash",
				tool_input: { command: "ls", description: "List", run_in_background: false },
			},
			"/w",
		);
		const document = JSON.parse(
			claudeCode.render(
				"tool.pre",
				{ contexts: [], updatedInput: { command: "rtk ls" } },
				normalised,
			) ?? "null",
		);
		expect(document.hookSpecificOutput).toEqual({
			hookEventName: "PreToolUse",
			updatedInput: { command: "rtk ls", description: "List", run_in_background: false },
		});
	});

	test("async events and empty output render nothing", () => {
		const normalised = claudeCode.normalise("turn.stop", {}, "/w");
		expect(
			claudeCode.render("turn.stop", { contexts: ["ignored"], updatedInput: null }, normalised),
		).toBeNull();
		expect(
			claudeCode.render("tool.post", { contexts: ["ignored"], updatedInput: { a: 1 } }, normalised),
		).toBeNull();
		expect(
			claudeCode.render("prompt.submit", { contexts: [], updatedInput: null }, normalised),
		).toBeNull();
	});
});
