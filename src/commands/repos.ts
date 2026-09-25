import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
	leverIsEnabled,
	loadConfig,
	loadRepos,
	loadState,
	resolvePaths,
	updateRepos,
} from "../config.js";
import { findLever, levers } from "../levers/registry.js";
import { findRepo, type RepoRef, readOriginRemote } from "../repo.js";
import { type CommandContext, parseIdList } from "./context.js";

export type RepoCommandOptions = { lever: string | null };

function readRootCommit(root: string, context: CommandContext): string | null {
	const result = spawnSync("git", ["-C", root, "rev-list", "--max-parents=0", "HEAD"], {
		encoding: "utf8",
		timeout: 5000,
		env: { ...context.env },
	});
	if (result.status !== 0) return null;
	return result.stdout.trim().split(/\r?\n/).at(-1) ?? null;
}

function locateRepo(
	pathArgument: string | undefined,
	context: CommandContext,
): { kind: "ok"; repo: RepoRef } | { kind: "error"; code: number } {
	const target = resolve(context.cwd, pathArgument ?? ".");
	const lookup = findRepo(target);
	if (lookup.kind === "not-found") {
		context.err(`not inside a git repository: ${target}`);
		return { kind: "error", code: 1 };
	}
	if (lookup.kind === "unreadable") {
		context.err(`cannot read the repository at ${lookup.path}: ${lookup.reason}`);
		return { kind: "error", code: 1 };
	}
	return { kind: "ok", repo: lookup.repo };
}

function validateLevers(list: string | null, context: CommandContext): string[] | null {
	const ids = parseIdList(list);
	const unknown = ids.filter((id) => findLever(id) === undefined);
	if (unknown.length > 0) {
		context.err(
			`unknown lever(s): ${unknown.join(", ")}; known: ${levers.map((lever) => lever.id).join(", ")}`,
		);
		return null;
	}
	return ids;
}

export async function runEnable(
	pathArgument: string | undefined,
	options: RepoCommandOptions,
	context: CommandContext,
): Promise<number> {
	const located = locateRepo(pathArgument, context);
	if (located.kind === "error") return located.code;
	const leverIds = validateLevers(options.lever, context);
	if (leverIds === null) return 2;
	const { repo } = located;
	const paths = resolvePaths(context.env);
	const config = loadConfig(paths);
	if (config.kind === "invalid") {
		context.err(`${config.path}: ${config.reason}`);
		return 1;
	}
	const rootCommit = readRootCommit(repo.root, context);
	const remote = readOriginRemote(repo.commonDir);
	const now = context.now().toISOString();
	const repos = await updateRepos(paths, (current) => {
		const existing = current[repo.repoId];
		const overrides = { ...existing?.levers };
		for (const id of leverIds) overrides[id] = true;
		return {
			...current,
			[repo.repoId]: {
				root: existing?.root ?? repo.root,
				commonDir: repo.commonDir,
				remote,
				rootCommit: rootCommit ?? existing?.rootCommit ?? null,
				enabled: true,
				levers: overrides,
				addedAt: existing?.addedAt ?? now,
			},
		};
	});
	const entry = repos[repo.repoId];
	context.out(`enabled ${entry?.root ?? repo.root} (repo ${repo.repoId})`);
	for (const lever of levers) {
		const on = leverIsEnabled(lever.id, lever.defaultEnabled, config.value, entry);
		context.out(`  ${lever.id}: ${on ? "on" : "off"}`);
	}
	const state = loadState(paths);
	if (state.kind === "ok" && Object.keys(state.value.installs).length === 0) {
		context.out("no harness is wired yet: run `whittle install` for the levers to take effect");
	}
	return 0;
}

export async function runDisable(
	pathArgument: string | undefined,
	options: RepoCommandOptions,
	context: CommandContext,
): Promise<number> {
	const located = locateRepo(pathArgument, context);
	if (located.kind === "error") return located.code;
	const leverIds = validateLevers(options.lever, context);
	if (leverIds === null) return 2;
	const { repo } = located;
	const paths = resolvePaths(context.env);
	const repos = loadRepos(paths);
	if (repos.kind === "invalid") {
		context.err(`${repos.path}: ${repos.reason}`);
		return 1;
	}
	if (repos.value[repo.repoId] === undefined) {
		context.out(`not enabled: ${repo.root} was never passed to \`whittle enable\``);
		return 0;
	}
	await updateRepos(paths, (current) => {
		const existing = current[repo.repoId];
		if (existing === undefined) return current;
		if (leverIds.length === 0)
			return { ...current, [repo.repoId]: { ...existing, enabled: false } };
		const overrides = { ...existing.levers };
		for (const id of leverIds) overrides[id] = false;
		return { ...current, [repo.repoId]: { ...existing, levers: overrides } };
	});
	context.out(
		leverIds.length === 0
			? `disabled ${repo.root} (repo ${repo.repoId})`
			: `disabled ${leverIds.join(", ")} for ${repo.root} (repo ${repo.repoId})`,
	);
	return 0;
}
