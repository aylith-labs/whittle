#!/usr/bin/env node

// The hook path must load nothing beyond node:* builtins until the dispatcher knows the repository is enabled.
if (process.argv[2] === "hook") {
	import("./hook/dispatch.js")
		.then(({ runHookFromProcess }) => runHookFromProcess(process.argv.slice(3)))
		.then(
			(code) => process.exit(code),
			() => process.exit(0),
		);
} else {
	import("./cli.js")
		.then(({ runCli }) => runCli(process.argv))
		.then(
			(code) => {
				process.exitCode = code;
			},
			(error: unknown) => {
				process.stderr.write(
					`whittle: ${error instanceof Error ? error.message : String(error)}\n`,
				);
				process.exitCode = 1;
			},
		);
}
