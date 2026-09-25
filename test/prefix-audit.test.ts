import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { calibrate, scanTranscript } from "../src/levers/prefix-audit/calibrate.js";
import { enumeratePrefix, projectSlug } from "../src/levers/prefix-audit/enumerate.js";
import { parseFrontmatter } from "../src/levers/prefix-audit/frontmatter.js";
import { runPrefixAudit } from "../src/levers/prefix-audit/report.js";
import { countTokens } from "../src/tokenize.js";
import { isolatedEnv, makeTempDir, writeFile } from "./helpers.js";

describe("parseFrontmatter", () => {
	function fields(text: string) {
		const parsed = parseFrontmatter(text);
		if (parsed.kind !== "ok") throw new Error(`frontmatter ${parsed.kind}`);
		return parsed.fields;
	}

	test("folded block scalar", () => {
		expect(
			fields("---\nname: a\ndescription: >-\n  Use when the\n  build breaks.\n---\nbody\n")
				.description,
		).toBe("Use when the build breaks.");
	});

	test("literal block scalar keeps newlines", () => {
		expect(fields("---\ndescription: |\n  line one\n  line two\n---\n").description).toBe(
			"line one\nline two\n",
		);
	});

	test("quoted values may contain colons", () => {
		expect(fields('---\ndescription: "Use on: deploys"\n---\n').description).toBe(
			"Use on: deploys",
		);
		expect(fields("---\ndescription: 'it''s: fine'\n---\n").description).toBe("it's: fine");
	});

	test("plain scalars fold continuation lines", () => {
		expect(fields("---\ndescription: first part\n  second part\nname: x\n---\n").description).toBe(
			"first part second part",
		);
	});

	test("lists and booleans", () => {
		const parsed = fields(
			'---\npaths:\n  - "src/**/*.ts"\n  - docs/*.md\ninline: [a, "b"]\ndisable-model-invocation: true\n---\n',
		);
		expect(parsed.paths).toEqual(["src/**/*.ts", "docs/*.md"]);
		expect(parsed.inline).toEqual(["a", "b"]);
		expect(parsed["disable-model-invocation"]).toBe(true);
	});

	test("absent and unterminated frontmatter are distinct", () => {
		expect(parseFrontmatter("# title\n").kind).toBe("none");
		expect(parseFrontmatter("---\nname: x\n").kind).toBe("unterminated");
	});
});

test("special-token text is counted, not thrown on", () => {
	expect(countTokens("before <|endoftext|> after")).toBeGreaterThan(3);
});

function buildFixture(root: string) {
	const env = isolatedEnv(root);
	const home = env.HOME ?? root;
	const claudeDir = join(home, ".claude");
	env.CLAUDE_CONFIG_DIR = claudeDir;
	const project = join(home, "projects", "demo");
	writeFile(join(claudeDir, "CLAUDE.md"), "# Global\nAlways be brief.\nSee @extra.md for more.\n");
	writeFile(join(claudeDir, "extra.md"), "Imported guidance.\n");
	writeFile(join(claudeDir, "rules", "general.md"), "Rule without paths.\n");
	writeFile(
		join(claudeDir, "skills", "deploy", "SKILL.md"),
		"---\nname: deploy\ndescription: >-\n  Use when deploying\n  to production.\n---\nSteps.\n",
	);
	writeFile(
		join(claudeDir, "skills", "manual", "SKILL.md"),
		"---\nname: manual\ndescription: Only by hand\ndisable-model-invocation: true\n---\n",
	);
	writeFile(
		join(project, "CLAUDE.md"),
		"# Project\nUse bun. Email me at someone@example.invalid and ignore `@not-an-import`.\n",
	);
	writeFile(
		join(project, ".claude", "rules", "scoped.md"),
		'---\npaths:\n  - "src/**"\n---\nOnly for src.\n',
	);
	writeFile(join(project, ".claude", "rules", "always.md"), "Always loaded.\n");
	mkdirSync(join(project, "src"), { recursive: true });
	return { env, home, claudeDir, project };
}

