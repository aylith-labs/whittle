import {
	type Env,
	leverIsEnabled,
	loadConfig,
	loadRepos,
	loadState,
	type MeasurementSummary,
	repoIsEnabled,
	resolvePaths,
} from "../config.js";
import { type HookFileInspection, inspectHookFile } from "../config-writer.js";
import { formatDay } from "../dates.js";
import { describeProbe, probeDependency } from "../dependency.js";
import { adapters } from "../harness/registry.js";
import { footprintRows, formatFootprint, measureBytes } from "../ledger.js";
import { describeHomeWrites } from "../levers/home-writes.js";
import { levers } from "../levers/registry.js";
import type { LeverDescriptor } from "../levers/types.js";
import { findRepo } from "../repo.js";
import { resolveBinCommand } from "../self.js";
import { VERSION } from "../version.js";
import { type CommandContext, formatTable } from "./context.js";

export function describeMeasurement(measurement: MeasurementSummary | undefined): string {
	if (measurement === undefined) return "unmeasured";
	const sign = measurement.costDeltaPct > 0 ? "+" : "";
	return `${sign}${measurement.costDeltaPct}% cost (n=${measurement.n}, ${measurement.task}, ${formatDay(measurement.at)})`;
}

function describeEnforcement(lever: LeverDescriptor): string {
	const entries = Object.entries(lever.harnesses);
	if (entries.length === 0) return "none";
	return entries.map(([id, harness]) => `${id}:${harness.enforces ? "yes" : "no"}`).join(" ");
}

function dependencyStatus(lever: LeverDescriptor, env: Env) {
	if (lever.dependency === null) return null;
	const probe = probeDependency(lever.dependency, env);
	return {
		name: lever.dependency.name,
		found: probe.kind === "found",
		probed: probe.kind !== "not-probed",
		version: probe.kind === "found" ? probe.version : null,
		path: probe.kind === "found" ? probe.path : null,
		description: describeProbe(lever.dependency.name, probe),
	};
}

export async function runLevers(context: CommandContext): Promise<number> {
	const paths = resolvePaths(context.env);
	const config = loadConfig(paths);
	const repos = loadRepos(paths);
	const state = loadState(paths);
	for (const loaded of [config, repos, state]) {
		if (loaded.kind === "invalid") {
			context.err(`${loaded.path}: ${loaded.reason}`);
			return 1;
		}
	}
	if (config.kind === "invalid" || repos.kind === "invalid" || state.kind === "invalid") return 1;
	const lookup = findRepo(context.cwd);
	const entry = lookup.kind === "found" ? repos.value[lookup.repo.repoId] : undefined;
	const rows = levers.map((lever) => {
		let enabledHere = "no repository here";
		if (lookup.kind === "found") {
			const repoOn = repoIsEnabled(config.value, entry);
			const leverOn = leverIsEnabled(lever.id, lever.defaultEnabled, config.value, entry);
			enabledHere = !repoOn ? "no (repository not enabled)" : leverOn ? "yes" : "no";
		}
		return [
			lever.id,
			lever.layers.join("+"),
			lever.shape,
			describeEnforcement(lever),
			dependencyStatus(lever, context.env)?.description ?? "none",
			enabledHere,
			describeMeasurement(state.value.measurements[lever.id]),
		];
	});
	const headers = [
		"LEVER",
		"LAYER",
		"SHAPE",
		"ENFORCES",
		"DEPENDENCY",
		"ENABLED HERE",
		"MEASURED HERE",
	];
	for (const line of formatTable(headers, rows)) context.out(line);
	const external = levers.flatMap((lever) =>
		lever.external.map((evidence) => ({ lever, evidence })),
	);
	if (external.length > 0) {
		context.out("");
		context.out("external evidence (not measured by whittle):");
		for (const { lever, evidence } of external) {
			context.out(`  ${lever.id}: ${evidence.summary} [external: ${evidence.source}]`);
		}
	}
	const homeWrites = levers.flatMap((lever) =>
		describeHomeWrites(lever, context.env).map((line) => ({ lever, line })),
	);
	if (homeWrites.length > 0) {
		context.out("");
		context.out("home-directory writes made by lever dependencies (outside whittle's footprint):");
		for (const { lever, line } of homeWrites) context.out(`  ${lever.id}: ${line}`);
	}
	return 0;
}

function wiring(inspection: HookFileInspection): {
	wired: boolean | null;
	events: string[];
	problem: string | null;
} {
	switch (inspection.kind) {
		case "missing":
			return { wired: false, events: [], problem: null };
		case "refused":
			return { wired: null, events: [], problem: inspection.reason };
		case "ok":
			return {
				wired: inspection.missingEvents.length === 0 && inspection.staleEvents.length === 0,
				events: inspection.wiredEvents,
				problem: null,
			};
	}
}

