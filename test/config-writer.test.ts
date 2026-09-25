import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type EditPlan,
	planInstall,
	planUninstall,
	verifyOnlyHooksChanged,
	writeHookFile,
} from "../src/config-writer.js";
import { claudeCode } from "../src/harness/claude-code.js";
import { isRecord } from "../src/json.js";
import { isolatedEnv, makeTempDir, runWhittle } from "./helpers.js";

const BIN = "'/opt/whittle/bin/whittle'";
const desired = claudeCode.desiredGroups(BIN);
const isOurs = (command: string) => claudeCode.isOurCommand(command, BIN);

const FOREIGN = `{
  "statusLine": {
    "type": "command",
    "command": "bunx -y ccstatusline@latest",
    "padding": 0
  },
  "10": "numeric-looking key",
  "ratio": 1.50,
  "name": "caf\\u00e9",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node foreign-stop.js"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "WebFetch",
        "hooks": [
          {
            "type": "command",
            "command": "python3 guard.py"
          }
        ]
      }
    ]
  },
  "permissions": {
    "allow": ["Bash(git status:*)"]
  },
  "env": { "A": "1" }
}
`;

function ok(plan: EditPlan): Extract<EditPlan, { kind: "ok" }> {
	if (plan.kind !== "ok") throw new Error(`plan refused: ${plan.reason}`);
	return plan;
}

function ourCommandsPerEvent(text: string): Record<string, number> {
	const parsed: unknown = JSON.parse(text.replace(/^﻿/, ""));
	const counts: Record<string, number> = {};
	if (!isRecord(parsed) || !isRecord(parsed.hooks)) return counts;
	for (const [event, groups] of Object.entries(parsed.hooks)) {
		if (!Array.isArray(groups)) continue;
		for (const group of groups) {
			if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
			for (const hook of group.hooks) {
				if (isRecord(hook) && typeof hook.command === "string" && isOurs(hook.command)) {
					counts[event] = (counts[event] ?? 0) + 1;
				}
			}
		}
	}
	return counts;
}

const ONE_PER_EVENT = {
	SessionStart: 1,
	UserPromptSubmit: 1,
	PreToolUse: 1,
	PostToolUse: 1,
	Stop: 1,
};

