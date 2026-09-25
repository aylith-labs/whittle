import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, makeTempDir, runWhittle } from "../helpers.js";

const SETTINGS = `{
  "model": "opus",
  "statusLine": {
    "type": "command",
    "command": "bunx -y ccstatusline@latest",
    "padding": 0
  },
  "permissions": {
    "allow": [
      "Bash(git status:*)"
    ],
    "defaultMode": "auto"
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.claude/hooks/skill-pre-eval.py"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/require-tldr.sh",
            "timeout": 10
          }
        ]
      }
    ]
  },
  "footerLinksRegexes": ["x"],
  "env": {
    "FOO": "bar"
  }
}
`;

function setup(prefix: string) {
	const temp = makeTempDir(prefix);
	const claudeDir = join(temp.path, "home", ".claude");
	mkdirSync(claudeDir, { recursive: true });
	const env = isolatedEnv(temp.path, { CLAUDE_CONFIG_DIR: claudeDir });
	return { temp, env, settings: join(claudeDir, "settings.json") };
}

describe("uninstall round trip", () => {
	test("install then uninstall -y restores settings.json byte for byte", async () => {
		const { temp, env, settings } = setup("uninstall");
		try {
			const original = Buffer.from(SETTINGS, "utf8");
			writeFileSync(settings, original);
			const install = await runWhittle(["install"], { cwd: temp.path, env });
			expect(install.exitCode).toBe(0);
			const installed = readFileSync(settings);
			expect(installed.equals(original)).toBe(false);
			expect(installed.toString("utf8")).toContain("hook PreToolUse --harness claude-code");

			const again = await runWhittle(["install"], { cwd: temp.path, env });
			expect(again.exitCode).toBe(0);
			expect(readFileSync(settings).equals(installed)).toBe(true);

			const dryRun = await runWhittle(["uninstall"], { cwd: temp.path, env });
			expect(dryRun.exitCode).toBe(0);
			expect(dryRun.stdout).toContain("would remove 5 whittle entries");
			expect(readFileSync(settings).equals(installed)).toBe(true);

			const uninstall = await runWhittle(["uninstall", "-y"], { cwd: temp.path, env });
			expect(uninstall.exitCode).toBe(0);
			expect(uninstall.stdout).toContain("byte-identical to the backup");
			expect(readFileSync(settings).equals(original)).toBe(true);
		} finally {
			temp.remove();
		}
	}, 60_000);

	test("a settings.json whittle created is removed again, and --purge clears whittle's own files", async () => {
		const { temp, env, settings } = setup("uninstall-created");
		try {
			expect((await runWhittle(["install"], { cwd: temp.path, env })).exitCode).toBe(0);
			expect(existsSync(settings)).toBe(true);
			const uninstall = await runWhittle(["uninstall", "-y", "--purge"], { cwd: temp.path, env });
			expect(uninstall.exitCode).toBe(0);
			expect(existsSync(settings)).toBe(false);
			expect(existsSync(join(env.XDG_CONFIG_HOME ?? "", "whittle"))).toBe(false);
		} finally {
			temp.remove();
		}
	}, 60_000);

	test("a broken settings.json is refused and stays byte-identical", async () => {
		const { temp, env, settings } = setup("uninstall-broken");
		try {
			const broken = Buffer.from('{\n  "model": "opus",\n', "utf8");
			writeFileSync(settings, broken);
			const install = await runWhittle(["install"], { cwd: temp.path, env });
			expect(install.exitCode).toBe(1);
			expect(install.stderr).toContain("refused");
			expect(readFileSync(settings).equals(broken)).toBe(true);
		} finally {
			temp.remove();
		}
	}, 60_000);

	test("with no harness installed, install writes nothing and exits 0", async () => {
		const temp = makeTempDir("uninstall-none");
		try {
			const env = isolatedEnv(temp.path, {
				CLAUDE_CONFIG_DIR: join(temp.path, "home", "no-claude-here"),
			});
			const install = await runWhittle(["install"], { cwd: temp.path, env });
			expect(install.exitCode).toBe(0);
			expect(install.stdout).toContain("not installed");
			expect(existsSync(join(env.XDG_CONFIG_HOME ?? "", "whittle"))).toBe(false);
		} finally {
			temp.remove();
		}
	}, 60_000);
});
