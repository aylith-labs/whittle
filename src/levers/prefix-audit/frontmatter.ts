export type FrontmatterValue = string | boolean | string[];

export type Frontmatter =
	| { kind: "none" }
	| { kind: "unterminated" }
	| { kind: "ok"; fields: Record<string, FrontmatterValue>; bodyOffset: number };

const KEY_LINE = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/;
const BLOCK_INDICATOR = /^([|>])([+-]?)(\d?)([+-]?)\s*(?:#.*)?$/;

function indentOf(line: string): number {
	return /^[ \t]*/.exec(line)?.[0].length ?? 0;
}

function isBlank(line: string): boolean {
	return line.trim() === "";
}

function foldLines(lines: readonly string[]): string {
	let result = "";
	let pendingNewlines = 0;
	for (const line of lines) {
		if (isBlank(line)) {
			pendingNewlines += 1;
			continue;
		}
		if (result !== "") result += pendingNewlines > 0 ? "\n".repeat(pendingNewlines) : " ";
		result += line.trim();
		pendingNewlines = 0;
	}
	return result;
}

function blockScalar(style: string, chomping: string, lines: readonly string[]): string {
	const contentIndent = Math.min(...lines.filter((line) => !isBlank(line)).map(indentOf));
	const stripped = lines.map((line) => (isBlank(line) ? "" : line.slice(contentIndent)));
	let body = style === "|" ? stripped.join("\n") : foldLines(stripped);
	body = body.replace(/\n+$/, "");
	if (chomping === "+") return `${body}\n`;
	if (chomping === "-") return body;
	return body === "" ? "" : `${body}\n`;
}

function unquote(raw: string): string | null {
	if (raw.startsWith('"')) {
		const end = raw.lastIndexOf('"');
		if (end <= 0) return null;
		try {
			const decoded: unknown = JSON.parse(raw.slice(0, end + 1));
			return typeof decoded === "string" ? decoded : raw.slice(1, end);
		} catch {
			return raw.slice(1, end);
		}
	}
	if (raw.startsWith("'")) {
		const end = raw.lastIndexOf("'");
		if (end <= 0) return null;
		return raw.slice(1, end).replaceAll("''", "'");
	}
	return raw;
}

function inlineList(raw: string): string[] {
	return raw
		.slice(1, raw.lastIndexOf("]"))
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "")
		.map((item) => unquote(item) ?? item);
}

function stripComment(raw: string): string {
	const match = /\s#/.exec(raw);
	return match === null ? raw : raw.slice(0, match.index);
}

function scalarOrQuoted(first: string, continuation: readonly string[]): FrontmatterValue {
	const joined = foldLines([first, ...continuation]);
	if (first.startsWith('"') || first.startsWith("'")) return unquote(joined) ?? joined;
	const plain = stripComment(joined).trim();
	if (plain === "true") return true;
	if (plain === "false") return false;
	return plain;
}

export function parseFrontmatter(source: string): Frontmatter {
	const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { kind: "none" };
	const closing = lines.findIndex(
		(line, index) => index > 0 && (line.trim() === "---" || line.trim() === "..."),
	);
	if (closing === -1) return { kind: "unterminated" };
	const body = lines.slice(1, closing);
	const fields: Record<string, FrontmatterValue> = {};
	let index = 0;
	while (index < body.length) {
		const line = body[index] ?? "";
		index += 1;
		const match = indentOf(line) === 0 ? KEY_LINE.exec(line) : null;
		if (match === null) continue;
		const key = match[1] ?? "";
		const rest = (match[2] ?? "").trim();
		const continuation: string[] = [];
		while (index < body.length) {
			const next = body[index] ?? "";
			if (!isBlank(next) && indentOf(next) === 0) break;
			continuation.push(next);
			index += 1;
		}
		while (continuation.length > 0 && isBlank(continuation.at(-1) ?? "")) continuation.pop();
		const block = BLOCK_INDICATOR.exec(rest);
		if (block !== null) {
			fields[key] = blockScalar(block[1] ?? "|", block[2] || block[4] || "", continuation);
		} else if (rest === "" && continuation.some((item) => item.trim().startsWith("- "))) {
			fields[key] = continuation
				.map((item) => item.trim())
				.filter((item) => item.startsWith("- "))
				.map((item) => {
					const value = item.slice(2).trim();
					return unquote(value) ?? value;
				});
		} else if (rest.startsWith("[")) {
			fields[key] = inlineList(foldLines([rest, ...continuation]));
		} else {
			fields[key] = scalarOrQuoted(rest, continuation);
		}
	}
	const bodyOffset = lines.slice(0, closing + 1).join("\n").length + 1;
	return { kind: "ok", fields, bodyOffset };
}
