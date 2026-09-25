import { readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import {
	type HarnessFileRecord,
	type LedgerEntry,
	loadState,
	resolvePaths,
	type StateFile,
	updateState,
	type WhittlePaths,
} from "../config.js";
import { planUninstall, writeHookFile } from "../config-writer.js";
import { findAdapter } from "../harness/registry.js";
import { deepEqual, describeError, hasErrorCode, stripBom } from "../json.js";
import { forgetLedgerEntry, type RevertOutcome, revertLedger } from "../ledger.js";
import { resolveBinCommand } from "../self.js";
import type { CommandContext } from "./context.js";

export type UninstallOptions = { purge: boolean; yes: boolean };

const BACKUP_NAME = /^(?:claude-code|codex)-.+\.bak$/;

function compareWithBackup(record: HarnessFileRecord | undefined, after: string): string {
	if (record?.backupPath === null || record?.backupPath === undefined) {
		return "no backup was recorded to compare against";
	}
	let backup: Buffer;
	try {
		backup = readFileSync(record.backupPath);
	} catch (error) {
		return `backup unreadable (${describeError(error)})`;
	}
	if (backup.equals(Buffer.from(after, "utf8"))) return "byte-identical to the backup";
	try {
		const same = deepEqual(
			JSON.parse(stripBom(backup.toString("utf8"))),
			JSON.parse(stripBom(after)),
		);
		return same
			? "deep-equal to the backup (formatting differs)"
			: "differs from the backup (the file was edited after install)";
	} catch {
		return "differs from the backup";
	}
}

async function revertHarnessEntry(
	entry: LedgerEntry,
	state: StateFile,
	paths: WhittlePaths,
	binCommand: string | null,
): Promise<RevertOutcome> {
	if (entry.kind !== "harness-hooks")
		return { entry, reverted: true, detail: "no harness edits to revert" };
	const adapter = entry.harness === null ? undefined : findAdapter(entry.harness);
	if (adapter === undefined) {
		return {
			entry,
			reverted: false,
			detail: `no adapter for harness ${entry.harness ?? "(none)"}`,
		};
	}
	const record = state.harnessFiles[entry.path];
	const result = await writeHookFile({
		path: entry.path,
		locksDir: paths.locksDir,
		backupsDir: null,
		backupLabel: "",
		plan: (text) =>
			planUninstall(
				text ?? "{}",
				(command) => adapter.isOurCommand(command, binCommand),
				record?.createdKeys ?? [],
			),
		createIfMissing: false,
		removeWhenEmpty: record?.existed === false,
	});
	switch (result.kind) {
		case "refused":
			return { entry, reverted: false, detail: result.reason };
		case "unchanged":
			return { entry, reverted: true, detail: "no whittle entries present" };
		case "written": {
			const identity = result.fileRemoved
				? "removed the file, which whittle had created"
				: compareWithBackup(record, result.after);
			const shifted =
				adapter.trustsByPosition && result.changes.some((change) => change.shiftsLaterEntries);
			const trustNote = shifted
				? `; entries after the removed ones changed position, so ${adapter.id} will ask to trust them again`
				: "";
			return {
				entry,
				reverted: true,
				detail: `removed ${result.changes.length} entries; ${identity}${trustNote}`,
			};
		}
	}
}

function removeKnownFile(path: string, removed: string[]): void {
	try {
		unlinkSync(path);
		removed.push(path);
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) throw error;
	}
}

function removeEmptyDirectory(path: string, leftover: string[]): void {
	try {
		rmdirSync(path);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return;
		if (hasErrorCode(error, "ENOTEMPTY") || hasErrorCode(error, "EEXIST")) {
			for (const name of readdirSync(path)) leftover.push(join(path, name));
			return;
		}
		throw error;
	}
}

function listDirectory(path: string): string[] {
	try {
		return readdirSync(path);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return [];
		throw error;
	}
}

