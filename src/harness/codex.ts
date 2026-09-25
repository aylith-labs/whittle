import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type Env, homeDirectory } from "../config.js";
import type { HookEvent } from "../hook/types.js";
import { readString } from "../json.js";
import { renderNestedOutput } from "./nested-output.js";
import { buildGroups, eventFromSpecs, isWhittleHookCommand, normalisePayload } from "./shared.js";
import type { HarnessAdapter, InstallSummary, NativeHookSpec, OutputChannels } from "./types.js";

const PATCH_FILE_LINE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$/gm;

export const CODEX_HOOK_SPECS: readonly NativeHookSpec[] = [
	{
		event: "session.start",
		nativeEvent: "SessionStart",
		matcher: "startup|resume|compact",
		async: false,
		timeout: 5,
	},
	{
		event: "prompt.submit",
		nativeEvent: "UserPromptSubmit",
		matcher: null,
		async: false,
		timeout: 8,
	},
	{ event: "tool.pre", nativeEvent: "PreToolUse", matcher: "^Bash$", async: false, timeout: 3 },
	{
		event: "tool.post",
		nativeEvent: "PostToolUse",
		matcher: "^(apply_patch|Write|Edit)$",
		async: true,
		timeout: 5,
	},
	{ event: "turn.stop", nativeEvent: "Stop", matcher: null, async: true, timeout: 5 },
];

function codexHome(env: Env): string {
	const override = env.CODEX_HOME;
	return override !== undefined && override !== "" && isAbsolute(override)
		? override
		: join(homeDirectory(env), ".codex");
}

export function patchedFiles(patch: string): string[] {
	return [...new Set([...patch.matchAll(PATCH_FILE_LINE)].flatMap((match) => match[1] ?? []))];
}

function editedFiles(toolName: string, input: Record<string, unknown>): string[] {
	if (toolName === "apply_patch") return patchedFiles(readString(input, "command") ?? "");
	if (toolName !== "Write" && toolName !== "Edit") return [];
	const filePath = readString(input, "file_path");
	return filePath === null ? [] : [filePath];
}

function outputChannels(event: HookEvent): OutputChannels {
	return {
		context: event === "session.start" || event === "prompt.submit",
		updatedInput: event === "tool.pre",
	};
}

function installNotes(summary: InstallSummary): string[] {
	const notes: string[] = [];
	if (summary.changedEvents.length > 0) {
		notes.push(
			`Codex trusts each hook entry by its position and content. whittle writes no trusted_hash, so approve the whittle entries for ${summary.changedEvents.join(", ")} when Codex asks (entries printed above).`,
		);
	}
	if (summary.shiftedEvents.length > 0) {
		notes.push(
			`Removing duplicate whittle entries moved later entries in ${summary.shiftedEvents.join(", ")}; Codex will ask to trust those again.`,
		);
	}
	return notes;
}

export const codex: HarnessAdapter = {
	id: "codex",
	timeoutUnit: "seconds",
	hookSpecs: CODEX_HOOK_SPECS,
	trustsByPosition: true,
	configDir: codexHome,
	hookFile: (env) => join(codexHome(env), "hooks.json"),
	detect: (env) => {
		const directory = codexHome(env);
		return { installed: existsSync(directory), configDir: directory };
	},
	desiredGroups: (binCommand) => buildGroups(CODEX_HOOK_SPECS, binCommand, "codex"),
	isOurCommand: (command, binCommand) => isWhittleHookCommand(command, "codex", binCommand),
	eventFromNative: (nativeEvent) => eventFromSpecs(CODEX_HOOK_SPECS, nativeEvent),
	normalise: (event, payload, fallbackCwd) =>
		normalisePayload("codex", event, payload, fallbackCwd, editedFiles),
	outputChannels,
	render: (event, output, normalised) =>
		renderNestedOutput(CODEX_HOOK_SPECS, outputChannels(event), event, output, normalised),
	installNotes,
};
