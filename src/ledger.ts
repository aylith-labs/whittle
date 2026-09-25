import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEntry, LedgerKind, StateFile, WhittlePaths } from "./config.js";
import type { HarnessId } from "./hook/types.js";
import { hasErrorCode } from "./json.js";

export type ByteCount =
	| { kind: "absent" }
	| { kind: "measured"; bytes: number }
	| { kind: "stopped-early"; bytesSoFar: number; entryLimit: number };

export type FootprintRow = {
	path: string;
	kind: LedgerKind | "config-dir" | "cache-dir";
	harness: HarnessId | null;
	size: ByteCount;
};

export type RevertOutcome = { entry: LedgerEntry; reverted: boolean; detail: string };

const ENTRY_LIMIT = 200_000;

export function recordLedgerEntry(
	state: StateFile,
	entry: Omit<LedgerEntry, "recordedAt">,
	now: Date,
): StateFile {
	const known = state.ledger.some(
		(existing) => existing.path === entry.path && existing.kind === entry.kind,
	);
	if (known) return state;
	return { ...state, ledger: [...state.ledger, { ...entry, recordedAt: now.toISOString() }] };
}

export function forgetLedgerEntry(state: StateFile, path: string, kind: LedgerKind): StateFile {
	return {
		...state,
		ledger: state.ledger.filter((entry) => !(entry.path === path && entry.kind === kind)),
	};
}

export function measureBytes(path: string, entryLimit = ENTRY_LIMIT): ByteCount {
	let bytes = 0;
	let visited = 0;
	const pending = [path];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) break;
		visited += 1;
		if (visited > entryLimit) return { kind: "stopped-early", bytesSoFar: bytes, entryLimit };
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(current);
		} catch (error) {
			if (current === path && hasErrorCode(error, "ENOENT")) return { kind: "absent" };
			if (hasErrorCode(error, "ENOENT")) continue;
			throw error;
		}
		if (stats.isDirectory()) {
			for (const name of readdirSync(current)) pending.push(join(current, name));
		} else {
			bytes += stats.size;
		}
	}
	return { kind: "measured", bytes };
}

export function footprintRows(state: StateFile, paths: WhittlePaths): FootprintRow[] {
	const rows: FootprintRow[] = state.ledger.map((entry) => ({
		path: entry.path,
		kind: entry.kind,
		harness: entry.harness,
		size: measureBytes(entry.path),
	}));
	rows.push({
		path: paths.configDir,
		kind: "config-dir",
		harness: null,
		size: measureBytes(paths.configDir),
	});
	rows.push({
		path: paths.cacheDir,
		kind: "cache-dir",
		harness: null,
		size: measureBytes(paths.cacheDir),
	});
	return rows;
}

export function describeSize(size: ByteCount): string {
	switch (size.kind) {
		case "absent":
			return "absent";
		case "measured":
			return `${size.bytes} bytes`;
		case "stopped-early":
			return `at least ${size.bytesSoFar} bytes (stopped early after ${size.entryLimit} entries)`;
	}
}

export function formatFootprint(rows: readonly FootprintRow[]): string[] {
	return rows.map((row) => {
		const owner = row.harness === null ? "" : ` [${row.harness}]`;
		return `${row.kind}${owner}  ${row.path}  (${describeSize(row.size)})`;
	});
}

export async function revertLedger(
	state: StateFile,
	revertEntry: (entry: LedgerEntry) => Promise<RevertOutcome>,
): Promise<RevertOutcome[]> {
	const outcomes: RevertOutcome[] = [];
	for (const entry of state.ledger) outcomes.push(await revertEntry(entry));
	return outcomes;
}
