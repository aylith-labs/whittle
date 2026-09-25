import { spawnSync } from "node:child_process";
import type { Env } from "./config.js";
import type { LeverDependency } from "./levers/types.js";
import { findOnPath } from "./which.js";

export type DependencyProbe =
	| { kind: "found"; path: string; version: string | null }
	| { kind: "missing" }
	| { kind: "not-probed"; reason: string };

export function probeDependency(dependency: LeverDependency, env: Env): DependencyProbe {
	if (dependency.kind !== "binary") {
		return { kind: "not-probed", reason: `${dependency.kind} dependencies are not probed` };
	}
	const path = findOnPath(dependency.name, env);
	if (path === null) return { kind: "missing" };
	const result = spawnSync(path, [...dependency.versionArgs], {
		encoding: "utf8",
		timeout: 3000,
		env: { ...env },
	});
	const firstLine = result.status === 0 ? (result.stdout.split(/\r?\n/)[0] ?? "").trim() : "";
	return { kind: "found", path, version: firstLine === "" ? null : firstLine };
}

export function describeProbe(name: string, probe: DependencyProbe): string {
	switch (probe.kind) {
		case "found": {
			const version = probe.version ?? "(version unknown)";
			return version.toLowerCase().startsWith(`${name.toLowerCase()} `)
				? version
				: `${name} ${version}`;
		}
		case "missing":
			return `${name} not found`;
		case "not-probed":
			return `${name} (${probe.reason})`;
	}
}
