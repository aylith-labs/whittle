import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";
import type { DesiredHookGroup } from "./harness/types.js";
import { deepEqual, describeError, hasErrorCode } from "./json.js";
import {
	appendArrayItemEdit,
	appendObjectMemberEdit,
	applyEdit,
	detectLayout,
	findMember,
	type JsonArrayNode,
	type JsonNode,
	type JsonObjectNode,
	nodeValue,
	parseJsonSpans,
	removeChildEdit,
	replaceNodeEdit,
} from "./json-span.js";
import { withLock } from "./lock.js";

export const PROTECTED_KEYS: readonly string[] = [
	"statusLine",
	"subagentStatusLine",
	"permissions",
	"footerLinksRegexes",
	"env",
];

export type HookChange = {
	nativeEvent: string;
	action: "unchanged" | "appended" | "replaced" | "removed";
	position: number;
	shiftsLaterEntries: boolean;
};

export type EditPlan =
	| { kind: "ok"; text: string; changes: HookChange[]; createdKeys: string[] }
	| { kind: "refused"; reason: string };

export type OwnershipTest = (command: string) => boolean;

export type HookFileWrite =
	| { kind: "unchanged"; path: string; changes: HookChange[] }
	| {
			kind: "written";
			path: string;
			realPath: string;
			changes: HookChange[];
			createdKeys: string[];
			existedBefore: boolean;
			fileRemoved: boolean;
			backup: { path: string; sha256: string } | null;
			after: string;
	  }
	| { kind: "refused"; path: string; reason: string };

export type HookFileWriteOptions = {
	path: string;
	locksDir: string;
	backupsDir: string | null;
	backupLabel: string;
	plan: (text: string | null) => EditPlan;
	createIfMissing: boolean;
	removeWhenEmpty: boolean;
	onBeforeCommit?: () => void;
	attempts?: number;
};

type OwnedHook = {
	nativeEvent: string;
	eventArray: JsonArrayNode;
	groupIndex: number;
	groupNode: JsonObjectNode;
	innerHooks: JsonArrayNode;
	hookIndex: number;
	soleHookInGroup: boolean;
};

type Snapshot =
	| { kind: "missing" }
	| { kind: "present"; bytes: Buffer; mtimeMs: number; size: number; ino: number; mode: number };

const MAX_RECONCILE_STEPS = 1000;

function refused(reason: string): { kind: "refused"; reason: string } {
	return { kind: "refused", reason };
}

function parseRoot(
	text: string,
): { kind: "ok"; root: JsonObjectNode } | { kind: "refused"; reason: string } {
	let root: JsonNode;
	try {
		root = parseJsonSpans(text);
	} catch (error) {
		return refused(
			`not strict JSON (${describeError(error)}); whittle edits only files it can parse exactly`,
		);
	}
	if (root.kind !== "object") return refused("the top-level value is not a JSON object");
	return { kind: "ok", root };
}

type HooksLookup =
	| { kind: "absent" }
	| { kind: "ok"; node: JsonObjectNode }
	| { kind: "refused"; reason: string };

function findHooksObject(root: JsonObjectNode): HooksLookup {
	const member = findMember(root, "hooks");
	if (member === undefined) return { kind: "absent" };
	if (member.value.kind !== "object") return refused('"hooks" is not a JSON object');
	return { kind: "ok", node: member.value };
}

function commandOf(text: string, hook: JsonNode): string | null {
	if (hook.kind !== "object") return null;
	const command = findMember(hook, "command");
	if (command === undefined) return null;
	const value = nodeValue(text, command.value);
	return typeof value === "string" ? value : null;
}

function findOwned(
	text: string,
	hooks: JsonObjectNode,
	isOurs: OwnershipTest,
	onlyEvent: string | null,
): OwnedHook[] {
	const owned: OwnedHook[] = [];
	for (const member of hooks.members) {
		if (onlyEvent !== null && member.key !== onlyEvent) continue;
		const eventArray = member.value;
		if (eventArray.kind !== "array") continue;
		eventArray.items.forEach((groupNode, groupIndex) => {
			if (groupNode.kind !== "object") return;
			const innerHooks = findMember(groupNode, "hooks")?.value;
			if (innerHooks?.kind !== "array") return;
			innerHooks.items.forEach((hook, hookIndex) => {
				const command = commandOf(text, hook);
				if (command === null || !isOurs(command)) return;
				owned.push({
					nativeEvent: member.key,
					eventArray,
					groupIndex,
					groupNode,
					innerHooks,
					hookIndex,
					soleHookInGroup: innerHooks.items.length === 1,
				});
			});
		});
	}
	return owned;
}

