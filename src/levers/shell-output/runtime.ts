import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { hasErrorCode } from "../../json.js";
import { findOnPath } from "../../which.js";
import type { LeverRuntime } from "../types.js";
import { matchesAllowlist, readAllowlist } from "./allowlist.js";

function firstTimeThisSession(sessionsDir: string, sessionId: string, marker: string): boolean {
	const safeSession = sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 128) || "unknown";
	const directory = join(sessionsDir, safeSession);
	mkdirSync(directory, { recursive: true });
	try {
		closeSync(openSync(join(directory, marker), "wx", 0o600));
		return true;
	} catch (error) {
		if (hasErrorCode(error, "EEXIST")) return false;
		throw error;
	}
}

export const shellOutputRuntime: LeverRuntime = {
	onEvent: async (event, context) => {
		const command = event.tool?.name === "Bash" ? event.tool.command : null;
		if (command === null || !matchesAllowlist(command, readAllowlist(context.options))) {
			return null;
		}
		if (findOnPath("rtk", context.env) === null) {
			const sessionId = event.sessionId ?? "unknown";
			if (firstTimeThisSession(context.paths.sessionsDir, sessionId, "shell-output.rtk-missing")) {
				context.log("rtk is not on PATH; shell-output leaves commands untouched this session");
			}
			return null;
		}
		return { updatedInput: { command: `rtk ${command}` } };
	},
};
