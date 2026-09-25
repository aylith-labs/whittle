export type HarnessId = "claude-code" | "codex";

export const HARNESS_IDS: readonly HarnessId[] = ["claude-code", "codex"];

export type HookEvent =
	| "session.start"
	| "prompt.submit"
	| "tool.pre"
	| "tool.post"
	| "turn.stop"
	| "compact.pre"
	| "session.end";

export type ToolCall = {
	name: string;
	input: Record<string, unknown>;
	output: unknown;
	editedFiles: string[];
	command: string | null;
};

export type NormalisedEvent = {
	event: HookEvent;
	harness: HarnessId;
	sessionId: string | null;
	cwd: string;
	tool: ToolCall | null;
	prompt: string | null;
	transcriptPath: string | null;
	raw: unknown;
};

export type LeverOutput = {
	context?: string;
	updatedInput?: Record<string, unknown>;
};

export type MergedOutput = {
	contexts: string[];
	updatedInput: Record<string, unknown> | null;
};

export function isHarnessId(value: string): value is HarnessId {
	return (HARNESS_IDS as readonly string[]).includes(value);
}