function removalOf(entry: OwnedHook): {
	edit: ReturnType<typeof removeChildEdit>;
	change: HookChange;
} {
	if (entry.soleHookInGroup) {
		return {
			edit: removeChildEdit(entry.eventArray, entry.groupIndex),
			change: {
				nativeEvent: entry.nativeEvent,
				action: "removed",
				position: entry.groupIndex,
				shiftsLaterEntries: entry.groupIndex < entry.eventArray.items.length - 1,
			},
		};
	}
	return {
		edit: removeChildEdit(entry.innerHooks, entry.hookIndex),
		change: {
			nativeEvent: entry.nativeEvent,
			action: "removed",
			position: entry.groupIndex,
			shiftsLaterEntries: entry.hookIndex < entry.innerHooks.items.length - 1,
		},
	};
}

function removeExtras(
	text: string,
	nativeEvent: string,
	isOurs: OwnershipTest,
	changes: HookChange[],
): { kind: "ok"; text: string } | { kind: "refused"; reason: string } {
	let current = text;
	for (let step = 0; step < MAX_RECONCILE_STEPS; step++) {
		const parsed = parseRoot(current);
		if (parsed.kind === "refused") return parsed;
		const hooks = findHooksObject(parsed.root);
		if (hooks.kind === "refused") return hooks;
		if (hooks.kind === "absent") return { kind: "ok", text: current };
		const owned = findOwned(current, hooks.node, isOurs, nativeEvent);
		const keeper = owned.find((entry) => entry.soleHookInGroup);
		const extra = owned.find((entry) => entry !== keeper);
		if (extra === undefined) return { kind: "ok", text: current };
		const removal = removalOf(extra);
		changes.push(removal.change);
		current = applyEdit(current, removal.edit);
	}
	return refused(`stopped early: more than ${MAX_RECONCILE_STEPS} whittle entries to reconcile`);
}

export function planInstall(
	text: string | null,
	desired: readonly DesiredHookGroup[],
	isOurs: OwnershipTest,
): EditPlan {
	let current = text ?? "{}";
	const changes: HookChange[] = [];
	const createdKeys: string[] = [];
	for (const want of desired) {
		const cleaned = removeExtras(current, want.nativeEvent, isOurs, changes);
		if (cleaned.kind === "refused") return cleaned;
		current = cleaned.text;
		const parsed = parseRoot(current);
		if (parsed.kind === "refused") return parsed;
		const layout = detectLayout(current);
		const hooks = findHooksObject(parsed.root);
		if (hooks.kind === "refused") return hooks;
		if (hooks.kind === "absent") {
			const value = { [want.nativeEvent]: [want.group] };
			current = applyEdit(
				current,
				appendObjectMemberEdit(current, parsed.root, "hooks", value, layout),
			);
			createdKeys.push("hooks", `hooks.${want.nativeEvent}`);
			changes.push({
				nativeEvent: want.nativeEvent,
				action: "appended",
				position: 0,
				shiftsLaterEntries: false,
			});
			continue;
		}
		const eventMember = findMember(hooks.node, want.nativeEvent);
		if (eventMember === undefined) {
			current = applyEdit(
				current,
				appendObjectMemberEdit(current, hooks.node, want.nativeEvent, [want.group], layout),
			);
			createdKeys.push(`hooks.${want.nativeEvent}`);
			changes.push({
				nativeEvent: want.nativeEvent,
				action: "appended",
				position: 0,
				shiftsLaterEntries: false,
			});
			continue;
		}
		if (eventMember.value.kind !== "array") {
			return refused(`"hooks.${want.nativeEvent}" is not a JSON array`);
		}
		const keeper = findOwned(current, hooks.node, isOurs, want.nativeEvent)[0];
		if (keeper === undefined) {
			const position = eventMember.value.items.length;
			current = applyEdit(
				current,
				appendArrayItemEdit(current, eventMember.value, want.group, layout),
			);
			changes.push({
				nativeEvent: want.nativeEvent,
				action: "appended",
				position,
				shiftsLaterEntries: false,
			});
		} else if (deepEqual(nodeValue(current, keeper.groupNode), want.group)) {
			changes.push({
				nativeEvent: want.nativeEvent,
				action: "unchanged",
				position: keeper.groupIndex,
				shiftsLaterEntries: false,
			});
		} else {
			current = applyEdit(current, replaceNodeEdit(current, keeper.groupNode, want.group, layout));
			changes.push({
				nativeEvent: want.nativeEvent,
				action: "replaced",
				position: keeper.groupIndex,
				shiftsLaterEntries: false,
			});
		}
	}
	return { kind: "ok", text: current, changes, createdKeys };
}

