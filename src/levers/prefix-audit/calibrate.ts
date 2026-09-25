import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { describeError, hasErrorCode, isRecord } from "../../json.js";
import { countTokens } from "../../tokenize.js";
import { projectSlug } from "./enumerate.js";

export const TRANSCRIPT_READ_LIMIT_BYTES = 16 * 1024 * 1024;
const TRUNCATED_SLUG_MIN_LENGTH = 64;

export type UsageBreakdown = { input: number; cacheCreation: number; cacheRead: number };

export type Calibration =
	| {
			kind: "ok";
			transcript: string;
			providerInputTokens: number;
			breakdown: UsageBreakdown;
			firstPromptTokens: number;
			attributedTokens: number;
			unattributedTokens: number;
	  }
	| { kind: "no-transcript"; searched: string }
	| { kind: "stopped-early"; transcript: string; limitBytes: number }
	| { kind: "no-usage"; transcript: string }
	| { kind: "error"; path: string; reason: string };

type TranscriptScan =
	| { kind: "usage"; usage: UsageBreakdown; promptText: string; cwd: string | null }
	| { kind: "no-usage"; cwd: string | null }
	| { kind: "stopped-early"; limitBytes: number };

function numberField(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function promptTextOf(message: unknown): string {
	if (!isRecord(message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) =>
			isRecord(block) && block.type === "text" && typeof block.text === "string"
				? [block.text]
				: [],
		)
		.join("\n");
}

function* transcriptLines(
	path: string,
	limitBytes: number,
): Generator<string, "end" | "stopped-early"> {
	const descriptor = openSync(path, "r");
	try {
		const chunk = Buffer.alloc(64 * 1024);
		let pending = "";
		let total = 0;
		for (;;) {
			const read = readSync(descriptor, chunk, 0, chunk.length, null);
			if (read === 0) break;
			total += read;
			if (total > limitBytes) return "stopped-early";
			pending += chunk.subarray(0, read).toString("utf8");
			let newline = pending.indexOf("\n");
			while (newline !== -1) {
				yield pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
			}
		}
		if (pending.trim() !== "") yield pending;
		return "end";
	} finally {
		closeSync(descriptor);
	}
}

export function scanTranscript(
	path: string,
	limitBytes = TRANSCRIPT_READ_LIMIT_BYTES,
): TranscriptScan {
	const prompts: string[] = [];
	let cwd: string | null = null;
	const lines = transcriptLines(path, limitBytes);
	for (let step = lines.next(); ; step = lines.next()) {
		if (step.done) {
			return step.value === "stopped-early"
				? { kind: "stopped-early", limitBytes }
				: { kind: "no-usage", cwd };
		}
		let record: unknown;
		try {
			record = JSON.parse(step.value);
		} catch {
			continue;
		}
		if (!isRecord(record) || record.isSidechain === true) continue;
		if (cwd === null && typeof record.cwd === "string") cwd = record.cwd;
		if (record.type === "user") prompts.push(promptTextOf(record.message));
		if (record.type !== "assistant" || !isRecord(record.message) || !isRecord(record.message.usage))
			continue;
		const usage = record.message.usage;
		lines.return("end");
		return {
			kind: "usage",
			usage: {
				input: numberField(usage, "input_tokens"),
				cacheCreation: numberField(usage, "cache_creation_input_tokens"),
				cacheRead: numberField(usage, "cache_read_input_tokens"),
			},
			promptText: prompts.filter((text) => text !== "").join("\n"),
			cwd,
		};
	}
}

function newestTranscript(directory: string): string | null {
	let newest: { path: string; mtimeMs: number } | null = null;
	for (const name of readdirSync(directory)) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(directory, name);
		const stats = statSync(path);
		if (stats.isFile() && (newest === null || stats.mtimeMs > newest.mtimeMs))
			newest = { path, mtimeMs: stats.mtimeMs };
	}
	return newest?.path ?? null;
}

function candidateDirectories(projectsDir: string, target: string): string[] {
	const slug = projectSlug(target);
	let names: string[];
	try {
		names = readdirSync(projectsDir);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return [];
		throw error;
	}
	if (names.includes(slug)) return [join(projectsDir, slug)];
	return names
		.filter((name) => name.length >= TRUNCATED_SLUG_MIN_LENGTH && slug.startsWith(name))
		.sort((left, right) => right.length - left.length)
		.map((name) => join(projectsDir, name));
}

export function calibrate(
	target: string,
	claudeConfigDir: string,
	auditedTokens: number,
): Calibration {
	const projectsDir = join(claudeConfigDir, "projects");
	const searched = join(projectsDir, projectSlug(target));
	let directories: string[];
	try {
		directories = candidateDirectories(projectsDir, target);
	} catch (error) {
		return { kind: "error", path: projectsDir, reason: describeError(error) };
	}
	const exact = directories.length === 1 && directories[0] === searched;
	for (const directory of directories) {
		let transcript: string | null;
		try {
			transcript = newestTranscript(directory);
		} catch (error) {
			return { kind: "error", path: directory, reason: describeError(error) };
		}
		if (transcript === null) continue;
		let scan: TranscriptScan;
		try {
			scan = scanTranscript(transcript);
		} catch (error) {
			return { kind: "error", path: transcript, reason: describeError(error) };
		}
		if (scan.kind === "stopped-early") {
			return { kind: "stopped-early", transcript, limitBytes: scan.limitBytes };
		}
		// A truncated project slug can collide, so only a transcript recorded in this exact directory counts.
		if (!exact && scan.cwd !== target) continue;
		if (scan.kind === "no-usage") return { kind: "no-usage", transcript };
		const providerInputTokens = scan.usage.input + scan.usage.cacheCreation + scan.usage.cacheRead;
		const firstPromptTokens = countTokens(scan.promptText);
		const attributedTokens = auditedTokens + firstPromptTokens;
		return {
			kind: "ok",
			transcript,
			providerInputTokens,
			breakdown: scan.usage,
			firstPromptTokens,
			attributedTokens,
			unattributedTokens: providerInputTokens - attributedTokens,
		};
	}
	return { kind: "no-transcript", searched };
}
