import { readFileSync } from "node:fs";

export type JsonRead =
	| { kind: "missing" }
	| { kind: "ok"; value: unknown; text: string }
	| { kind: "unreadable"; reason: string }
	| { kind: "invalid"; reason: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasErrorCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readJsonFile(path: string): JsonRead {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return { kind: "missing" };
		return { kind: "unreadable", reason: describeError(error) };
	}
	let value: unknown;
	try {
		value = JSON.parse(stripBom(text));
	} catch (error) {
		return { kind: "invalid", reason: `not valid JSON: ${describeError(error)}` };
	}
	return { kind: "ok", value, text };
}

export function deepEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
		);
	}
	if (isRecord(left) && isRecord(right)) {
		const leftKeys = Object.keys(left);
		const rightKeys = Object.keys(right);
		return (
			leftKeys.length === rightKeys.length &&
			leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
		);
	}
	return false;
}

export function readString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}
