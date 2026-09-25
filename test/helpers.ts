import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "..");
export const BIN_ENTRY = join(REPO_ROOT, "src", "bin.ts");

export type TempDir = { path: string; remove: () => void };

export type CliResult = { exitCode: number; stdout: string; stderr: string };

export type RepoSnapshot = { tree: string; status: string };

export function makeTempDir(prefix: string): TempDir {
	const path = mkdtempSync(join(tmpdir(), `whittle-${prefix}-`));
	return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

export function isolatedEnv(
	root: string,
	extra: Record<string, string> = {},
): Record<string, string> {
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Whittle Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Whittle Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
		...extra,
	};
}

export function git(cwd: string, args: readonly string[], env: Record<string, string>): string {
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
	}
	return result.stdout;
}

export function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

export function initRepo(
	dir: string,
	env: Record<string, string>,
	files: Record<string, string> = {},
): void {
	mkdirSync(dir, { recursive: true });
	git(dir, ["init", "-q", "-b", "main"], env);
	const content = { "README.txt": "fixture\n", ...files };
	for (const [name, text] of Object.entries(content)) writeFile(join(dir, name), text);
	git(dir, ["add", "-A"], env);
	git(dir, ["commit", "-q", "-m", "fixture"], env);
}

function treeListing(root: string): string {
	const entries: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) break;
		for (const name of readdirSync(current)) {
			const path = join(current, name);
			const rel = relative(root, path);
			// git status refreshes the index's stat cache; nothing else inside the repository may move.
			if (rel === join(".git", "index")) continue;
			const stats = lstatSync(path);
			const mode = (stats.mode & 0o7777).toString(8);
			if (stats.isDirectory()) {
				entries.push(`d ${mode} ${rel}`);
				pending.push(path);
			} else if (stats.isSymbolicLink()) {
				entries.push(`l ${mode} ${rel} -> ${readlinkSync(path)}`);
			} else {
				const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
				entries.push(`f ${mode} ${rel} ${digest}`);
			}
		}
	}
	return entries.sort().join("\n");
}

export function snapshotRepo(repo: string, env: Record<string, string>): RepoSnapshot {
	const status = spawnSync("git", ["status", "--porcelain", "--ignored=matching"], {
		cwd: repo,
		env,
		encoding: "utf8",
	});
	if (status.status !== 0) throw new Error(status.stderr);
	return { tree: treeListing(repo), status: status.stdout };
}

export async function runWhittle(
	args: readonly string[],
	options: { cwd: string; env: Record<string, string>; stdin?: string },
): Promise<CliResult> {
	const child = Bun.spawn([process.execPath, BIN_ENTRY, ...args], {
		cwd: options.cwd,
		env: options.env,
		stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}