function removeMemberIfEmptyAndCreated(
	text: string,
	container: JsonObjectNode,
	key: string,
	createdKey: string,
	createdKeys: readonly string[],
): string {
	const index = container.members.findIndex((member) => member.key === key);
	const member = container.members[index];
	if (member === undefined || !createdKeys.includes(createdKey)) return text;
	const value = member.value;
	const empty =
		(value.kind === "array" && value.items.length === 0) ||
		(value.kind === "object" && value.members.length === 0);
	return empty ? applyEdit(text, removeChildEdit(container, index)) : text;
}

export function planUninstall(
	text: string,
	isOurs: OwnershipTest,
	createdKeys: readonly string[],
): EditPlan {
	let current = text;
	const changes: HookChange[] = [];
	for (let step = 0; step < MAX_RECONCILE_STEPS; step++) {
		const parsed = parseRoot(current);
		if (parsed.kind === "refused") return parsed;
		const hooks = findHooksObject(parsed.root);
		if (hooks.kind === "refused") return hooks;
		if (hooks.kind === "absent") return { kind: "ok", text: current, changes, createdKeys: [] };
		const target = findOwned(current, hooks.node, isOurs, null)[0];
		if (target === undefined) {
			const withoutHooks = removeMemberIfEmptyAndCreated(
				current,
				parsed.root,
				"hooks",
				"hooks",
				createdKeys,
			);
			return { kind: "ok", text: withoutHooks, changes, createdKeys: [] };
		}
		const removal = removalOf(target);
		changes.push(removal.change);
		current = applyEdit(current, removal.edit);
		const reparsed = parseRoot(current);
		if (reparsed.kind === "refused") return reparsed;
		const reparsedHooks = findHooksObject(reparsed.root);
		if (reparsedHooks.kind === "ok") {
			current = removeMemberIfEmptyAndCreated(
				current,
				reparsedHooks.node,
				target.nativeEvent,
				`hooks.${target.nativeEvent}`,
				createdKeys,
			);
		}
	}
	return refused(`stopped early: more than ${MAX_RECONCILE_STEPS} whittle entries to remove`);
}

export function verifyOnlyHooksChanged(before: string, after: string): string | null {
	const beforeRoot = parseRoot(before);
	const afterRoot = parseRoot(after);
	if (beforeRoot.kind === "refused") return beforeRoot.reason;
	if (afterRoot.kind === "refused") return `the edited document is invalid: ${afterRoot.reason}`;
	const foreign = (root: JsonObjectNode, text: string) =>
		root.members
			.filter((member) => member.key !== "hooks")
			.map((member) => ({ key: member.key, raw: text.slice(member.start, member.value.end) }));
	const beforeMembers = foreign(beforeRoot.root, before);
	const afterMembers = foreign(afterRoot.root, after);
	const longest = Math.max(beforeMembers.length, afterMembers.length);
	for (let i = 0; i < longest; i++) {
		const previous = beforeMembers[i];
		const next = afterMembers[i];
		if (previous?.key === next?.key && previous?.raw === next?.raw) continue;
		const key = previous?.key ?? next?.key ?? "?";
		const label = PROTECTED_KEYS.includes(key) ? "protected key" : "key";
		return `refusing to write: ${label} "${key}" would change, and whittle only edits "hooks"`;
	}
	return null;
}

export type HookFileInspection =
	| { kind: "missing" }
	| { kind: "refused"; reason: string }
	| {
			kind: "ok";
			wiredEvents: string[];
			missingEvents: string[];
			staleEvents: string[];
			ownedCommands: string[];
	  };

export function inspectHookFile(
	path: string,
	desired: readonly DesiredHookGroup[],
	isOurs: OwnershipTest,
): HookFileInspection {
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return { kind: "missing" };
		return refused(describeError(error));
	}
	const decoded = decode(bytes);
	if (decoded.kind === "refused") return decoded;
	const parsed = parseRoot(decoded.text);
	if (parsed.kind === "refused") return parsed;
	const hooks = findHooksObject(parsed.root);
	if (hooks.kind === "refused") return hooks;
	const ownedCommands =
		hooks.kind === "absent"
			? []
			: findOwned(decoded.text, hooks.node, isOurs, null).map(
					(entry) =>
						commandOf(decoded.text, entry.innerHooks.items[entry.hookIndex] ?? entry.groupNode) ??
						"",
				);
	const plan = planInstall(decoded.text, desired, isOurs);
	if (plan.kind === "refused") return plan;
	const eventsWith = (actions: readonly HookChange["action"][]) => [
		...new Set(
			plan.changes
				.filter((change) => actions.includes(change.action))
				.map((change) => change.nativeEvent),
		),
	];
	const staleEvents = eventsWith(["replaced", "removed"]);
	return {
		kind: "ok",
		wiredEvents: eventsWith(["unchanged"]).filter((event) => !staleEvents.includes(event)),
		missingEvents: eventsWith(["appended"]),
		staleEvents,
		ownedCommands,
	};
}

