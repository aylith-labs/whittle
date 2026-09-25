import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { type Env, homeDirectory } from "../../config.js";
import { claudeCode } from "../../harness/claude-code.js";
import { describeError, hasErrorCode } from "../../json.js";
import { parseFrontmatter } from "./frontmatter.js";

export type PrefixComponentKind =
	| "claude-md"
	| "claude-md-import"
	| "rule"
	| "memory"
	| "skill-description";

export type PrefixComponent = {
	kind: PrefixComponentKind;
	path: string;
	label: string;
	text: string;
	note: string | null;
};

export type SkippedSource = { path: string; reason: string };

export type Enumeration = {
	claudeConfigDir: string;
	components: PrefixComponent[];
	skipped: SkippedSource[];
	notMeasured: string[];
};

type BoundedRead =
	| { kind: "ok"; text: string }
	| { kind: "missing" }
	| { kind: "stopped-early"; limitBytes: number }
	| { kind: "error"; reason: string };

export const FILE_LIMIT_BYTES = 1024 * 1024;
export const SKILL_DESCRIPTION_CAP_CHARS = 1536;
export const MEMORY_HEAD_LINES = 200;
const IMPORT_DEPTH_LIMIT = 5;
const WALK_ENTRY_LIMIT = 5000;

export const NOT_MEASURED = [
	"Claude Code's own system prompt and built-in tool schemas",
	"MCP server instructions and tool schemas",
	"plugin skills",
	"skill-listing budget truncation, which depends on the session model's context window",
	"hook-injected context",
];

export function readBounded(path: string, limitBytes = FILE_LIMIT_BYTES): BoundedRead {
	let descriptor: number;
	try {
		descriptor = openSync(path, "r");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return { kind: "missing" };
		return { kind: "error", reason: describeError(error) };
	}
	try {
		const buffer = Buffer.alloc(limitBytes + 1);
		let filled = 0;
		while (filled < buffer.length) {
			const read = readSync(descriptor, buffer, filled, buffer.length - filled, null);
			if (read === 0) break;
			filled += read;
		}
		if (filled > limitBytes) return { kind: "stopped-early", limitBytes };
		return { kind: "ok", text: buffer.subarray(0, filled).toString("utf8") };
	} catch (error) {
		return { kind: "error", reason: describeError(error) };
	} finally {
		closeSync(descriptor);
	}
}

export function projectSlug(path: string): string {
	return path.replaceAll(/[^A-Za-z0-9]/g, "-");
}

function ancestorsFromRoot(target: string): string[] {
	const chain: string[] = [];
	let current = target;
	const { root } = parse(target);
	for (;;) {
		chain.unshift(current);
		if (current === root) return chain;
		const parent = dirname(current);
		if (parent === current) return chain;
		current = parent;
	}
}

function stripCode(markdown: string): string {
	return markdown.replaceAll(/```[\s\S]*?```/g, "").replaceAll(/`[^`\n]*`/g, "");
}

function importTargets(markdown: string, fromFile: string, env: Env): string[] {
	const targets: string[] = [];
	for (const match of stripCode(markdown).matchAll(/(?:^|\s)@([^\s`)\]]+)/g)) {
		const reference = match[1];
		if (reference === undefined) continue;
		const expanded = reference.startsWith("~/")
			? join(homeDirectory(env), reference.slice(2))
			: reference;
		targets.push(isAbsolute(expanded) ? expanded : resolve(dirname(fromFile), expanded));
	}
	return targets;
}

function walkMarkdown(directory: string, skipped: SkippedSource[]): string[] {
	const found: string[] = [];
	const pending = [directory];
	let visited = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) break;
		let names: string[];
		try {
			names = readdirSync(current);
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) {
				skipped.push({ path: current, reason: describeError(error) });
			}
			continue;
		}
		for (const name of names.sort()) {
			visited += 1;
			if (visited > WALK_ENTRY_LIMIT) {
				skipped.push({
					path: directory,
					reason: `stopped early after ${WALK_ENTRY_LIMIT} entries`,
				});
				return found;
			}
			const child = join(current, name);
			try {
				const stats = statSync(child);
				if (stats.isDirectory()) pending.push(child);
				else if (stats.isFile() && name.endsWith(".md")) found.push(child);
			} catch (error) {
				skipped.push({ path: child, reason: describeError(error) });
			}
		}
	}
	return found.sort();
}

