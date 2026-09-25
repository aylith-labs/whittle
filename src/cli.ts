import { Command, CommanderError } from "commander";
import type { CommandContext } from "./commands/context.js";
import { runDoctor } from "./commands/doctor.js";
import { runInstall } from "./commands/install.js";
import { runFootprint, runLevers, runStatus } from "./commands/report.js";
import { runDisable, runEnable } from "./commands/repos.js";
import { runUninstall } from "./commands/uninstall.js";
import { describeError } from "./json.js";
import { levers } from "./levers/registry.js";
import { VERSION } from "./version.js";

type Flags = Record<string, unknown>;

function stringFlag(flags: Flags, name: string): string | null {
	const value = flags[name];
	return typeof value === "string" ? value : null;
}

export async function runCli(argv: readonly string[]): Promise<number> {
	const context: CommandContext = {
		env: process.env,
		cwd: process.cwd(),
		out: (line) => process.stdout.write(`${line}\n`),
		err: (line) => process.stderr.write(`${line}\n`),
		now: () => new Date(),
		argv,
		execPath: process.execPath,
	};
	let exitCode = 0;
	const program = new Command()
		.name("whittle")
		.description(
			"Token-cost levers for coding agents, wired from your home directory and never into a repository",
		)
		.version(VERSION)
		.exitOverride();

	program
		.command("install")
		.description(
			"wire the whittle hook into each detected harness (nothing is active until `enable`)",
		)
		.option("--harness <ids>", "comma-separated harness ids (default: every known harness)")
		.option("--dry-run", "print the planned edits without writing anything")
		.action(async (flags: Flags) => {
			exitCode = await runInstall(
				{ harness: stringFlag(flags, "harness"), dryRun: flags.dryRun === true },
				context,
			);
		});

	program
		.command("uninstall")
		.description("remove every whittle hook entry; a dry run unless -y is given")
		.option("--purge", "also remove whittle's own config, state, backups and cache files")
		.option("-y, --yes", "apply the changes")
		.action(async (flags: Flags) => {
			exitCode = await runUninstall(
				{ purge: flags.purge === true, yes: flags.yes === true },
				context,
			);
		});

	program
		.command("enable")
		.description("opt a repository in (default: the current directory)")
		.argument("[path]", "a path inside the repository")
		.option("--lever <ids>", "comma-separated levers to switch on for this repository")
		.action(async (path: string | undefined, flags: Flags) => {
			exitCode = await runEnable(path, { lever: stringFlag(flags, "lever") }, context);
		});

	program
		.command("disable")
		.description("opt a repository out, or switch individual levers off for it")
		.argument("[path]", "a path inside the repository")
		.option("--lever <ids>", "comma-separated levers to switch off for this repository")
		.action(async (path: string | undefined, flags: Flags) => {
			exitCode = await runDisable(path, { lever: stringFlag(flags, "lever") }, context);
		});

	program
		.command("levers")
		.description("list the levers with their layer, enforcement, dependency and measured effect")
		.action(async () => {
			exitCode = await runLevers(context);
		});

	program
		.command("status")
		.description("show harness wiring, repositories and footprint")
		.option("--json", "print the stable JSON shape")
		.action(async (flags: Flags) => {
			exitCode = await runStatus({ json: flags.json === true }, context);
		});

	program
		.command("doctor")
		.description(
			"check wiring, executables, dependencies and the environment; exits 1 on a failure",
		)
		.action(async () => {
			exitCode = await runDoctor(context);
		});

	program
		.command("footprint")
		.description("list every path whittle has written outside repositories")
		.action(async () => {
			exitCode = await runFootprint(context);
		});

	for (const lever of levers) {
		for (const leverCommand of lever.commands) {
			const command = program.command(leverCommand.name).description(leverCommand.summary);
			if (leverCommand.argument !== null) {
				command.argument(`[${leverCommand.argument.name}]`, leverCommand.argument.description);
			}
			for (const option of leverCommand.options) command.option(option.flags, option.description);
			command.action(async (...args: unknown[]) => {
				const argument =
					leverCommand.argument !== null && typeof args[0] === "string" ? args[0] : undefined;
				const flagsCandidate = leverCommand.argument !== null ? args[1] : args[0];
				const flags: Flags =
					typeof flagsCandidate === "object" && flagsCandidate !== null
						? { ...flagsCandidate }
						: {};
				exitCode = await leverCommand.run(argument, flags, context);
			});
		}
	}

	try {
		await program.parseAsync([...argv]);
	} catch (error) {
		if (error instanceof CommanderError) return error.exitCode;
		context.err(`whittle: ${describeError(error)}`);
		return 1;
	}
	return exitCode;
}