export function purgeWhittleFiles(paths: WhittlePaths): { removed: string[]; leftover: string[] } {
	const removed: string[] = [];
	const leftover: string[] = [];
	for (const path of [
		paths.configFile,
		paths.reposFile,
		paths.stateFile,
		paths.logFile,
		`${paths.logFile}.1`,
	]) {
		removeKnownFile(path, removed);
	}
	for (const name of listDirectory(paths.backupsDir)) {
		if (BACKUP_NAME.test(name)) removeKnownFile(join(paths.backupsDir, name), removed);
	}
	for (const name of listDirectory(paths.locksDir)) {
		if (name.endsWith(".lock")) removeKnownFile(join(paths.locksDir, name), removed);
	}
	const cacheOwnedByWhittle = paths.cacheDir.split(sep).includes("whittle");
	if (cacheOwnedByWhittle) {
		rmSync(paths.sessionsDir, { recursive: true, force: true });
		removed.push(paths.sessionsDir);
		removeEmptyDirectory(paths.cacheDir, leftover);
		if (basename(paths.cacheDir) === "cache")
			removeEmptyDirectory(dirname(paths.cacheDir), leftover);
	}
	for (const directory of [
		dirname(paths.logFile),
		paths.backupsDir,
		paths.locksDir,
		paths.configDir,
	]) {
		removeEmptyDirectory(directory, leftover);
	}
	return { removed, leftover };
}

export async function runUninstall(
	options: UninstallOptions,
	context: CommandContext,
): Promise<number> {
	const paths = resolvePaths(context.env);
	const loaded = loadState(paths);
	if (loaded.kind === "invalid") {
		context.err(`${loaded.path}: ${loaded.reason}`);
		return 1;
	}
	const state = loaded.value;
	const bin = resolveBinCommand(context.argv, context.execPath);
	const binCommand = bin.kind === "ok" ? bin.command : null;
	const harnessEntries = state.ledger.filter((entry) => entry.kind === "harness-hooks");
	if (!options.yes) {
		context.out("dry run: pass -y to apply");
		if (harnessEntries.length === 0) context.out("  no harness files recorded in the ledger");
		for (const entry of harnessEntries) {
			const adapter = entry.harness === null ? undefined : findAdapter(entry.harness);
			let text: string | null = null;
			try {
				text = stripBom(readFileSync(entry.path, "utf8"));
			} catch (error) {
				context.out(
					`  ${entry.path}: ${hasErrorCode(error, "ENOENT") ? "absent" : describeError(error)}`,
				);
				continue;
			}
			if (adapter === undefined) {
				context.out(`  ${entry.path}: no adapter for harness ${entry.harness ?? "(none)"}`);
				continue;
			}
			const record = state.harnessFiles[entry.path];
			const plan = planUninstall(
				text,
				(command) => adapter.isOurCommand(command, binCommand),
				record?.createdKeys ?? [],
			);
			context.out(
				plan.kind === "ok"
					? `  ${entry.path}: would remove ${plan.changes.length} whittle entries`
					: `  ${entry.path}: would refuse: ${plan.reason}`,
			);
		}
		if (options.purge)
			context.out(
				`  --purge would also remove whittle's own files under ${paths.configDir} and ${paths.cacheDir}`,
			);
		return 0;
	}
	const outcomes = await revertLedger({ ...state, ledger: harnessEntries }, (entry) =>
		revertHarnessEntry(entry, state, paths, binCommand),
	);
	let failed = false;
	for (const outcome of outcomes) {
		context.out(
			`${outcome.reverted ? "reverted" : "FAILED"} ${outcome.entry.path}: ${outcome.detail}`,
		);
		failed ||= !outcome.reverted;
	}
	const reverted = outcomes.filter((outcome) => outcome.reverted).map((outcome) => outcome.entry);
	if (reverted.length > 0) {
		await updateState(paths, (current) => {
			let next = current;
			for (const entry of reverted) {
				next = forgetLedgerEntry(next, entry.path, entry.kind);
				const { [entry.path]: _removed, ...harnessFiles } = next.harnessFiles;
				const installs = { ...next.installs };
				if (entry.harness !== null) delete installs[entry.harness];
				next = { ...next, harnessFiles, installs };
			}
			return next;
		});
	}
	if (!options.purge) return failed ? 1 : 0;
	if (failed) {
		context.err(
			"not purging: at least one harness file could not be reverted, and the backups are still needed",
		);
		return 1;
	}
	const purge = purgeWhittleFiles(paths);
	for (const path of purge.removed) context.out(`removed ${path}`);
	for (const path of purge.leftover) context.out(`left in place (not created by whittle): ${path}`);
	return 0;
}