describe("enumeratePrefix", () => {
	test("collects the per-turn sources and explains every skip", () => {
		const temp = makeTempDir("prefix");
		try {
			const { env, claudeDir, project } = buildFixture(temp.path);
			const enumeration = enumeratePrefix(project, env);
			const labels = enumeration.components.map((component) => [component.kind, component.label]);
			expect(labels).toEqual([
				["claude-md", join(claudeDir, "CLAUDE.md")],
				["claude-md-import", join(claudeDir, "extra.md")],
				["claude-md", join(project, "CLAUDE.md")],
				["rule", join(claudeDir, "rules", "general.md")],
				["rule", join(project, ".claude", "rules", "always.md")],
				["skill-description", "skill deploy"],
			]);
			expect(
				enumeration.components.find((component) => component.label === "skill deploy")?.text,
			).toBe("- deploy: Use when deploying to production.");
			expect(enumeration.skipped.map((skipped) => skipped.reason)).toEqual([
				"path-scoped rule: loads only when matching files are read",
				"disable-model-invocation: not listed to the model",
			]);
			expect(enumeration.notMeasured.length).toBeGreaterThan(0);
		} finally {
			temp.remove();
		}
	});

	test("counts the global CLAUDE.md once when the target is the home directory", () => {
		const temp = makeTempDir("prefix-home");
		try {
			const { env, home, claudeDir } = buildFixture(temp.path);
			const enumeration = enumeratePrefix(home, env);
			expect(
				enumeration.components.filter(
					(component) => component.path === join(claudeDir, "CLAUDE.md"),
				),
			).toHaveLength(1);
		} finally {
			temp.remove();
		}
	});
});

describe("calibrate", () => {
	const transcriptLines = (cwd: string) =>
		[
			JSON.stringify({ type: "summary", summary: "x" }),
			JSON.stringify({
				type: "user",
				cwd,
				message: { role: "user", content: "fix the build please" },
			}),
			JSON.stringify({
				type: "assistant",
				cwd,
				isSidechain: true,
				message: { usage: { input_tokens: 1 } },
			}),
			JSON.stringify({
				type: "assistant",
				cwd,
				message: {
					usage: {
						input_tokens: 3,
						cache_creation_input_tokens: 40000,
						cache_read_input_tokens: 2000,
						output_tokens: 10,
					},
				},
			}),
		].join("\n");

	test("sums provider-reported input on the first main-chain assistant turn", () => {
		const temp = makeTempDir("calibrate");
		try {
			const { claudeDir, project } = buildFixture(temp.path);
			writeFile(
				join(claudeDir, "projects", projectSlug(project), "session.jsonl"),
				`${transcriptLines(project)}\n`,
			);
			const result = calibrate(project, claudeDir, 500);
			expect(result.kind).toBe("ok");
			if (result.kind !== "ok") return;
			expect(result.providerInputTokens).toBe(42003);
			expect(result.firstPromptTokens).toBe(countTokens("fix the build please"));
			expect(result.unattributedTokens).toBe(42003 - 500 - result.firstPromptTokens);
		} finally {
			temp.remove();
		}
	});

	test("a truncated slug only counts when the transcript's cwd matches", () => {
		const temp = makeTempDir("calibrate-truncated");
		try {
			const { claudeDir, project } = buildFixture(temp.path);
			const deep = join(
				project,
				"a-very-long-directory-name-that-pushes-the-slug-past-the-truncation-point",
			);
			mkdirSync(deep, { recursive: true });
			const truncated = projectSlug(deep).slice(0, 80);
			writeFile(
				join(claudeDir, "projects", truncated, "other.jsonl"),
				`${transcriptLines("/somewhere/else")}\n`,
			);
			expect(calibrate(deep, claudeDir, 0).kind).toBe("no-transcript");
			writeFileSync(
				join(claudeDir, "projects", truncated, "other.jsonl"),
				`${transcriptLines(deep)}\n`,
			);
			expect(calibrate(deep, claudeDir, 0).kind).toBe("ok");
		} finally {
			temp.remove();
		}
	});

	test("a read bound hit before any usage reports stopped-early", () => {
		const temp = makeTempDir("calibrate-bound");
		try {
			const path = join(temp.path, "big.jsonl");
			writeFileSync(
				path,
				`${JSON.stringify({ type: "user", message: { content: "x".repeat(200_000) } })}\n`,
			);
			expect(scanTranscript(path, 1024)).toEqual({ kind: "stopped-early", limitBytes: 1024 });
			expect(scanTranscript(path).kind).toBe("no-usage");
		} finally {
			temp.remove();
		}
	});
});

test("runPrefixAudit --json prints one parseable report", async () => {
	const temp = makeTempDir("prefix-report");
	try {
		const { env, project } = buildFixture(temp.path);
		const lines: string[] = [];
		const code = await runPrefixAudit(
			undefined,
			{ json: true, calibrate: true },
			{ env, cwd: project, out: (line) => lines.push(line), err: (line) => lines.push(line) },
		);
		expect(code).toBe(0);
		const report = JSON.parse(lines.join("\n"));
		expect(report.tokenizer.name).toBe("o200k_base");
		expect(report.totalTokens).toBeGreaterThan(0);
		expect(report.calibration.kind).toBe("no-transcript");
	} finally {
		temp.remove();
	}
});
