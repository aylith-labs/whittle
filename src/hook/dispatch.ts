import {
	type Env,
	leverIsEnabled,
	loadConfig,
	loadRepos,
	repoIsEnabled,
	resolvePaths,
} from "../config.js";
import { findAdapter } from "../harness/registry.js";
import { describeError, isRecord } from "../json.js";
import type { LeverContext, LeverDescriptor } from "../levers/types.js";
import { findRepo } from "../repo.js";
import {
	appendLogRecord,
	type LogLevel,
	readStdinBounded,
	type StdinRead,
	writeAllSync,
} from "./io.js";
import { type HookEvent, isHarnessId, type LeverOutput, type MergedOutput } from "./types.js";

export const DEFAULT_CAP_MS: Readonly<Record<HookEvent, number>> = {
	"session.start": 3000,
	"prompt.submit": 1500,
	"tool.pre": 30,
	"tool.post": 30,
	"turn.stop": 1000,
	"compact.pre": 1000,
	"session.end": 1000,
};

export type DispatchDeps = {
	env: Env;
	cwd: string;
	readStdin: () => Promise<StdinRead>;
	writeStdout: (text: string) => void;
	loadLevers: () => Promise<readonly LeverDescriptor[]>;
	now: () => Date;
};

type CapOutcome<T> =
	| { kind: "ok"; value: T }
	| { kind: "timeout" }
	| { kind: "error"; reason: string };

type Logger = (level: LogLevel, message: string, lever?: string) => void;

