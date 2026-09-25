import { statSync } from "node:fs";
import { resolve } from "node:path";
import { formatTable } from "../../commands/context.js";
import { countTokens, TOKENIZER_NAME, TOKENIZER_NOTE } from "../../tokenize.js";
import type { CommandIo } from "../types.js";
import { type Calibration, calibrate } from "./calibrate.js";
import { enumeratePrefix, type PrefixComponent } from "./enumerate.js";

export type MeasuredComponent = Omit<PrefixComponent, "text"> & { chars: number; tokens: number };

export type Suggestion = { path: string; message: string };

const LARGE_FILE_TOKENS = 1500;
const LARGE_DESCRIPTION_TOKENS = 150;

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function largestSection(
	text: string,
): { heading: string; startByte: number; endByte: number; tokens: number } | null {
	const headings = [...text.matchAll(/^#{1,3} .+$/gm)];
	let best: { heading: string; startByte: number; endByte: number; tokens: number } | null = null;
	headings.forEach((match, index) => {
		const start = match.index;
		const end = headings[index + 1]?.index ?? text.length;
		const section = text.slice(start, end);
		const tokens = countTokens(section);
		if (best === null || tokens > best.tokens) {
			best = {
				heading: match[0].replace(/^#+ /, ""),
				startByte: Buffer.byteLength(text.slice(0, start)),
				endByte: Buffer.byteLength(text.slice(0, end)),
				tokens,
			};
		}
	});
	return best;
}

function suggestionsFor(
	components: readonly PrefixComponent[],
	measured: readonly MeasuredComponent[],
): Suggestion[] {
	const suggestions: Suggestion[] = [];
	measured.forEach((component, index) => {
		const source = components[index];
		if (source === undefined) return;
		if (
			(component.kind === "claude-md" ||
				component.kind === "claude-md-import" ||
				component.kind === "rule") &&
			component.tokens > LARGE_FILE_TOKENS
		) {
			const section = largestSection(source.text);
			suggestions.push({
				path: component.path,
				message:
					section === null
						? `~${component.tokens} tokens every turn; split it or move rarely needed parts into a skill`
						: `~${component.tokens} tokens every turn; largest section "${section.heading}" (bytes ${section.startByte}-${section.endByte}, ~${section.tokens} tokens) could move into a skill`,
			});
		}
		if (component.kind === "skill-description" && component.tokens > LARGE_DESCRIPTION_TOKENS) {
			suggestions.push({
				path: component.path,
				message: `${component.label} lists ~${component.tokens} tokens every turn; shorten the description, or set disable-model-invocation if only a person invokes it`,
			});
		}
	});
	return suggestions;
}

function describeCalibration(calibration: Calibration): string[] {
	switch (calibration.kind) {
		case "ok":
			return [
				`transcript ${calibration.transcript}`,
				`provider-reported input on the first assistant turn: ${calibration.providerInputTokens} tokens (input ${calibration.breakdown.input}, cache creation ${calibration.breakdown.cacheCreation}, cache read ${calibration.breakdown.cacheRead})`,
				`attributed ≈ ${calibration.attributedTokens} (audited components plus ~${calibration.firstPromptTokens} for the first prompt, ${TOKENIZER_NAME})`,
				`unattributed ≈ ${calibration.unattributedTokens} (system prompt, tool schemas, MCP, hook context, and tokenizer difference)`,
			];
		case "no-transcript":
			return [`no transcript found (looked in ${calibration.searched})`];
		case "stopped-early":
			return [
				`stopped early: read ${calibration.limitBytes} bytes of ${calibration.transcript} without reaching an assistant turn`,
			];
		case "no-usage":
			return [`${calibration.transcript} holds no assistant turn with usage yet`];
		case "error":
			return [`could not read ${calibration.path}: ${calibration.reason}`];
	}
}

export async function runPrefixAudit(
	argument: string | undefined,
	options: Record<string, unknown>,
	io: CommandIo,
): Promise<number> {
	const target = resolve(io.cwd, argument ?? ".");
	if (!isDirectory(target)) {
		io.err(`not a directory: ${target}`);
		return 2;
	}
	const enumeration = enumeratePrefix(target, io.env);
	const measured = enumeration.components.map(({ text, ...rest }) => ({
		...rest,
		chars: text.length,
		tokens: countTokens(text),
	}));
	const totalTokens = measured.reduce((sum, component) => sum + component.tokens, 0);
	const suggestions = suggestionsFor(enumeration.components, measured);
	const calibration =
		options.calibrate === true ? calibrate(target, enumeration.claudeConfigDir, totalTokens) : null;
	const ranked = [...measured].sort((left, right) => right.tokens - left.tokens);

	if (options.json === true) {
		io.out(
			JSON.stringify(
				{
					target,
					tokenizer: { name: TOKENIZER_NAME, note: TOKENIZER_NOTE },
					totalTokens,
					components: ranked,
					skipped: enumeration.skipped,
					notMeasured: enumeration.notMeasured,
					suggestions,
					calibration,
				},
				null,
				2,
			),
		);
		return 0;
	}

	io.out(`prefix-audit ${target}`);
	io.out(`tokenizer: ${TOKENIZER_NOTE}`);
	const rows = ranked.map((component) => [
		`~${component.tokens}`,
		String(component.chars),
		component.kind,
		component.note === null ? component.label : `${component.label} (${component.note})`,
	]);
	for (const line of formatTable(["TOKENS", "CHARS", "KIND", "SOURCE"], rows)) io.out(line);
	io.out(`total ≈ ${totalTokens} tokens across ${measured.length} components`);
	if (enumeration.skipped.length > 0) {
		io.out("skipped:");
		for (const skipped of enumeration.skipped) io.out(`  ${skipped.path}: ${skipped.reason}`);
	}
	io.out(`not measured: ${enumeration.notMeasured.join("; ")}`);
	if (suggestions.length > 0) {
		io.out("suggestions:");
		for (const suggestion of suggestions) io.out(`  ${suggestion.path}: ${suggestion.message}`);
	}
	if (calibration !== null) {
		io.out("calibration:");
		for (const line of describeCalibration(calibration)) io.out(`  ${line}`);
	}
	return 0;
}
