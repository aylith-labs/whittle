import { existsSync } from "node:fs";
import {
	leverIsEnabled,
	loadConfig,
	loadRepos,
	loadState,
	repoIsEnabled,
	resolvePaths,
} from "../config.js";
import { inspectHookFile } from "../config-writer.js";
import { describeProbe, probeDependency } from "../dependency.js";
import { adapters } from "../harness/registry.js";
import { describeHomeWrites } from "../levers/home-writes.js";
import { levers } from "../levers/registry.js";
import { resolveBinCommand } from "../self.js";
import type { CommandContext } from "./context.js";

export type FindingLevel = "ok" | "note" | "warn" | "fail";

export type Finding = { level: FindingLevel; subject: string; message: string };

const QUOTED_PATH = /'([^']+)'|"([^"]+)"/g;

export function quotedPaths(command: string): string[] {
	return [...command.matchAll(QUOTED_PATH)].flatMap((match) => {
		const path = match[1] ?? match[2];
		return path === undefined ? [] : [path];
	});
}

export function collectFindings(context: CommandContext): Finding[] {
	const findings: Finding[] = [];
	const paths = resolvePaths(context.env);
	const config = loadConfig(paths);
	const repos = loadRepos(paths);
	const state = loadState(paths);
	for (const loaded of [config, repos, state]) {
		if (loaded.kind === "invalid")
			findings.push({ level: "fail", subject: loaded.path, message: loaded.reason });
	}
	const bin = resolveBinCommand(context.argv, context.execPath);
	if (bin.kind === "refused")
		findings.push({ level: "fail", subject: "whittle executable", message: bin.reason });
	const binCommand = bin.kind === "ok" ? bin.command : null;

	for (const adapter of adapters) {
		const detection = adapter.detect(context.env);
		const hookFile = adapter.hookFile(context.env);
		if (!detection.installed) {
			findings.push({
				level: "ok",
				subject: adapter.id,
				message: `not installed (${detection.configDir} absent)`,
			});
			continue;
		}
		if (binCommand === null) continue;
		const inspection = inspectHookFile(hookFile, adapter.desiredGroups(binCommand), (command) =>
			adapter.isOurCommand(command, binCommand),
		);
		if (inspection.kind === "missing") {
			findings.push({
				level: "warn",
				subject: adapter.id,
				message: `${hookFile} does not exist; run whittle install`,
			});
			continue;
		}
		if (inspection.kind === "refused") {
			findings.push({ level: "fail", subject: hookFile, message: inspection.reason });
			continue;
		}
		if (inspection.missingEvents.length > 0 || inspection.staleEvents.length > 0) {
			const missing =
				inspection.missingEvents.length > 0 ? `missing ${inspection.missingEvents.join(", ")}` : "";
			const stale =
				inspection.staleEvents.length > 0 ? `stale ${inspection.staleEvents.join(", ")}` : "";
			findings.push({
				level: "warn",
				subject: adapter.id,
				message: `hook entries ${[missing, stale].filter(Boolean).join("; ")}; run whittle install`,
			});
		} else {
			findings.push({ level: "ok", subject: adapter.id, message: `wired in ${hookFile}` });
		}
		for (const command of inspection.ownedCommands) {
			for (const path of quotedPaths(command)) {
				if (!existsSync(path)) {
					findings.push({
						level: "fail",
						subject: adapter.id,
						message: `hook command points at a missing executable ${path}; run whittle install again`,
					});
				}
			}
		}
	}

	if (config.kind === "ok" && repos.kind === "ok") {
		const enabledEntries = Object.values(repos.value).filter((entry) =>
			repoIsEnabled(config.value, entry),
		);
		for (const lever of levers) {
			const used = enabledEntries.some((entry) =>
				leverIsEnabled(lever.id, lever.defaultEnabled, config.value, entry),
			);
			if (!used) continue;
			for (const line of describeHomeWrites(lever, context.env)) {
				findings.push({ level: "note", subject: lever.id, message: line });
			}
			if (lever.dependency === null) continue;
			const probe = probeDependency(lever.dependency, context.env);
			if (probe.kind === "found") {
				findings.push({
					level: "ok",
					subject: lever.id,
					message: `${describeProbe(lever.dependency.name, probe)} at ${probe.path}`,
				});
			} else {
				findings.push({
					level: "warn",
					subject: lever.id,
					message:
						probe.kind === "missing"
							? `${lever.dependency.name} is not on PATH, so ${lever.id} does nothing; ${lever.dependency.install}`
							: probe.reason,
				});
			}
		}
		for (const [id, entry] of Object.entries(repos.value)) {
			if (!existsSync(entry.root)) {
				findings.push({
					level: "warn",
					subject: `repo ${id}`,
					message: `${entry.root} no longer exists`,
				});
			} else if (entry.root.startsWith("/mnt/")) {
				findings.push({
					level: "warn",
					subject: `repo ${id}`,
					message: `${entry.root} is on a Windows drive mount; a Windows-side harness needs its own install`,
				});
			}
		}
	}

	for (const name of ["ANTHROPIC_BASE_URL", "HTTPS_PROXY", "https_proxy"]) {
		const value = context.env[name];
		if (value !== undefined && value !== "") {
			findings.push({
				level: "warn",
				subject: name,
				message: `set in this environment (${value}); another tool may be proxying model traffic`,
			});
		}
	}
	return findings;
}

export async function runDoctor(context: CommandContext): Promise<number> {
	const findings = collectFindings(context);
	for (const finding of findings) {
		context.out(`${finding.level.toUpperCase().padEnd(4)} ${finding.subject}: ${finding.message}`);
	}
	return findings.some((finding) => finding.level === "fail") ? 1 : 0;
}
