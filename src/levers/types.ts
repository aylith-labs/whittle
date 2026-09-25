import type { Env, WhittlePaths } from "../config.js";
import type { HarnessId, HookEvent, LeverOutput, NormalisedEvent } from "../hook/types.js";
import type { RepoRef } from "../repo.js";

export type Layer = "L1" | "L2" | "L3" | "L4" | "L5" | "L6";

export type LeverShape = "hook" | "mcp" | "cli" | "proxy" | "ruleset" | "report";

export type LeverDependency = {
	kind: "binary" | "npm";
	name: string;
	versionArgs: readonly string[];
	install: string;
	licence: string;
};

export type ExternalEvidence = { summary: string; source: string };

export type HomeWrite = {
	by: string;
	description: string;
	path: (env: Env, platform: NodeJS.Platform) => string;
};

export type LeverContext = {
	options: Record<string, unknown>;
	env: Env;
	paths: WhittlePaths;
	repo: RepoRef;
	log: (message: string) => void;
};

export type CommandIo = {
	env: Env;
	cwd: string;
	out: (line: string) => void;
	err: (line: string) => void;
};

export type LeverCommandOption = { flags: string; description: string };

export interface LeverRuntime {
	onEvent(event: NormalisedEvent, context: LeverContext): Promise<LeverOutput | null>;
}

export interface LeverCommand {
	readonly name: string;
	readonly summary: string;
	readonly argument: { name: string; description: string } | null;
	readonly options: readonly LeverCommandOption[];
	run(
		argument: string | undefined,
		options: Record<string, unknown>,
		io: CommandIo,
	): Promise<number>;
}

export interface LeverDescriptor {
	readonly id: string;
	readonly layers: readonly Layer[];
	readonly shape: LeverShape;
	readonly defaultEnabled: boolean;
	readonly harnesses: Partial<Record<HarnessId, { enforces: boolean }>>;
	readonly dependency: LeverDependency | null;
	readonly events: readonly HookEvent[];
	readonly capMs: Partial<Record<HookEvent, number>>;
	readonly defaultOptions: Readonly<Record<string, unknown>>;
	readonly external: readonly ExternalEvidence[];
	// Writes a lever's dependency makes outside whittle's own footprint, stated so nobody claims zero home writes.
	readonly homeWrites: readonly HomeWrite[];
	readonly commands: readonly LeverCommand[];
	// Runtime code loads only after the dispatcher knows the repository is enabled.
	readonly load: (() => Promise<LeverRuntime>) | null;
}
