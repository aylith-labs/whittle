import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describeError, hasErrorCode } from "./json.js";

export type RepoRef = {
	root: string;
	gitDir: string;
	commonDir: string;
	repoId: string;
	worktreeId: string;
	linkedWorktree: boolean;
};

export type RepoLookup =
	| { kind: "found"; repo: RepoRef }
	| { kind: "not-found"; searchedFrom: string }
	| { kind: "unreadable"; path: string; reason: string };

const MAX_ANCESTORS = 512;

export function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function unreadable(path: string, reason: string): RepoLookup {
	return { kind: "unreadable", path, reason };
}

function isMissing(error: unknown): boolean {
	return hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR");
}

function resolveGitDir(root: string, dotGit: string, isDirectory: boolean): RepoLookup {
	let gitDir = dotGit;
	if (!isDirectory) {
		let content: string;
		try {
			content = readFileSync(dotGit, "utf8");
		} catch (error) {
			return unreadable(dotGit, describeError(error));
		}
		const target = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(content)?.[1];
		if (target === undefined) return unreadable(dotGit, "file has no gitdir: line");
		gitDir = resolve(root, target);
	}
	let realGitDir: string;
	let realCommonDir: string;
	try {
		realGitDir = realpathSync(gitDir);
		if (!statSync(join(realGitDir, "HEAD")).isFile()) {
			return unreadable(realGitDir, "git directory has no HEAD file");
		}
		let commonDir = realGitDir;
		try {
			const pointer = readFileSync(join(realGitDir, "commondir"), "utf8").trim();
			if (pointer !== "") commonDir = resolve(realGitDir, pointer);
		} catch (error) {
			if (!isMissing(error)) return unreadable(join(realGitDir, "commondir"), describeError(error));
		}
		realCommonDir = realpathSync(commonDir);
	} catch (error) {
		return unreadable(gitDir, describeError(error));
	}
	return {
		kind: "found",
		repo: {
			root,
			gitDir: realGitDir,
			commonDir: realCommonDir,
			repoId: shortHash(realCommonDir),
			worktreeId: shortHash(root),
			linkedWorktree: realGitDir !== realCommonDir,
		},
	};
}

export function findRepo(start: string): RepoLookup {
	let current: string;
	try {
		current = realpathSync(start);
	} catch (error) {
		if (isMissing(error)) return { kind: "not-found", searchedFrom: start };
		return unreadable(start, describeError(error));
	}
	for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
		const dotGit = join(current, ".git");
		try {
			const stats = statSync(dotGit);
			return resolveGitDir(current, dotGit, stats.isDirectory());
		} catch (error) {
			if (!isMissing(error)) return unreadable(dotGit, describeError(error));
		}
		const parent = dirname(current);
		if (parent === current) return { kind: "not-found", searchedFrom: start };
		current = parent;
	}
	return unreadable(start, `stopped early after ${MAX_ANCESTORS} ancestor directories`);
}

export function readOriginRemote(commonDir: string): string | null {
	let content: string;
	try {
		content = readFileSync(join(commonDir, "config"), "utf8");
	} catch {
		return null;
	}
	let inOrigin = false;
	for (const line of content.split(/\r?\n/)) {
		const section = /^\s*\[(.+)\]\s*$/.exec(line)?.[1];
		if (section !== undefined) {
			inOrigin = /^remote\s+"origin"$/.test(section.trim());
			continue;
		}
		const url = inOrigin ? /^\s*url\s*=\s*(.+?)\s*$/.exec(line)?.[1] : undefined;
		if (url !== undefined) return url;
	}
	return null;
}
