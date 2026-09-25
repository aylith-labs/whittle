import type { LeverDescriptor } from "../types.js";

export const prefixAudit: LeverDescriptor = {
	id: "prefix-audit",
	layers: ["L1", "L2"],
	shape: "report",
	defaultEnabled: true,
	harnesses: { "claude-code": { enforces: false } },
	dependency: null,
	events: [],
	capMs: {},
	defaultOptions: {},
	external: [],
	homeWrites: [],
	commands: [
		{
			name: "prefix-audit",
			summary: "rank what rides every turn for a directory, in approximate tokens",
			argument: {
				name: "path",
				description: "directory to audit (default: the current directory)",
			},
			options: [
				{ flags: "--json", description: "print the report as JSON" },
				{
					flags: "--calibrate",
					description: "compare against the newest transcript's provider-reported usage",
				},
			],
			run: async (argument, options, io) => {
				const { runPrefixAudit } = await import("./report.js");
				return runPrefixAudit(argument, options, io);
			},
		},
	],
	load: null,
};