function readSnapshot(path: string): Snapshot {
	try {
		const stats = statSync(path);
		const bytes = readFileSync(path);
		return {
			kind: "present",
			bytes,
			mtimeMs: stats.mtimeMs,
			size: stats.size,
			ino: stats.ino,
			mode: stats.mode & 0o777,
		};
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return { kind: "missing" };
		throw error;
	}
}

function sameSnapshot(left: Snapshot, right: Snapshot): boolean {
	if (left.kind === "missing" || right.kind === "missing") return left.kind === right.kind;
	return (
		left.mtimeMs === right.mtimeMs &&
		left.size === right.size &&
		left.ino === right.ino &&
		left.bytes.equals(right.bytes)
	);
}

type TargetLookup = { kind: "ok"; realPath: string } | { kind: "refused"; reason: string };

function resolveTarget(path: string): TargetLookup {
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink()) return { kind: "ok", realPath: realpathSync(path) };
		if (!stats.isFile()) return refused("not a regular file");
		return { kind: "ok", realPath: path };
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			try {
				lstatSync(path);
				return refused("is a symbolic link whose target does not exist");
			} catch {
				return { kind: "ok", realPath: path };
			}
		}
		return refused(describeError(error));
	}
}

export function sha256Hex(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function writeBackup(
	backupsDir: string,
	label: string,
	bytes: Buffer,
): { path: string; sha256: string } {
	const stamp = new Date().toISOString().replaceAll(":", "-");
	const path = join(backupsDir, `${label}.${stamp}.${randomBytes(3).toString("hex")}.bak`);
	writeFileAtomic(path, bytes, 0o600);
	return { path, sha256: sha256Hex(bytes) };
}

function decode(
	bytes: Buffer,
): { kind: "ok"; bom: string; text: string } | { kind: "refused"; reason: string } {
	const text = bytes.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(bytes)) return refused("the file is not valid UTF-8");
	return text.startsWith("﻿")
		? { kind: "ok", bom: "﻿", text: text.slice(1) }
		: { kind: "ok", bom: "", text };
}

function isEmptyObject(text: string): boolean {
	const parsed = parseRoot(text);
	return parsed.kind === "ok" && parsed.root.members.length === 0;
}

export async function writeHookFile(options: HookFileWriteOptions): Promise<HookFileWrite> {
	const target = resolveTarget(options.path);
	if (target.kind === "refused")
		return { kind: "refused", path: options.path, reason: target.reason };
	const lockName = `${sha256Hex(target.realPath).slice(0, 16)}-${basename(target.realPath)}.lock`;
	return withLock(join(options.locksDir, lockName), () => {
		const attempts = options.attempts ?? 3;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			const before = readSnapshot(target.realPath);
			if (before.kind === "missing" && !options.createIfMissing) {
				return { kind: "unchanged", path: options.path, changes: [] };
			}
			let original: { bom: string; text: string } | null = null;
			if (before.kind === "present") {
				const decoded = decode(before.bytes);
				if (decoded.kind === "refused")
					return { kind: "refused", path: options.path, reason: decoded.reason };
				original = decoded;
			}
			const plan = options.plan(original === null ? null : original.text);
			if (plan.kind === "refused")
				return { kind: "refused", path: options.path, reason: plan.reason };
			const guard = verifyOnlyHooksChanged(original?.text ?? "{}", plan.text);
			if (guard !== null) return { kind: "refused", path: options.path, reason: guard };
			const output = original === null ? `${plan.text}\n` : `${original.bom}${plan.text}`;
			if (original !== null && output === `${original.bom}${original.text}`) {
				return { kind: "unchanged", path: options.path, changes: plan.changes };
			}
			options.onBeforeCommit?.();
			if (!sameSnapshot(before, readSnapshot(target.realPath))) continue;
			const backup =
				options.backupsDir !== null && before.kind === "present"
					? writeBackup(options.backupsDir, options.backupLabel, before.bytes)
					: null;
			const fileRemoved = options.removeWhenEmpty && isEmptyObject(plan.text);
			if (fileRemoved) {
				unlinkSync(target.realPath);
			} else {
				writeFileAtomic(target.realPath, output, before.kind === "present" ? before.mode : 0o644);
			}
			return {
				kind: "written",
				path: options.path,
				realPath: target.realPath,
				changes: plan.changes,
				createdKeys: plan.createdKeys,
				existedBefore: before.kind === "present",
				fileRemoved,
				backup,
				after: output,
			};
		}
		return {
			kind: "refused",
			path: options.path,
			reason: `the file kept changing while whittle was editing it (${attempts} attempts); nothing was written`,
		};
	});
}
