import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import type { HarnessAdapter } from "./types.js";

export const adapters: readonly HarnessAdapter[] = [claudeCode, codex];

export function findAdapter(id: string): HarnessAdapter | undefined {
	return adapters.find((adapter) => adapter.id === id);
}
