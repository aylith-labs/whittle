import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planInstall, planUninstall } from "../src/config-writer.js";
import { CODEX_HOOK_SPECS, codex, patchedFiles } from "../src/harness/codex.js";
import { isolatedEnv, makeTempDir, runWhittle } from "./helpers.js";

const BIN = "'/opt/whittle/bin/whittle'";
const desired = codex.desiredGroups(BIN);
const isOurs = (command: string) => codex.isOurCommand(command, BIN);

const HOOKS_JSON = `{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          {
            "command": "'/usr/local/bin/notify-hook' codex-hook",
            "type": "command"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "command": "'/usr/local/bin/notify-hook' codex-hook",
            "type": "command"
          }
        ]
      },
      {
        "hooks": [
          {
            "command": "bash '/home/user/.codex/agent-state.sh' session",
            "timeout": 10,
            "type": "command"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "command": "'/usr/local/bin/notify-hook' codex-hook",
            "type": "command"
          }
        ]
      }
    ]
  }
}
`;

const CONFIG_TOML = `model = "gpt-5.5"

[hooks.state]

[hooks.state."/home/user/.codex/hooks.json:session_start:0:0"]
trusted_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
`;

describe("codex adapter", () => {
	test("timeouts are seconds and matchers are Codex regexes", () => {
		expect(codex.timeoutUnit).toBe("seconds");
		expect(CODEX_HOOK_SPECS.map((spec) => [spec.nativeEvent, spec.matcher, spec.timeout])).toEqual([
			["SessionStart", "startup|resume|compact", 5],
			["UserPromptSubmit", null, 8],
			["PreToolUse", "^Bash$", 3],
			["PostToolUse", "^(apply_patch|Write|Edit)$", 5],
			["Stop", null, 5],
		]);
		expect(codex.trustsByPosition).toBe(true);
	});

	test("hooks.json honours CODEX_HOME", () => {
		expect(codex.hookFile({ HOME: "/h", CODEX_HOME: "/elsewhere/codex" })).toBe(
			"/elsewhere/codex/hooks.json",
		);
		expect(codex.hookFile({ HOME: "/h" })).toBe("/h/.codex/hooks.json");
	});

	test("install only appends: every existing entry keeps its index and content", () => {
		const plan = planInstall(HOOKS_JSON, desired, isOurs);
		if (plan.kind !== "ok") throw new Error(plan.reason);
		const before = JSON.parse(HOOKS_JSON).hooks;
		const after = JSON.parse(plan.text).hooks;
		for (const [event, groups] of Object.entries(before) as [string, unknown[]][]) {
			expect(after[event].slice(0, groups.length)).toEqual(groups);
		}
		expect(after.SessionStart).toHaveLength(3);
		expect(after.SessionStart[2].hooks[0].command).toBe(`${BIN} hook SessionStart --harness codex`);
		expect(plan.changes.every((change) => !change.shiftsLaterEntries)).toBe(true);
		const removed = planUninstall(plan.text, isOurs, plan.createdKeys);
		expect(removed.kind === "ok" ? removed.text : null).toBe(HOOKS_JSON);
	});

	test("a Claude Code entry is not mistaken for a Codex one", () => {
		expect(codex.isOurCommand(`${BIN} hook Stop --harness claude-code`, BIN)).toBe(false);
		expect(codex.isOurCommand(`${BIN} hook Stop --harness codex`, BIN)).toBe(true);
	});

	test("apply_patch payloads report the files they touch", () => {
		const patch =
			"*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** Delete File: old.ts\n*** Update File: src/a.ts\n*** Move to: src/c.ts\n*** End Patch\n";
		expect(patchedFiles(patch)).toEqual(["src/a.ts", "src/b.ts", "old.ts", "src/c.ts"]);
		const event = codex.normalise(
			"tool.post",
			{ session_id: "s", cwd: "/w", tool_name: "apply_patch", tool_input: { command: patch } },
			"/w",
		);
		expect(event.tool?.editedFiles).toEqual(["src/a.ts", "src/b.ts", "old.ts", "src/c.ts"]);
	});

	test("context renders in Codex's nested hookSpecificOutput shape", () => {
		const normalised = codex.normalise("prompt.submit", { prompt: "hi", cwd: "/w" }, "/w");
		const rendered = codex.render(
			"prompt.submit",
			{ contexts: ["pointer"], updatedInput: null },
			normalised,
		);
		expect(JSON.parse(rendered ?? "null")).toEqual({
			hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "pointer" },
		});
	});
});

test("installing for Codex appends, prints the entries to trust, and never touches config.toml", async () => {
	const temp = makeTempDir("codex-install");
	try {
		const codexHome = join(temp.path, "home", ".codex");
		mkdirSync(codexHome, { recursive: true });
		const hooksFile = join(codexHome, "hooks.json");
		const configToml = join(codexHome, "config.toml");
		writeFileSync(hooksFile, HOOKS_JSON);
		writeFileSync(configToml, CONFIG_TOML);
		const env = isolatedEnv(temp.path, { CODEX_HOME: codexHome });
		const install = await runWhittle(["install", "--harness", "codex"], { cwd: temp.path, env });
		expect(install.exitCode).toBe(0);
		expect(install.stdout).toContain("whittle writes no trusted_hash");
		expect(install.stdout).toContain(`hook PreToolUse --harness codex`);
		expect(readFileSync(configToml, "utf8")).toBe(CONFIG_TOML);
		const uninstall = await runWhittle(["uninstall", "-y"], { cwd: temp.path, env });
		expect(uninstall.exitCode).toBe(0);
		expect(readFileSync(hooksFile, "utf8")).toBe(HOOKS_JSON);
		expect(readFileSync(configToml, "utf8")).toBe(CONFIG_TOML);
	} finally {
		temp.remove();
	}
}, 60_000);
