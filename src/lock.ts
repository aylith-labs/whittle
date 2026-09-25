import { randomBytes } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { hasErrorCode } from "./json.js";

export type LockOptions = { timeoutMs: number; staleMs: number };

const DEFAULT_LOCK_OPTIONS: LockOptions = { timeoutMs: 15_000, staleMs: 60_000 };

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !hasErrorCode(error, "ESRCH");
	}
}

function tryAcquire(lockPath: string, token: string): boolean {
	try {
		const descriptor = openSync(lockPath, "wx", 0o600);
		try {
			writeSync(descriptor, token);
		} finally {
			closeSync(descriptor);
		}
		return true;
	} catch (error) {
		if (hasErrorCode(error, "EEXIST")) return false;
		throw error;
	}
}

function holderIsStale(lockPath: string, staleMs: number): boolean {
	let content: string;
	let modifiedAt: number;
	try {
		content = readFileSync(lockPath, "utf8");
		modifiedAt = statSync(lockPath).mtimeMs;
	} catch (error) {
		return hasErrorCode(error, "ENOENT");
	}
	const pid = Number.parseInt(content.split(":")[0] ?? "", 10);
	if (Number.isInteger(pid) && pid > 0 && !processIsAlive(pid)) return true;
	return Date.now() - modifiedAt > staleMs;
}

function releaseIfOwned(lockPath: string, token: string): void {
	try {
		if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) throw error;
	}
}

export async function withLock<T>(
	lockPath: string,
	action: () => Promise<T> | T,
	options: LockOptions = DEFAULT_LOCK_OPTIONS,
): Promise<T> {
	mkdirSync(dirname(lockPath), { recursive: true });
	const token = `${process.pid}:${randomBytes(6).toString("hex")}`;
	const startedAt = Date.now();
	while (!tryAcquire(lockPath, token)) {
		if (holderIsStale(lockPath, options.staleMs)) {
			try {
				unlinkSync(lockPath);
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT")) throw error;
			}
			continue;
		}
		if (Date.now() - startedAt > options.timeoutMs) {
			throw new Error(`timed out after ${options.timeoutMs} ms waiting for lock ${lockPath}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 25));
	}
	try {
		return await action();
	} finally {
		releaseIfOwned(lockPath, token);
	}
}
