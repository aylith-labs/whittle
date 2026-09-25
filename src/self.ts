import { existsSync, realpathSync } from "node:fs";
import { describeError } from "./json.js";

export type BinCommand =
	| { kind: "ok"; command: string; executables: string[] }
	| { kind: "refused"; reason: string };

const SCRIPT_ENTRY = /\.(?:[cm]?js|ts)$/;

function quoteForShell(path: string, platform: NodeJS.Platform): string | null {
	if (platform === "win32") return /["%\r\n]/.test(path) ? null : `"${path}"`;
	return /['\r\n]/.test(path) ? null : `'${path}'`;
}

export function resolveBinCommand(
	argv: readonly string[],
	execPath: string,
	platform: NodeJS.Platform = process.platform,
): BinCommand {
	const executables: string[] = [];
	try {
		executables.push(realpathSync(execPath));
		const script = argv[1];
		if (script !== undefined && existsSync(script)) {
			const realScript = realpathSync(script);
			if (SCRIPT_ENTRY.test(realScript)) executables.push(realScript);
		}
	} catch (error) {
		return {
			kind: "refused",
			reason: `cannot resolve the whittle executable: ${describeError(error)}`,
		};
	}
	const quoted: string[] = [];
	for (const executable of executables) {
		const safe = quoteForShell(executable, platform);
		if (safe === null) {
			return {
				kind: "refused",
				reason: `executable path contains a character that cannot be quoted safely: ${executable}`,
			};
		}
		quoted.push(safe);
	}
	return { kind: "ok", command: quoted.join(" "), executables };
}

export function currentBinCommand(): BinCommand {
	return resolveBinCommand(process.argv, process.execPath);
}
