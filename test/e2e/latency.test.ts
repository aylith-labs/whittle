import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BIN_ENTRY, initRepo, isolatedEnv, makeTempDir, REPO_ROOT } from "../helpers.js";

const RUNS = 20;
const WARMUP_RUNS = 3;
const BUDGET_MS = 50;
const COMPILE_FLAGS = ["--compile", "--bytecode", "--minify"];

const temp = makeTempDir("latency");
const binary = join(temp.path, "whittle");
const controlSource = join(temp.path, "control.ts");
const controlBinary = join(temp.path, "control");
writeFileSync(
	controlSource,
	'import { readFileSync } from "node:fs";\nreadFileSync(0);\nprocess.exit(0);\n',
);

function compile(entry: string, outfile: string): string | null {
	const build = Bun.spawnSync(
		[process.execPath, "build", ...COMPILE_FLAGS, entry, "--outfile", outfile],
		{
			cwd: REPO_ROOT,
			env: { ...process.env },
			stderr: "pipe",
			stdout: "pipe",
		},
	);
	return build.exitCode === 0 ? null : build.stderr.toString().trim() || `exit ${build.exitCode}`;
}

const compileFailure = compile(BIN_ENTRY, binary) ?? compile(controlSource, controlBinary);
if (compileFailure !== null) {
	console.log(
		`SKIPPED hook latency test: bun build ${COMPILE_FLAGS.join(" ")} is unavailable here (${compileFailure})`,
	);
}

afterAll(() => {
	temp.remove();
});

function percentile(sorted: readonly number[], fraction: number): number {
	return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? Number.NaN;
}

function summary(sorted: readonly number[]): string {
	return `p50=${percentile(sorted, 0.5).toFixed(1)} p95=${percentile(sorted, 0.95).toFixed(1)} max=${(sorted.at(-1) ?? Number.NaN).toFixed(1)}`;
}

function timeRuns(
	command: string[],
	options: { cwd: string; env: Record<string, string>; stdin: string },
): number[] {
	const durations: number[] = [];
	for (let i = 0; i < RUNS + WARMUP_RUNS; i++) {
		const started = performance.now();
		const result = Bun.spawnSync(command, {
			cwd: options.cwd,
			env: options.env,
			stdin: Buffer.from(options.stdin),
			stdout: "pipe",
			stderr: "pipe",
		});
		const elapsed = performance.now() - started;
		if (result.exitCode !== 0) {
			throw new Error(
				`${command.join(" ")} exited ${result.exitCode}: ${result.stderr.toString()}`,
			);
		}
		expect(result.stdout.toString()).toBe("");
		if (i >= WARMUP_RUNS) durations.push(elapsed);
	}
	return durations.sort((left, right) => left - right);
}

test.skipIf(compileFailure !== null)(
	`compiled hook stays within ${BUDGET_MS} ms on an unregistered repository`,
	() => {
		const env = isolatedEnv(temp.path);
		const repo = join(temp.path, "repo");
		initRepo(repo, env);
		const payload = JSON.stringify({
			session_id: "latency",
			transcript_path: join(temp.path, "transcript.jsonl"),
			cwd: repo,
			hook_event_name: "UserPromptSubmit",
			prompt: "explain how the build works",
		});
		const options = { cwd: repo, env, stdin: payload };
		const control = timeRuns([controlBinary], options);
		const hook = timeRuns(
			[binary, "hook", "UserPromptSubmit", "--harness", "claude-code"],
			options,
		);
		const overheadP50 = percentile(hook, 0.5) - percentile(control, 0.5);
		console.log(
			`hook ms over ${RUNS} runs: ${summary(hook)}; empty compiled binary: ${summary(control)}; whittle overhead p50=${overheadP50.toFixed(1)}`,
		);
		expect(overheadP50).toBeLessThan(BUDGET_MS);
		if (percentile(control, 0.95) < BUDGET_MS) {
			expect(percentile(hook, 0.95)).toBeLessThan(BUDGET_MS);
		} else {
			console.log(
				`NOT ASSERTED absolute p95 < ${BUDGET_MS} ms: an empty compiled binary already takes p95=${percentile(control, 0.95).toFixed(1)} ms on this machine, so the absolute budget measures the machine rather than whittle`,
			);
		}
	},
	180_000,
);
