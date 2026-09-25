import { isAbsolute } from "node:path";
import type { HarnessId, HookEvent, NormalisedEvent } from "../hook/types.js";
import { isRecord, readString } from "../json.js";
import type { DesiredHookGroup, NativeHookSpec } from "./types.js";

export function hookCommand(binCommand: string, nativeEvent: string, harness: HarnessId): string {
	return `${binCommand} hook ${nativeEvent} --harness ${harness}`;
}

export function buildGroups(
	specs: readonly NativeHookSpec[],
	binCommand: string,
	harness: HarnessId,
): DesiredHookGroup[] {
	return specs.map((spec) => {
		const hook: Record<string, unknown> = {
			type: "command",
			command: hookCommand(binCommand, spec.nativeEvent, harness),
		};
		if (spec.timeout !== null) hook.timeout = spec.timeout;
		if (spec.async) hook.async = true;
		const group: Record<string, unknown> =
			spec.matcher === null ? { hooks: [hook] } : { matcher: spec.matcher, hooks: [hook] };
		return { nativeEvent: spec.nativeEvent, group };
	});
}

export function isWhittleHookCommand(
	command: string,
	harness: HarnessId,
	binCommand: string | null,
): boolean {
	const suffix = new RegExp(`\\s+hook\\s+[A-Za-z]+\\s+--harness\\s+${harness}\\s*$`);
	if (!suffix.test(command)) return false;
	if (binCommand !== null && command.startsWith(`${binCommand} hook `)) return true;
	return /whittle[^'"\s]*['"]?\s+hook\s/.test(command);
}

export function eventFromSpecs(
	specs: readonly NativeHookSpec[],
	nativeEvent: string,
): HookEvent | null {
	return specs.find((spec) => spec.nativeEvent === nativeEvent)?.event ?? null;
}

export function nativeEventFor(specs: readonly NativeHookSpec[], event: HookEvent): string | null {
	return specs.find((spec) => spec.event === event)?.nativeEvent ?? null;
}

export function normalisePayload(
	harness: HarnessId,
	event: HookEvent,
	payload: unknown,
	fallbackCwd: string,
	editedFilesOf: (toolName: string, input: Record<string, unknown>) => string[],
): NormalisedEvent {
	const record = isRecord(payload) ? payload : {};
	const payloadCwd = readString(record, "cwd");
	const toolName = readString(record, "tool_name");
	const toolInput = isRecord(record.tool_input) ? record.tool_input : {};
	return {
		event,
		harness,
		sessionId: readString(record, "session_id") ?? readString(record, "conversation_id"),
		cwd: payloadCwd !== null && isAbsolute(payloadCwd) ? payloadCwd : fallbackCwd,
		tool:
			toolName === null
				? null
				: {
						name: toolName,
						input: toolInput,
						output: record.tool_response ?? null,
						editedFiles: editedFilesOf(toolName, toolInput),
						command: readString(toolInput, "command"),
					},
		prompt: readString(record, "prompt"),
		transcriptPath: readString(record, "transcript_path"),
		raw: payload,
	};
}
