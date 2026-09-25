export const DEFAULT_ALLOW: readonly string[] = ["git status", "git diff", "git log", "ls", "grep"];

// A single "&" is rejected too: it backgrounds a command, which is never a plain argument.
const SHELL_OPERATORS = ["|", "&", ";", ">", "<", "`", "$(", "\n", "\r"] as const;

export function containsShellOperator(text: string): boolean {
	return SHELL_OPERATORS.some((operator) => text.includes(operator));
}

export function readAllowlist(options: Readonly<Record<string, unknown>>): string[] {
	const allow = options.allow;
	if (!Array.isArray(allow)) return [];
	return allow.filter(
		(entry): entry is string =>
			typeof entry === "string" &&
			entry !== "" &&
			entry === entry.trim() &&
			!containsShellOperator(entry),
	);
}

export function matchesAllowlist(command: string, allow: readonly string[]): boolean {
	if (command === "" || command !== command.trim() || containsShellOperator(command)) return false;
	if (command === "rtk" || command.startsWith("rtk ")) return false;
	return allow.some((entry) => command === entry || command.startsWith(`${entry} `));
}
