import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ensureConfigFile,
	type HarnessFileRecord,
	loadConfig,
	loadState,
	resolvePaths,
	updateState,
	type WhittleConfig,
} from "../config.js";
import { type HookChange, planInstall, writeHookFile } from "../config-writer.js";
import { adapters, findAdapter } from "../harness/registry.js";
import type { HarnessAdapter } from "../harness/types.js";
import { describeError, hasErrorCode, stripBom } from "../json.js";
import { footprintRows, formatFootprint, recordLedgerEntry } from "../ledger.js";
import { levers } from "../levers/registry.js";
import { resolveBinCommand } from "../self.js";
import { VERSION } from "../version.js";
import { type CommandContext, parseIdList } from "./context.js";

export type InstallOptions = { harness: string | null; dryRun: boolean };

export function selectAdapters(
	harnessList: string | null,
): { kind: "ok"; adapters: HarnessAdapter[] } | { kind: "unknown"; id: string } {
	const ids = parseIdList(harnessList);
	if (ids.length === 0) return { kind: "ok", adapters: [...adapters] };
	const selected: HarnessAdapter[] = [];
	for (const id of ids) {
		const adapter = findAdapter(id);
		if (adapter === undefined) return { kind: "unknown", id };
		selected.push(adapter);
	}
	return { kind: "ok", adapters: selected };
}

function schemaReference(): string | null {
	try {
		const path = fileURLToPath(new URL("../../schema/config.schema.json", import.meta.url));
		return existsSync(path) ? path : null;
	} catch {
		return null;
	}
}

export function initialConfig(): WhittleConfig & { $schema?: string } {
	const config: WhittleConfig = {
		version: 1,
		harnesses: {},
		repos: { default: "off" },
		levers: Object.fromEntries(
			levers.map((lever) => [lever.id, { enabled: lever.defaultEnabled, ...lever.defaultOptions }]),
		),
	};
	const schema = schemaReference();
	return schema === null ? config : { $schema: schema, ...config };
}

export function describeChanges(changes: readonly HookChange[]): string {
	const counts = new Map<string, number>();
	for (const change of changes) counts.set(change.action, (counts.get(change.action) ?? 0) + 1);
	return (
		[...counts.entries()].map(([action, count]) => `${count} ${action}`).join(", ") || "no changes"
	);
}

function readCurrent(
	path: string,
): { kind: "ok"; text: string | null } | { kind: "error"; reason: string } {
	try {
		return { kind: "ok", text: stripBom(readFileSync(path, "utf8")) };
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return { kind: "ok", text: null };
		return { kind: "error", reason: describeError(error) };
	}
}

function printPreview(
	adapter: HarnessAdapter,
	hookFile: string,
	binCommand: string,
	context: CommandContext,
): number {
	const desired = adapter.desiredGroups(binCommand);
	const current = readCurrent(hookFile);
	if (current.kind === "error") {
		context.err(`${adapter.id}: cannot read ${hookFile}: ${current.reason}`);
		return 1;
	}
	const plan = planInstall(current.text, desired, (command) =>
		adapter.isOurCommand(command, binCommand),
	);
	if (plan.kind === "refused") {
		context.err(`${adapter.id}: would refuse to edit ${hookFile}: ${plan.reason}`);
		return 1;
	}
	for (const change of plan.changes) {
		context.out(`  ${change.action} ${change.nativeEvent} (position ${change.position})`);
	}
	context.out(
		`  entries whittle ${current.text === null ? "would create" : "would ensure"} in ${hookFile}:`,
	);
	for (const want of desired) {
		context.out(`    ${want.nativeEvent}: ${JSON.stringify(want.group)}`);
	}
	return 0;
}