export function buildStatus(context: CommandContext) {
	const paths = resolvePaths(context.env);
	const config = loadConfig(paths);
	const repos = loadRepos(paths);
	const state = loadState(paths);
	const problems = [config, repos, state].flatMap((loaded) =>
		loaded.kind === "invalid" ? [`${loaded.path}: ${loaded.reason}`] : [],
	);
	if (config.kind === "invalid" || repos.kind === "invalid" || state.kind === "invalid") {
		return { kind: "invalid" as const, problems };
	}
	const bin = resolveBinCommand(context.argv, context.execPath);
	const binCommand = bin.kind === "ok" ? bin.command : null;
	const harnesses = adapters.map((adapter) => {
		const detection = adapter.detect(context.env);
		const hookFile = adapter.hookFile(context.env);
		const inspection =
			binCommand === null
				? ({ kind: "refused", reason: "the whittle executable could not be resolved" } as const)
				: inspectHookFile(hookFile, adapter.desiredGroups(binCommand), (command) =>
						adapter.isOurCommand(command, binCommand),
					);
		const wired = wiring(inspection);
		return {
			id: adapter.id,
			installed: detection.installed,
			wired: wired.wired,
			hookFile,
			events: wired.events,
			problem: wired.problem,
			mcp: false,
		};
	});
	const report = {
		version: VERSION,
		configDir: paths.configDir,
		cacheDir: paths.cacheDir,
		harnesses,
		levers: levers.map((lever) => ({
			id: lever.id,
			layers: [...lever.layers],
			shape: lever.shape,
			enforces: Object.fromEntries(
				Object.entries(lever.harnesses).map(([id, harness]) => [id, harness.enforces]),
			),
			enabled: leverIsEnabled(lever.id, lever.defaultEnabled, config.value, undefined),
			dependency: dependencyStatus(lever, context.env),
			perTurnTokens: null,
			measured: state.value.measurements[lever.id] ?? null,
			external: lever.external.map((evidence) => ({ ...evidence })),
			homeWrites: lever.homeWrites.map((write) => ({
				by: write.by,
				description: write.description,
				path: write.path(context.env, process.platform),
			})),
		})),
		repos: Object.entries(repos.value).map(([id, entry]) => {
			const cache = measureBytes(`${paths.cacheDir}/graphs/${id}`);
			return {
				id,
				root: entry.root,
				enabled: entry.enabled,
				levers: Object.fromEntries(
					levers.map((lever) => [
						lever.id,
						leverIsEnabled(lever.id, lever.defaultEnabled, config.value, entry),
					]),
				),
				cacheBytes: cache.kind === "measured" ? cache.bytes : cache.kind === "absent" ? 0 : null,
			};
		}),
		sessions: {},
		footprint: { ledger: state.value.ledger, residue: null },
	};
	return { kind: "ok" as const, report, footprint: footprintRows(state.value, paths) };
}

export async function runStatus(
	options: { json: boolean },
	context: CommandContext,
): Promise<number> {
	const status = buildStatus(context);
	if (status.kind === "invalid") {
		for (const problem of status.problems) context.err(problem);
		return 1;
	}
	const { report } = status;
	if (options.json) {
		context.out(JSON.stringify(report, null, 2));
		return 0;
	}
	context.out(`whittle ${report.version}`);
	context.out(`config ${report.configDir}`);
	context.out(`cache  ${report.cacheDir}`);
	context.out("harnesses:");
	for (const harness of report.harnesses) {
		const wired =
			harness.wired === null
				? `unknown (${harness.problem ?? "unreadable"})`
				: harness.wired
					? "yes"
					: "no";
		context.out(
			`  ${harness.id}: installed ${harness.installed ? "yes" : "no"}, wired ${wired}, ${harness.hookFile}`,
		);
	}
	context.out("repositories:");
	if (report.repos.length === 0) context.out("  none enabled");
	for (const repo of report.repos) {
		const on = Object.entries(repo.levers)
			.filter(([, enabled]) => enabled)
			.map(([id]) => id);
		context.out(
			`  ${repo.id} ${repo.root}: ${repo.enabled ? `enabled (${on.join(", ") || "no levers"})` : "disabled"}`,
		);
	}
	context.out("footprint:");
	for (const line of formatFootprint(status.footprint)) context.out(`  ${line}`);
	return 0;
}

export async function runFootprint(context: CommandContext): Promise<number> {
	const paths = resolvePaths(context.env);
	const state = loadState(paths);
	if (state.kind === "invalid") {
		context.err(`${state.path}: ${state.reason}`);
		return 1;
	}
	if (state.value.ledger.length === 0)
		context.out("the ledger is empty: whittle has edited no harness file");
	for (const line of formatFootprint(footprintRows(state.value, paths))) context.out(line);
	return 0;
}
