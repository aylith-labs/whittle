import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type Env, homeDirectory } from "../config.js";
import type { HookEvent } from "../hook/types.js";
import { readString } from "../json.js";
import { renderNestedOutput } from "./nested-output.js";
import { buildGroups, eventFromSpecs, isWhittleHookCommand, normalisePayload } from "./shared.js";
import type { HarnessAdapter, NativeHookSpec, OutputChannels } from "./types.js";

const FILE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

export const CLAUDE_CODE_HOOK_SPECS: readonly NativeHookSpec[] = [
	{ event: "session.start", nativeEvent: "SessionStart", matcher: null, async: false, timeout: 5 },
	{
		event: "prompt.submit",
		nativeEvent: "UserPromptSubmit",
		matcher: null,
		async: false,
		timeout: 8,
	},
	{ event: "tool.pre", nativeEvent: "PreToolUse", matcher: "Bash", async: false, timeout: 3 },
	{
		event: "tool.post",
		nativeEvent: "PostToolUse",
		matcher: "Write|Edit|MultiEdit",
		async: true,
		timeout: 5,
	},
	{ event: "turn.stop", nativeEvent: "Stop", matcher: null, async: true, timeout: 5 },
];

function configDir(env: Env): string {
	const override = env.CLAUDE_CONFIG_DIR;
	return override !== undefined && override !== "" && isAbsolute(override)
		? override
		: join(homeDirectory(env), ".claude");
}

function editedFiles(toolName: string, input: Record<string, unknown>): string[] {
	if (!FILE_EDIT_TOOLS.has(toolName)) return [];
	const filePath = readString(input, "file_path");
	return filePath === null ? [] : [filePath];
}

function outputChannels(event: HookEvent): OutputChannels {
	return {
		context: event === "session.start" || event === "prompt.submit",
		updatedInput: event === "tool.pre",
	};
}

export const claudeCode: HarnessAdapter = {
	id: "claude-code",
	timeoutUnit: "seconds",
	hookSpecs: CLAUDE_CODE_HOOK_SPECS,
	trustsByPosition: false,
	configDir,
	hookFile: (env) => join(configDir(env), "settings.json"),
	detect: (env) => {
		const directory = configDir(env);
		return { installed: existsSync(directory), configDir: directory };
	},
	desiredGroups: (binCommand) => buildGroups(CLAUDE_CODE_HOOK_SPECS, binCommand, "claude-code"),
	isOurCommand: (command, binCommand) => isWhittleHookCommand(command, "claude-code", binCommand),
	eventFromNative: (nativeEvent) => eventFromSpecs(CLAUDE_CODE_HOOK_SPECS, nativeEvent),
	normalise: (event, payload, fallbackCwd) =>
		normalisePayload("claude-code", event, payload, fallbackCwd, editedFiles),
	outputChannels,
	render: (event, output, normalised) =>
		renderNestedOutput(CLAUDE_CODE_HOOK_SPECS, outputChannels(event), event, output, normalised),
	installNotes: () => [],
};