function listSkillFiles(directory: string, skipped: SkippedSource[]): string[] {
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) {
			skipped.push({ path: directory, reason: describeError(error) });
		}
		return [];
	}
	return names.sort().map((name) => join(directory, name, "SKILL.md"));
}

export function enumeratePrefix(target: string, env: Env): Enumeration {
	const claudeConfigDir = claudeCode.configDir(env);
	const components: PrefixComponent[] = [];
	const skipped: SkippedSource[] = [];
	const seen = new Set<string>();

	const canonical = (path: string): string => {
		try {
			return realpathSync(path);
		} catch {
			return path;
		}
	};

	const readSource = (path: string): string | null => {
		const read = readBounded(path);
		switch (read.kind) {
			case "ok":
				return read.text;
			case "missing":
				return null;
			case "stopped-early":
				skipped.push({ path, reason: `stopped early: larger than ${read.limitBytes} bytes` });
				return null;
			case "error":
				skipped.push({ path, reason: read.reason });
				return null;
		}
	};

	const addMemoryFile = (
		path: string,
		kind: "claude-md" | "claude-md-import",
		note: string | null,
		depth: number,
	) => {
		const key = canonical(path);
		if (seen.has(key)) return;
		const text = readSource(path);
		if (text === null) return;
		seen.add(key);
		components.push({ kind, path, label: path, text, note });
		if (depth >= IMPORT_DEPTH_LIMIT) {
			if (importTargets(text, path, env).length > 0) {
				skipped.push({ path, reason: `imports beyond depth ${IMPORT_DEPTH_LIMIT} not followed` });
			}
			return;
		}
		for (const imported of importTargets(text, path, env)) {
			addMemoryFile(imported, "claude-md-import", `imported by ${path}`, depth + 1);
		}
	};

	addMemoryFile(join(claudeConfigDir, "CLAUDE.md"), "claude-md", "user memory", 0);
	for (const directory of ancestorsFromRoot(target)) {
		for (const name of ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"]) {
			addMemoryFile(join(directory, name), "claude-md", null, 0);
		}
	}

	for (const rulesDir of [join(claudeConfigDir, "rules"), join(target, ".claude", "rules")]) {
		for (const path of walkMarkdown(rulesDir, skipped)) {
			const key = canonical(path);
			if (seen.has(key)) continue;
			const text = readSource(path);
			if (text === null) continue;
			seen.add(key);
			const frontmatter = parseFrontmatter(text);
			if (frontmatter.kind === "ok" && frontmatter.fields.paths !== undefined) {
				skipped.push({ path, reason: "path-scoped rule: loads only when matching files are read" });
				continue;
			}
			components.push({ kind: "rule", path, label: path, text, note: null });
		}
	}

	const memoryPath = join(claudeConfigDir, "projects", projectSlug(target), "memory", "MEMORY.md");
	const memory = readSource(memoryPath);
	if (memory !== null) {
		const head = memory.split("\n").slice(0, MEMORY_HEAD_LINES).join("\n");
		components.push({
			kind: "memory",
			path: memoryPath,
			label: memoryPath,
			text: head,
			note: `first ${MEMORY_HEAD_LINES} lines`,
		});
	}

	for (const skillsDir of [join(claudeConfigDir, "skills"), join(target, ".claude", "skills")]) {
		for (const path of listSkillFiles(skillsDir, skipped)) {
			const key = canonical(path);
			if (seen.has(key)) continue;
			const text = readSource(path);
			if (text === null) continue;
			seen.add(key);
			const frontmatter = parseFrontmatter(text);
			if (frontmatter.kind !== "ok") {
				skipped.push({ path, reason: `frontmatter ${frontmatter.kind}` });
				continue;
			}
			const { fields } = frontmatter;
			if (fields["disable-model-invocation"] === true) {
				skipped.push({ path, reason: "disable-model-invocation: not listed to the model" });
				continue;
			}
			const name =
				typeof fields.name === "string" && fields.name !== ""
					? fields.name
					: parse(dirname(path)).base;
			const description = typeof fields.description === "string" ? fields.description.trim() : "";
			const capped = description.slice(0, SKILL_DESCRIPTION_CAP_CHARS);
			components.push({
				kind: "skill-description",
				path,
				label: `skill ${name}`,
				text: `- ${name}: ${capped}`,
				note:
					description.length > capped.length
						? `description cut at ${SKILL_DESCRIPTION_CAP_CHARS} chars`
						: null,
			});
		}
	}

	return { claudeConfigDir, components, skipped, notMeasured: [...NOT_MEASURED] };
}
