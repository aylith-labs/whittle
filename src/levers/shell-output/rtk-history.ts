import { posix, win32 } from "node:path";
import { type Env, homeDirectory } from "../../config.js";

// Mirrors the dirs crate's data_local_dir(), which rtk uses as the parent of rtk/history.db.
function localDataDir(env: Env, platform: NodeJS.Platform): string {
	const home = homeDirectory(env, platform);
	if (platform === "win32") {
		const localAppData = env.LOCALAPPDATA;
		return localAppData !== undefined && win32.isAbsolute(localAppData)
			? localAppData
			: win32.join(home, "AppData", "Local");
	}
	if (platform === "darwin") return posix.join(home, "Library", "Application Support");
	const xdgDataHome = env.XDG_DATA_HOME;
	return xdgDataHome !== undefined && posix.isAbsolute(xdgDataHome)
		? xdgDataHome
		: posix.join(home, ".local", "share");
}

// rtk checks RTK_DB_PATH first; the tracking.database_path key in rtk's own config comes next and is never read here.
export function rtkHistoryPath(env: Env, platform: NodeJS.Platform): string {
	const override = env.RTK_DB_PATH;
	if (override !== undefined && override !== "") return override;
	const pathApi = platform === "win32" ? win32 : posix;
	return pathApi.join(localDataDir(env, platform), "rtk", "history.db");
}