async function withCap<T>(work: () => Promise<T>, capMs: number): Promise<CapOutcome<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<CapOutcome<T>>((resolve) => {
		timer = setTimeout(() => resolve({ kind: "timeout" }), capMs);
	});
	const run = Promise.resolve()
		.then(work)
		.then(
			(value): CapOutcome<T> => ({ kind: "ok", value }),
			(error: unknown): CapOutcome<T> => ({ kind: "error", reason: describeError(error) }),
		);
	try {
		return await Promise.race([run, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

function isLeverOutput(value: unknown): value is LeverOutput {
	if (!isRecord(value)) return false;
	if (value.context !== undefined && typeof value.context !== "string") return false;
	return value.updatedInput === undefined || isRecord(value.updatedInput);
}

function describeStdinFailure(read: Exclude<StdinRead, { kind: "ok" }>): string {
	switch (read.kind) {
		case "too-large":
			return `stopped early: stdin exceeded ${read.limitBytes} bytes`;
		case "timed-out":
			return `stopped early: stdin did not close within ${read.afterMs} ms`;
		case "error":
			return `stdin could not be read: ${read.reason}`;
	}
}

async function dispatch(
	args: readonly string[],
	deps: DispatchDeps,
	log: Logger,
): Promise<string | null> {
	const [nativeEvent, flag, harnessId] = args;
	if (
		args.length !== 3 ||
		nativeEvent === undefined ||
		flag !== "--harness" ||
		harnessId === undefined
	) {
		log("warn", `usage: whittle hook <event> --harness <id> (got: ${args.join(" ")})`);
		return null;
	}
	const adapter = isHarnessId(harnessId) ? findAdapter(harnessId) : undefined;
	if (adapter === undefined) {
		log("warn", `no adapter for harness "${harnessId}"`);
		return null;
	}
	const event = adapter.eventFromNative(nativeEvent);
	if (event === null) {
		log("warn", `${adapter.id} has no whittle mapping for event "${nativeEvent}"`);
		return null;
	}
	const stdin = await deps.readStdin();
	if (stdin.kind !== "ok") {
		log("warn", describeStdinFailure(stdin));
		return null;
	}
	let payload: unknown = {};
	if (stdin.text.trim() !== "") {
		try {
			payload = JSON.parse(stdin.text);
		} catch (error) {
			log("warn", `stdin is not JSON: ${describeError(error)}`);
			return null;
		}
	}
	const normalised = adapter.normalise(event, payload, deps.cwd);
	const lookup = findRepo(normalised.cwd);
	if (lookup.kind === "unreadable") {
		log("warn", `repository lookup failed at ${lookup.path}: ${lookup.reason}`);
		return null;
	}
	if (lookup.kind === "not-found") return null;
	const paths = resolvePaths(deps.env);
	const repos = loadRepos(paths);
	if (repos.kind === "invalid") {
		log("error", `${repos.path}: ${repos.reason}`);
		return null;
	}
	const config = loadConfig(paths);
	if (config.kind === "invalid") {
		log("error", `${config.path}: ${config.reason}`);
		return null;
	}
	const entry = repos.value[lookup.repo.repoId];
	if (!repoIsEnabled(config.value, entry)) return null;
	if (config.value.harnesses[adapter.id]?.enabled === false) return null;

	const merged: MergedOutput = { contexts: [], updatedInput: null };
	let updatedInputOwner: string | null = null;
	const channels = adapter.outputChannels(event);
	for (const lever of await deps.loadLevers()) {
		const load = lever.load;
		if (load === null || !lever.events.includes(event)) continue;
		if (lever.harnesses[adapter.id]?.enforces !== true) continue;
		if (!leverIsEnabled(lever.id, lever.defaultEnabled, config.value, entry)) continue;
		const capMs = lever.capMs[event] ?? DEFAULT_CAP_MS[event];
		const context: LeverContext = {
			options: { ...lever.defaultOptions, ...config.value.levers[lever.id] },
			env: deps.env,
			paths,
			repo: lookup.repo,
			log: (message) => log("info", message, lever.id),
		};
		const outcome = await withCap(async () => (await load()).onEvent(normalised, context), capMs);
		if (outcome.kind === "timeout") {
			log(
				"warn",
				`exceeded its ${capMs} ms cap on ${nativeEvent}; its output was ignored`,
				lever.id,
			);
			continue;
		}
		if (outcome.kind === "error") {
			log("error", `threw on ${nativeEvent}: ${outcome.reason}`, lever.id);
			continue;
		}
		if (outcome.value === null) continue;
		if (!isLeverOutput(outcome.value)) {
			log("error", `returned malformed output on ${nativeEvent}`, lever.id);
			continue;
		}
		const { context: leverContext, updatedInput } = outcome.value;
		if (leverContext !== undefined) {
			if (channels.context) merged.contexts.push(leverContext);
			else log("warn", `context dropped: ${adapter.id} takes none on ${nativeEvent}`, lever.id);
		}
		if (updatedInput !== undefined) {
			if (!channels.updatedInput) {
				log("warn", `updatedInput dropped: ${adapter.id} takes none on ${nativeEvent}`, lever.id);
			} else if (updatedInputOwner !== null) {
				log("warn", `updatedInput ignored: ${updatedInputOwner} already claimed it`, lever.id);
			} else {
				merged.updatedInput = updatedInput;
				updatedInputOwner = lever.id;
			}
		}
	}
	return adapter.render(event, merged, normalised);
}

export async function runHook(args: readonly string[], deps: DispatchDeps): Promise<0> {
	const logFile = resolvePaths(deps.env).logFile;
	const log: Logger = (level, message, lever) =>
		appendLogRecord(logFile, {
			at: deps.now().toISOString(),
			level,
			harness: args[2] ?? null,
			event: args[0] ?? null,
			lever: lever ?? null,
			message,
		});
	try {
		const output = await dispatch(args, deps, log);
		if (output !== null) deps.writeStdout(`${output}\n`);
	} catch (error) {
		log("error", `dispatcher failed: ${describeError(error)}`);
	}
	return 0;
}

export function runHookFromProcess(args: readonly string[]): Promise<0> {
	return runHook(args, {
		env: process.env,
		cwd: process.cwd(),
		readStdin: () => readStdinBounded(process.stdin),
		writeStdout: (text) => writeAllSync(1, text),
		loadLevers: () => import("../levers/registry.js").then((module) => module.levers),
		now: () => new Date(),
	});
}