describe("planInstall / planUninstall", () => {
	test("appends after foreign entries, preserves every foreign byte, and uninstall restores the original", () => {
		const install = ok(planInstall(FOREIGN, desired, isOurs));
		const installed = install.text;
		expect(install.createdKeys).toEqual([
			"hooks.SessionStart",
			"hooks.UserPromptSubmit",
			"hooks.PostToolUse",
		]);
		expect(ourCommandsPerEvent(installed)).toEqual(ONE_PER_EVENT);
		const parsed = JSON.parse(installed);
		expect(Object.keys(parsed)).toEqual(Object.keys(JSON.parse(FOREIGN)));
		expect(parsed.hooks.Stop[0].hooks[0].command).toBe("node foreign-stop.js");
		expect(parsed.hooks.PreToolUse[0].matcher).toBe("WebFetch");
		expect(parsed.hooks.PreToolUse[1].matcher).toBe("Bash");
		expect(verifyOnlyHooksChanged(FOREIGN, installed)).toBeNull();
		expect(installed).toContain('"ratio": 1.50');
		expect(installed).toContain('"name": "caf\\u00e9"');
		expect(ok(planUninstall(installed, isOurs, install.createdKeys)).text).toBe(FOREIGN);
		const withoutCreatedKeys = ok(planUninstall(installed, isOurs, [])).text;
		expect(JSON.parse(withoutCreatedKeys).hooks.SessionStart).toEqual([]);
	});

	test("installing twice changes nothing and keeps one entry per event", () => {
		const first = ok(planInstall(FOREIGN, desired, isOurs)).text;
		const second = ok(planInstall(first, desired, isOurs));
		expect(second.text).toBe(first);
		expect(second.changes.every((change) => change.action === "unchanged")).toBe(true);
		expect(ourCommandsPerEvent(second.text)).toEqual(ONE_PER_EVENT);
	});

	test("hook timeouts are written in seconds", () => {
		const parsed = JSON.parse(ok(planInstall("{}", desired, isOurs)).text);
		const timeouts = Object.values(parsed.hooks).flatMap((groups) =>
			(groups as { hooks: { timeout: number }[] }[]).flatMap((group) =>
				group.hooks.map((hook) => hook.timeout),
			),
		);
		expect(timeouts).toEqual([5, 8, 3, 5, 5]);
	});

	test.each([
		["four spaces", "    "],
		["tabs", "\t"],
	])("new lines follow the file's indentation (%s)", (_label, unit) => {
		const original = `{\n${unit}"theme": "dark",\n${unit}"hooks": {\n${unit}${unit}"Stop": []\n${unit}}\n}\n`;
		const install = ok(planInstall(original, desired, isOurs));
		const installed = install.text;
		const originalLines = new Set(original.split("\n"));
		const addedIndents = installed
			.split("\n")
			.filter((line) => !originalLines.has(line))
			.map((line) => /^\s*/.exec(line)?.[0] ?? "");
		const unitPattern = unit === "\t" ? /^\t*$/ : /^( {4})*$/;
		expect(addedIndents.every((indent) => unitPattern.test(indent))).toBe(true);
		expect(ok(planUninstall(installed, isOurs, install.createdKeys)).text).toBe(original);
	});

	test("CRLF files get CRLF lines", () => {
		const original = '{\r\n  "theme": "dark"\r\n}\r\n';
		const installed = ok(planInstall(original, desired, isOurs)).text;
		expect(/[^\r]\n/.test(installed)).toBe(false);
		const plan = ok(planInstall(original, desired, isOurs));
		expect(ok(planUninstall(installed, isOurs, plan.createdKeys)).text).toBe(original);
	});

	test("a stale entry is replaced in place and duplicates collapse to one", () => {
		const stale = ok(
			planInstall(FOREIGN, claudeCode.desiredGroups("'/old/whittle'"), (command) =>
				claudeCode.isOurCommand(command, "'/old/whittle'"),
			),
		).text;
		const doubled = ok(
			planInstall(stale, claudeCode.desiredGroups("'/old/whittle'"), () => false),
		).text;
		expect(ourCommandsPerEvent(doubled)).toEqual({
			SessionStart: 2,
			UserPromptSubmit: 2,
			PreToolUse: 2,
			PostToolUse: 2,
			Stop: 2,
		});
		const repaired = ok(planInstall(doubled, desired, isOurs));
		expect(ourCommandsPerEvent(repaired.text)).toEqual(ONE_PER_EVENT);
		expect(repaired.text).not.toContain("/old/whittle");
		expect(JSON.parse(repaired.text).hooks.Stop[1].hooks[0].command).toBe(
			`${BIN} hook Stop --harness claude-code`,
		);
	});

	test("a whittle hook hand-merged into a foreign group is removed from that group only", () => {
		const mixed = JSON.stringify(
			{
				hooks: {
					Stop: [
						{
							hooks: [
								{ type: "command", command: "node foreign.js" },
								{ type: "command", command: `${BIN} hook Stop --harness claude-code` },
							],
						},
					],
				},
			},
			null,
			2,
		);
		const installed = JSON.parse(ok(planInstall(mixed, desired, isOurs)).text);
		expect(installed.hooks.Stop[0].hooks).toEqual([
			{ type: "command", command: "node foreign.js" },
		]);
		expect(installed.hooks.Stop[1].hooks[0].command).toBe(`${BIN} hook Stop --harness claude-code`);
	});

	test("a change to statusLine is caught as a protected key", () => {
		const altered = FOREIGN.replace("ccstatusline@latest", "other-statusline");
		expect(verifyOnlyHooksChanged(FOREIGN, altered)).toContain('protected key "statusLine"');
	});

	test.each([
		['{ "hooks": {} // comment\n}', "not strict JSON"],
		["[]", "not a JSON object"],
		['{"hooks": []}', '"hooks" is not a JSON object'],
		['{"hooks": {"Stop": {}}}', '"hooks.Stop" is not a JSON array'],
	])("refuses %j", (text, reason) => {
		const plan = planInstall(text, desired, isOurs);
		expect(plan.kind).toBe("refused");
		if (plan.kind === "refused") expect(plan.reason).toContain(reason);
	});
});

