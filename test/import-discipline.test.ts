import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { REPO_ROOT } from "./helpers.js";

const SRC = join(REPO_ROOT, "src");

const STATIC_FROM = /^\s*(?:import|export)\s+(?!type\b)[^;]*?\s+from\s+["']([^"']+)["']/gm;
const BARE_IMPORT = /^\s*import\s+["']([^"']+)["']/gm;

function staticSpecifiers(file: string): string[] {
	const text = readFileSync(file, "utf8");
	return [...text.matchAll(STATIC_FROM), ...text.matchAll(BARE_IMPORT)].flatMap((match) =>
		match[1] === undefined ? [] : [match[1]],
	);
}

function toSourcePath(fromFile: string, specifier: string): string {
	return resolve(dirname(fromFile), specifier).replace(/\.js$/, ".ts");
}

function staticClosure(entry: string): { modules: string[]; packages: string[] } {
	const modules = new Set<string>();
	const packages = new Set<string>();
	const pending = [entry];
	while (pending.length > 0) {
		const file = pending.pop();
		if (file === undefined || modules.has(file)) continue;
		modules.add(file);
		for (const specifier of staticSpecifiers(file)) {
			if (specifier.startsWith(".")) pending.push(toSourcePath(file, specifier));
			else packages.add(specifier);
		}
	}
	return {
		modules: [...modules].map((file) => relative(SRC, file)).sort(),
		packages: [...packages].sort(),
	};
}

describe("hook fast path", () => {
	test("the scanner sees package imports (positive control)", () => {
		expect(staticClosure(join(SRC, "cli.ts")).packages).toContain("commander");
	});

	test("bin.ts has no static imports at all", () => {
		expect(staticSpecifiers(join(SRC, "bin.ts"))).toEqual([]);
	});

	test("the hook branch of bin.ts dynamically imports only the dispatcher", () => {
		const bin = readFileSync(join(SRC, "bin.ts"), "utf8");
		const hookBranch = bin.indexOf('=== "hook"');
		const elseBranch = bin.indexOf("} else {");
		const dispatcherImport = bin.indexOf('import("./hook/dispatch.js")');
		expect(hookBranch).toBeGreaterThan(-1);
		expect(dispatcherImport).toBeGreaterThan(hookBranch);
		expect(dispatcherImport).toBeLessThan(elseBranch);
		expect(bin.slice(hookBranch, elseBranch).match(/import\(/g)).toHaveLength(1);
	});

	test("the dispatcher's static import closure is node builtins only and loads no lever code", () => {
		const closure = staticClosure(join(SRC, "hook", "dispatch.ts"));
		expect(closure.packages.filter((specifier) => !specifier.startsWith("node:"))).toEqual([]);
		expect(closure.modules.filter((module) => module.startsWith("levers/"))).toEqual([]);
		expect(closure.modules).not.toContain("cli.ts");
	});
});