export async function runInstall(
	options: InstallOptions,
	context: CommandContext,
): Promise<number> {
	const paths = resolvePaths(context.env);
	const config = loadConfig(paths);
	if (config.kind === "invalid") {
		context.err(`${config.path}: ${config.reason}`);
		return 1;
	}
	const selection = selectAdapters(options.harness);
	if (selection.kind === "unknown") {
		context.err(
			`unknown harness "${selection.id}"; known: ${adapters.map((adapter) => adapter.id).join(", ")}`,
		);
		return 2;
	}
	const bin = resolveBinCommand(context.argv, context.execPath);
	if (bin.kind === "refused") {
		context.err(bin.reason);
		return 1;
	}
	let exitCode = 0;
	let installedAny = false;
	for (const adapter of selection.adapters) {
		if (config.value.harnesses[adapter.id]?.enabled === false) {
			context.out(`${adapter.id}: disabled in ${paths.configFile}; skipped`);
			continue;
		}
		const detection = adapter.detect(context.env);
		const hookFile = adapter.hookFile(context.env);
		if (!detection.installed && options.harness === null && !options.dryRun) {
			context.out(`${adapter.id}: not installed (${detection.configDir} does not exist); skipped`);
			continue;
		}
		if (!detection.installed || options.dryRun) {
			context.out(
				detection.installed
					? `${adapter.id}: dry run for ${hookFile}; nothing written`
					: `${adapter.id}: not installed (${detection.configDir} does not exist); nothing written. It would get:`,
			);
			exitCode = Math.max(exitCode, printPreview(adapter, hookFile, bin.command, context));
			continue;
		}
		const state = loadState(paths);
		if (state.kind === "invalid") {
			context.err(`${state.path}: ${state.reason}`);
			return 1;
		}
		const knownRecord = state.value.harnessFiles[hookFile];
		await updateState(paths, (current) =>
			recordLedgerEntry(
				current,
				{ path: hookFile, kind: "harness-hooks", harness: adapter.id },
				context.now(),
			),
		);
		const desired = adapter.desiredGroups(bin.command);
		const result = await writeHookFile({
			path: hookFile,
			locksDir: paths.locksDir,
			backupsDir: knownRecord === undefined ? paths.backupsDir : null,
			backupLabel: `${adapter.id}-${basename(hookFile)}`,
			plan: (text) =>
				planInstall(text, desired, (command) => adapter.isOurCommand(command, bin.command)),
			createIfMissing: true,
			removeWhenEmpty: false,
		});
		if (result.kind === "refused") {
			context.err(`${adapter.id}: refused to edit ${hookFile}: ${result.reason}`);
			exitCode = 1;
			continue;
		}
		const now = context.now().toISOString();
		await updateState(paths, (current) => {
			const existing = current.harnessFiles[hookFile];
			const createdKeys = result.kind === "written" ? result.createdKeys : [];
			const record: HarnessFileRecord =
				existing === undefined
					? {
							harness: adapter.id,
							path: hookFile,
							existed: result.kind === "written" ? result.existedBefore : true,
							backupPath: result.kind === "written" ? (result.backup?.path ?? null) : null,
							backupSha256: result.kind === "written" ? (result.backup?.sha256 ?? null) : null,
							createdKeys,
							firstWriteAt: now,
						}
					: { ...existing, createdKeys: [...new Set([...existing.createdKeys, ...createdKeys])] };
			return {
				...current,
				harnessFiles: { ...current.harnessFiles, [hookFile]: record },
				installs: {
					...current.installs,
					[adapter.id]: { command: bin.command, version: VERSION, at: now },
				},
			};
		});
		installedAny = true;
		context.out(`${adapter.id}: ${result.kind} ${hookFile} (${describeChanges(result.changes)})`);
		const changed = result.changes.filter((change) => change.action !== "unchanged");
		const changedEvents = [...new Set(changed.map((change) => change.nativeEvent))];
		const shiftedEvents = [
			...new Set(
				changed.filter((change) => change.shiftsLaterEntries).map((change) => change.nativeEvent),
			),
		];
		if (adapter.trustsByPosition) {
			for (const want of desired) {
				if (changedEvents.includes(want.nativeEvent)) {
					context.out(`  ${want.nativeEvent}: ${JSON.stringify(want.group)}`);
				}
			}
		}
		for (const note of adapter.installNotes({ changedEvents, shiftedEvents })) {
			context.out(`  ${note}`);
		}
	}
	if (installedAny) {
		const created = await ensureConfigFile(paths, initialConfig());
		if (created === "created") {
			await updateState(paths, (current) =>
				recordLedgerEntry(
					current,
					{ path: paths.configFile, kind: "config-file", harness: null },
					context.now(),
				),
			);
		}
		const state = loadState(paths);
		if (state.kind === "ok") {
			context.out("footprint:");
			for (const line of formatFootprint(footprintRows(state.value, paths)))
				context.out(`  ${line}`);
		}
		context.out("nothing is active yet: run `whittle enable` inside a repository to opt it in");
	}
	return exitCode;
}
