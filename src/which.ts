import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { Env } from "./config.js";

export function findOnPath(
	name: string,
	env: Env,
	platform: NodeJS.Platform = process.platform,
): string | null {
	const windows = platform === "win32";
	const pathApi = windows ? win32 : posix;
	const searchPath = env.PATH ?? env.Path ?? "";
	const extensions = windows ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
	for (const directory of searchPath.split(windows ? ";" : ":")) {
		if (directory === "" || !pathApi.isAbsolute(directory)) continue;
		for (const extension of extensions) {
			const candidate = pathApi.join(directory, `${name}${extension}`);
			try {
				if (!statSync(candidate).isFile()) continue;
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {}
		}
	}
	return null;
}
