import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o644): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true });
	const temp = join(
		directory,
		`.${basename(path)}.whittle-${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
	);
	try {
		const descriptor = openSync(temp, "wx", mode);
		try {
			writeSync(descriptor, typeof data === "string" ? Buffer.from(data, "utf8") : data);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		chmodSync(temp, mode);
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
