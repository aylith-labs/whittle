import type { Env } from "../config.js";
import type { HarnessId, HookEvent, MergedOutput, NormalisedEvent } from "../hook/types.js";

export type NativeHookSpec = {
	event: HookEvent;
	nativeEvent: string;
	matcher: string | null;
	async: boolean;
	timeout: number | null;
};

export type DesiredHookGroup = { nativeEvent: string; group: Record<string, unknown> };

export type HarnessDetection = { installed: boolean; configDir: string };

export type OutputChannels = { context: boolean; updatedInput: boolean };

export type InstallSummary = {
	changedEvents: readonly string[];
	shiftedEvents: readonly string[];
};

export type McpServerSpec = { name: string; command: readonly string[] };

export type McpRegistrationResult =
	| { kind: "registered"; detail: string }
	| { kind: "unchanged"; detail: string }
	| { kind: "refused"; reason: string };

export interface McpRegistrar {
	register(server: McpServerSpec, env: Env): Promise<McpRegistrationResult>;
	unregister(serverName: string, env: Env): Promise<McpRegistrationResult>;
}

export interface HarnessAdapter {
	readonly id: HarnessId;
	readonly timeoutUnit: "seconds";
	readonly hookSpecs: readonly NativeHookSpec[];
	// A harness that trusts hook entries by array position must never have entries inserted before existing ones.
	readonly trustsByPosition: boolean;
	readonly mcp?: McpRegistrar;
	configDir(env: Env): string;
	hookFile(env: Env): string;
	detect(env: Env): HarnessDetection;
	desiredGroups(binCommand: string): DesiredHookGroup[];
	isOurCommand(command: string, binCommand: string | null): boolean;
	eventFromNative(nativeEvent: string): HookEvent | null;
	normalise(event: HookEvent, payload: unknown, fallbackCwd: string): NormalisedEvent;
	outputChannels(event: HookEvent): OutputChannels;
	render(event: HookEvent, output: MergedOutput, normalised: NormalisedEvent): string | null;
	installNotes(summary: InstallSummary): string[];
}