describe("writeHookFile", () => {
	function setup(prefix: string) {
		const temp = makeTempDir(prefix);
		const locksDir = join(temp.path, "locks");
		const backupsDir = join(temp.path, "backups");
		const settings = join(temp.path, "claude", "settings.json");
		mkdirSync(join(temp.path, "claude"), { recursive: true });
		return { temp, locksDir, backupsDir, settings };
	}

	test("refuses broken JSON and leaves the file byte-identical", async () => {
		const { temp, locksDir, backupsDir, settings } = setup("writer-broken");
		try {
			const broken = Buffer.from('{\n  "statusLine": { "type": "command",\n', "utf8");
			writeFileSync(settings, broken);
			const result = await writeHookFile({
				path: settings,
				locksDir,
				backupsDir,
				backupLabel: "claude-code-settings.json",
				plan: (text) => planInstall(text, desired, isOurs),
				createIfMissing: true,
				removeWhenEmpty: false,
			});
			expect(result.kind).toBe("refused");
			expect(readFileSync(settings).equals(broken)).toBe(true);
		} finally {
			temp.remove();
		}
	});

	test("keeps a byte-order mark and restores the exact bytes on removal", async () => {
		const { temp, locksDir, backupsDir, settings } = setup("writer-bom");
		try {
			const original = Buffer.from(`﻿${FOREIGN}`, "utf8");
			writeFileSync(settings, original);
			const install = await writeHookFile({
				path: settings,
				locksDir,
				backupsDir,
				backupLabel: "claude-code-settings.json",
				plan: (text) => planInstall(text, desired, isOurs),
				createIfMissing: true,
				removeWhenEmpty: false,
			});
			expect(install.kind).toBe("written");
			const installed = readFileSync(settings);
			expect(installed.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
			if (install.kind === "written") {
				expect(install.backup).not.toBeNull();
				expect(readFileSync(install.backup?.path ?? "").equals(original)).toBe(true);
			}
			const removal = await writeHookFile({
				path: settings,
				locksDir,
				backupsDir: null,
				backupLabel: "",
				plan: (text) =>
					planUninstall(
						text ?? "{}",
						isOurs,
						install.kind === "written" ? install.createdKeys : [],
					),
				createIfMissing: false,
				removeWhenEmpty: false,
			});
			expect(removal.kind).toBe("written");
			expect(readFileSync(settings).equals(original)).toBe(true);
		} finally {
			temp.remove();
		}
	});

	test("re-reads and re-applies when another writer changes the file mid-edit", async () => {
		const { temp, locksDir, settings } = setup("writer-race");
		try {
			writeFileSync(settings, FOREIGN);
			let interfered = false;
			const result = await writeHookFile({
				path: settings,
				locksDir,
				backupsDir: null,
				backupLabel: "",
				plan: (text) => planInstall(text, desired, isOurs),
				createIfMissing: true,
				removeWhenEmpty: false,
				onBeforeCommit: () => {
					if (interfered) return;
					interfered = true;
					writeFileSync(settings, FOREIGN.replace('"env": { "A": "1" }', '"env": { "A": "2" }'));
				},
			});
			expect(result.kind).toBe("written");
			const final = readFileSync(settings, "utf8");
			expect(JSON.parse(final).env).toEqual({ A: "2" });
			expect(ourCommandsPerEvent(final)).toEqual(ONE_PER_EVENT);
		} finally {
			temp.remove();
		}
	});

	test("gives up without writing when the file never stops changing", async () => {
		const { temp, locksDir, settings } = setup("writer-churn");
		try {
			writeFileSync(settings, FOREIGN);
			let generation = 0;
			const result = await writeHookFile({
				path: settings,
				locksDir,
				backupsDir: null,
				backupLabel: "",
				plan: (text) => planInstall(text, desired, isOurs),
				createIfMissing: true,
				removeWhenEmpty: false,
				onBeforeCommit: () => {
					generation += 1;
					writeFileSync(settings, FOREIGN.replace('"A": "1"', `"A": "gen-${generation}"`));
				},
			});
			expect(result.kind).toBe("refused");
			expect(ourCommandsPerEvent(readFileSync(settings, "utf8"))).toEqual({});
		} finally {
			temp.remove();
		}
	});

	test("edits the target of a symlinked settings file and keeps the link", async () => {
		const { temp, locksDir, settings } = setup("writer-symlink");
		try {
			const real = join(temp.path, "dotfiles", "settings.json");
			mkdirSync(join(temp.path, "dotfiles"));
			writeFileSync(real, FOREIGN);
			symlinkSync(real, settings);
			const result = await writeHookFile({
				path: settings,
				locksDir,
				backupsDir: null,
				backupLabel: "",
				plan: (text) => planInstall(text, desired, isOurs),
				createIfMissing: true,
				removeWhenEmpty: false,
			});
			expect(result.kind).toBe("written");
			expect(lstatSync(settings).isSymbolicLink()).toBe(true);
			expect(ourCommandsPerEvent(readFileSync(real, "utf8"))).toEqual(ONE_PER_EVENT);
		} finally {
			temp.remove();
		}
	});

	test("never creates a missing file when told not to", async () => {
		const { temp, locksDir, settings } = setup("writer-missing");
		try {
			const result = await writeHookFile({
				path: settings,
				locksDir,
				backupsDir: null,
				backupLabel: "",
				plan: (text) => planUninstall(text ?? "{}", isOurs, []),
				createIfMissing: false,
				removeWhenEmpty: true,
			});
			expect(result.kind).toBe("unchanged");
			expect(() => lstatSync(settings)).toThrow();
		} finally {
			temp.remove();
		}
	});
});

test("five concurrent installs leave exactly one entry per event", async () => {
	const temp = makeTempDir("concurrent");
	try {
		const claudeDir = join(temp.path, "home", ".claude");
		const env = isolatedEnv(temp.path, { CLAUDE_CONFIG_DIR: claudeDir });
		mkdirSync(claudeDir, { recursive: true });
		const settings = join(claudeDir, "settings.json");
		writeFileSync(settings, FOREIGN);
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				runWhittle(["install", "--harness", "claude-code"], { cwd: temp.path, env }),
			),
		);
		for (const result of results) expect(result.exitCode).toBe(0);
		expect(ourCommandsPerEvent(readFileSync(settings, "utf8"))).toEqual(ONE_PER_EVENT);
		expect(verifyOnlyHooksChanged(FOREIGN, readFileSync(settings, "utf8"))).toBeNull();
	} finally {
		temp.remove();
	}
}, 120_000);
