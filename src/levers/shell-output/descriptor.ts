import type { LeverDescriptor } from "../types.js";
import { DEFAULT_ALLOW } from "./allowlist.js";
import { rtkHistoryPath } from "./rtk-history.js";

export const shellOutput: LeverDescriptor = {
	id: "shell-output",
	layers: ["L3"],
	shape: "hook",
	defaultEnabled: false,
	harnesses: { "claude-code": { enforces: true }, codex: { enforces: false } },
	dependency: {
		kind: "binary",
		name: "rtk",
		versionArgs: ["--version"],
		install: "install rtk yourself from https://github.com/rtk-ai/rtk; whittle never installs it",
		licence: "Apache-2.0",
	},
	events: ["tool.pre"],
	capMs: { "tool.pre": 30 },
	defaultOptions: { allow: [...DEFAULT_ALLOW] },
	external: [{ summary: "+7.6% cost", source: "JetBrains paired run, 80 tasks" }],
	homeWrites: [
		{ by: "rtk", description: "rtk records each filtered command", path: rtkHistoryPath },
	],
	commands: [],
	load: () => import("./runtime.js").then((module) => module.shellOutputRuntime),
};
