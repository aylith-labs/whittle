import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { rtkHistoryPath } from "../../src/levers/shell-output/rtk-history.js";
import { findOnPath } from "../../src/which.js";
import { initRepo, isolatedEnv, makeTempDir, snapshotRepo } from "../helpers.js";

const realRtk = findOnPath("rtk", { PATH: process.env.PATH });
if (realRtk === null) {
	console.log(
		"SKIPPED real rtk check: rtk is not on PATH; every other test uses a fake rtk, so nothing else depends on it",
	);
}

test.skipIf(realRtk === null)(
	"the real rtk leaves the repository untouched and records the command in its own home ledger",
	() => {
		const temp = makeTempDir("rtk-real");
		try {
			const env = isolatedEnv(temp.path);
			const repo = join(temp.path, "repo");
			initRepo(repo, env, { "src/index.ts": "export const answer = 42;\n" });
			const before = snapshotRepo(repo, env);
			const result = spawnSync(realRtk ?? "rtk", ["git", "status"], {
				cwd: repo,
				env,
				encoding: "utf8",
				timeout: 30_000,
			});
			expect(result.status).toBe(0);
			const after = snapshotRepo(repo, env);
			expect(after.tree).toBe(before.tree);
			expect(after.status).toBe(before.status);
			const ledger = rtkHistoryPath(env, process.platform);
			expect(ledger.startsWith(temp.path)).toBe(true);
			expect(existsSync(ledger)).toBe(true);
		} finally {
			temp.remove();
		}
	},
	60_000,
);
