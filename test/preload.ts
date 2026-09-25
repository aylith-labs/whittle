import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Any code path that falls back to process.env lands in this throwaway root, never the real home.
const isolatedRoot = mkdtempSync(join(tmpdir(), "whittle-test-process-"));
const isolatedHome = join(isolatedRoot, "home");
mkdirSync(isolatedHome, { recursive: true });

process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.XDG_CONFIG_HOME = join(isolatedHome, ".config");
process.env.XDG_CACHE_HOME = join(isolatedHome, ".cache");
process.env.XDG_DATA_HOME = join(isolatedHome, ".local", "share");
process.env.CLAUDE_CONFIG_DIR = join(isolatedHome, ".claude");
process.env.CODEX_HOME = join(isolatedHome, ".codex");
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.WHITTLE_CONFIG_DIR;

process.on("exit", () => {
	rmSync(isolatedRoot, { recursive: true, force: true });
});
