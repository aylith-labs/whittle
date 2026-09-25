import type { CommandIo } from "../levers/types.js";

export type CommandContext = CommandIo & {
	now: () => Date;
	argv: readonly string[];
	execPath: string;
};

export function formatTable(
	headers: readonly string[],
	rows: readonly (readonly string[])[],
): string[] {
	const widths = headers.map((header, column) =>
		Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
	);
	const render = (cells: readonly string[]) =>
		cells
			.map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
			.join("  ")
			.trimEnd();
	return [render(headers), ...rows.map(render)];
}

export function parseIdList(value: string | null): string[] {
	if (value === null) return [];
	return value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
}
