import { appendFileSync, mkdirSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import { describeError, hasErrorCode } from "../json.js";

export const STDIN_LIMIT_BYTES = 1024 * 1024;
export const STDIN_TIMEOUT_MS = 2000;
export const LOG_ROTATE_BYTES = 1024 * 1024;
const LOG_MESSAGE_LIMIT = 2000;

export type StdinRead =
	| { kind: "ok"; text: string }
	| { kind: "too-large"; limitBytes: number }
	| { kind: "timed-out"; afterMs: number }
	| { kind: "error"; reason: string };

export type LogLevel = "info" | "warn" | "error";

export type LogRecord = {
	at: string;
	level: LogLevel;
	harness: string | null;
	event: string | null;
	lever: string | null;
	message: string;
};

export function readStdinBounded(
	stream: Readable & { isTTY?: boolean },
	limitBytes = STDIN_LIMIT_BYTES,
	timeoutMs = STDIN_TIMEOUT_MS,
): Promise<StdinRead> {
	if (stream.isTTY === true) return Promise.resolve({ kind: "ok", text: "" });
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;
		const finish = (result: StdinRead): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stream.pause();
			resolve(result);
		};
		const timer = setTimeout(() => finish({ kind: "timed-out", afterMs: timeoutMs }), timeoutMs);
		stream.on("data", (chunk: Buffer | string) => {
			if (settled) return;
			const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			total += buffer.length;
			if (total > limitBytes) {
				finish({ kind: "too-large", limitBytes });
				return;
			}
			chunks.push(buffer);
		});
		stream.on("end", () => finish({ kind: "ok", text: Buffer.concat(chunks).toString("utf8") }));
		stream.on("error", (error: unknown) => finish({ kind: "error", reason: describeError(error) }));
	});
}

function clipMessage(message: string): string {
	if (message.length <= LOG_MESSAGE_LIMIT) return message;
	return `${message.slice(0, LOG_MESSAGE_LIMIT)}… (${message.length - LOG_MESSAGE_LIMIT} more chars)`;
}

export function appendLogRecord(
	logFile: string,
	record: LogRecord,
	rotateBytes = LOG_ROTATE_BYTES,
): void {
	try {
		mkdirSync(dirname(logFile), { recursive: true });
		try {
			if (statSync(logFile).size >= rotateBytes) renameSync(logFile, `${logFile}.1`);
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) throw error;
		}
		appendFileSync(
			logFile,
			`${JSON.stringify({ ...record, message: clipMessage(record.message) })}\n`,
			{
				mode: 0o600,
			},
		);
	} catch {
		// The log is best-effort: a hook must never fail because its log cannot be written.
	}
}

export function writeAllSync(descriptor: number, text: string): void {
	const buffer = Buffer.from(text, "utf8");
	let offset = 0;
	while (offset < buffer.length) {
		offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
	}
}
