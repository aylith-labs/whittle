import type { HookEvent, MergedOutput, NormalisedEvent } from "../hook/types.js";
import { nativeEventFor } from "./shared.js";
import type { NativeHookSpec, OutputChannels } from "./types.js";

export function renderNestedOutput(
	specs: readonly NativeHookSpec[],
	channels: OutputChannels,
	event: HookEvent,
	output: MergedOutput,
	normalised: NormalisedEvent,
): string | null {
	const hookEventName = nativeEventFor(specs, event);
	if (hookEventName === null) return null;
	if (channels.updatedInput && output.updatedInput !== null) {
		// updatedInput replaces the whole tool input, so untouched fields are carried over; no permissionDecision is sent, leaving the user's permission rules in charge.
		const updatedInput = { ...(normalised.tool?.input ?? {}), ...output.updatedInput };
		return JSON.stringify({ hookSpecificOutput: { hookEventName, updatedInput } });
	}
	if (channels.context && output.contexts.length > 0) {
		const additionalContext = output.contexts.join("\n\n");
		return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } });
	}
	return null;
}
