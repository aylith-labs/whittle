import { prefixAudit } from "./prefix-audit/descriptor.js";
import { shellOutput } from "./shell-output/descriptor.js";
import type { LeverDescriptor } from "./types.js";

// Declared order is dispatch order: the first lever to claim updatedInput on an event keeps it.
export const levers: readonly LeverDescriptor[] = [shellOutput, prefixAudit];

export function findLever(id: string): LeverDescriptor | undefined {
	return levers.find((lever) => lever.id === id);
}
