import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepo, readOriginRemote } from "../src/repo.js";
import { git, initRepo, isolatedEnv, makeTempDir } from "./helpers.js";

describe("findRepo", () => {
	test("resolves a plain repository from a subdirectory without spawning git", () => {
		const temp = makeTempDir("repo-plain");
		try {
			const env = isolatedEnv(temp.path);
			const repoDir = join(temp.path, "plain");
			initRepo(repoDir, env, { "src/a.ts": "export {};\n" });
			const lookup = findRepo(join(repoDir, "src"));
			expect(lookup.kind).toBe("found");
			if (lookup.kind !== "found") return;
			expect(lookup.repo.root).toBe(realpathSync(repoDir));
			expect(lookup.repo.commonDir).toBe(realpathSync(join(repoDir, ".git")));
			expect(lookup.repo.repoId).toMatch(/^[0-9a-f]{12}$/);
			expect(lookup.repo.worktreeId).toMatch(/^[0-9a-f]{12}$/);
			expect(lookup.repo.linkedWorktree).toBe(false);
		} finally {
			temp.remove();
		}
	});

	test("a linked worktree shares the repo id and has its own worktree id", () => {
		const temp = makeTempDir("repo-worktree");
		try {
			const env = isolatedEnv(temp.path);
			const main = join(temp.path, "main");
			initRepo(main, env);
			const linked = join(temp.path, "main.worktrees", "feature");
			git(main, ["worktree", "add", "-q", "-b", "feature", linked], env);
			const mainLookup = findRepo(main);
			const linkedLookup = findRepo(linked);
			expect(mainLookup.kind).toBe("found");
			expect(linkedLookup.kind).toBe("found");
			if (mainLookup.kind !== "found" || linkedLookup.kind !== "found") return;
			expect(linkedLookup.repo.repoId).toBe(mainLookup.repo.repoId);
			expect(linkedLookup.repo.worktreeId).not.toBe(mainLookup.repo.worktreeId);
			expect(linkedLookup.repo.linkedWorktree).toBe(true);
			expect(linkedLookup.repo.commonDir).toBe(mainLookup.repo.commonDir);
		} finally {
			temp.remove();
		}
	});

	test("two clones of one repository get different repo ids", () => {
		const temp = makeTempDir("repo-clones");
		try {
			const env = isolatedEnv(temp.path);
			const origin = join(temp.path, "origin");
			initRepo(origin, env);
			const clone = join(temp.path, "clone");
			git(temp.path, ["clone", "-q", origin, clone], env);
			const originLookup = findRepo(origin);
			const cloneLookup = findRepo(clone);
			if (originLookup.kind !== "found" || cloneLookup.kind !== "found")
				throw new Error("lookup failed");
			expect(cloneLookup.repo.repoId).not.toBe(originLookup.repo.repoId);
			expect(readOriginRemote(cloneLookup.repo.commonDir)).toBe(origin);
			expect(readOriginRemote(originLookup.repo.commonDir)).toBeNull();
		} finally {
			temp.remove();
		}
	});

	test("reports not-found outside any repository", () => {
		const temp = makeTempDir("repo-none");
		try {
			const lookup = findRepo(temp.path);
			expect(lookup.kind).toBe("not-found");
		} finally {
			temp.remove();
		}
	});

	test("a .git file without a gitdir line is unreadable, not absent", () => {
		const temp = makeTempDir("repo-broken");
		try {
			const dir = join(temp.path, "broken");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, ".git"), "garbage\n");
			const lookup = findRepo(dir);
			expect(lookup.kind).toBe("unreadable");
		} finally {
			temp.remove();
		}
	});
});
