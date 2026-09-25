export type JsonScalarNode = { kind: "scalar"; start: number; end: number };

export type JsonArrayNode = { kind: "array"; start: number; end: number; items: JsonNode[] };

export type JsonMember = { key: string; start: number; value: JsonNode };

export type JsonObjectNode = { kind: "object"; start: number; end: number; members: JsonMember[] };

export type JsonNode = JsonScalarNode | JsonArrayNode | JsonObjectNode;

export type TextEdit = { start: number; end: number; replacement: string };

export type Layout = { indentUnit: string; newline: string };

type Span = { start: number; end: number };

type Cursor = { offset: number };

export class JsonSyntaxError extends Error {
	readonly offset: number;

	constructor(message: string, offset: number) {
		super(`${message} at offset ${offset}`);
		this.offset = offset;
	}
}

const MAX_DEPTH = 256;
const NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERALS = ["true", "false", "null"] as const;

function skipWhitespace(text: string, cursor: Cursor): void {
	while (cursor.offset < text.length) {
		const code = text.charCodeAt(cursor.offset);
		if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
		cursor.offset += 1;
	}
}

function scanString(text: string, cursor: Cursor): string {
	const start = cursor.offset;
	cursor.offset += 1;
	while (cursor.offset < text.length) {
		const code = text.charCodeAt(cursor.offset);
		if (code === 0x5c) {
			cursor.offset += 2;
			continue;
		}
		if (code === 0x22) {
			cursor.offset += 1;
			let decoded: unknown;
			try {
				decoded = JSON.parse(text.slice(start, cursor.offset));
			} catch {
				throw new JsonSyntaxError("invalid string literal", start);
			}
			if (typeof decoded !== "string") throw new JsonSyntaxError("invalid string literal", start);
			return decoded;
		}
		if (code < 0x20) throw new JsonSyntaxError("control character inside string", cursor.offset);
		cursor.offset += 1;
	}
	throw new JsonSyntaxError("unterminated string", start);
}

function parseObject(text: string, cursor: Cursor, depth: number): JsonObjectNode {
	const start = cursor.offset;
	cursor.offset += 1;
	const members: JsonMember[] = [];
	const seen = new Set<string>();
	skipWhitespace(text, cursor);
	if (text[cursor.offset] === "}") {
		cursor.offset += 1;
		return { kind: "object", start, end: cursor.offset, members };
	}
	for (;;) {
		skipWhitespace(text, cursor);
		if (text[cursor.offset] !== '"') throw new JsonSyntaxError("expected a key", cursor.offset);
		const keyStart = cursor.offset;
		const key = scanString(text, cursor);
		if (seen.has(key)) throw new JsonSyntaxError(`duplicate key "${key}"`, keyStart);
		seen.add(key);
		skipWhitespace(text, cursor);
		if (text[cursor.offset] !== ":") throw new JsonSyntaxError("expected ':'", cursor.offset);
		cursor.offset += 1;
		const value = parseValue(text, cursor, depth + 1);
		members.push({ key, start: keyStart, value });
		skipWhitespace(text, cursor);
		const next = text[cursor.offset];
		cursor.offset += 1;
		if (next === "}") return { kind: "object", start, end: cursor.offset, members };
		if (next !== ",") throw new JsonSyntaxError("expected ',' or '}'", cursor.offset - 1);
	}
}

function parseArray(text: string, cursor: Cursor, depth: number): JsonArrayNode {
	const start = cursor.offset;
	cursor.offset += 1;
	const items: JsonNode[] = [];
	skipWhitespace(text, cursor);
	if (text[cursor.offset] === "]") {
		cursor.offset += 1;
		return { kind: "array", start, end: cursor.offset, items };
	}
	for (;;) {
		items.push(parseValue(text, cursor, depth + 1));
		skipWhitespace(text, cursor);
		const next = text[cursor.offset];
		cursor.offset += 1;
		if (next === "]") return { kind: "array", start, end: cursor.offset, items };
		if (next !== ",") throw new JsonSyntaxError("expected ',' or ']'", cursor.offset - 1);
	}
}

function parseValue(text: string, cursor: Cursor, depth: number): JsonNode {
	if (depth > MAX_DEPTH) throw new JsonSyntaxError("nesting too deep", cursor.offset);
	skipWhitespace(text, cursor);
	const start = cursor.offset;
	const first = text[start];
	if (first === "{") return parseObject(text, cursor, depth);
	if (first === "[") return parseArray(text, cursor, depth);
	if (first === '"') {
		scanString(text, cursor);
		return { kind: "scalar", start, end: cursor.offset };
	}
	for (const literal of LITERALS) {
		if (text.startsWith(literal, start)) {
			cursor.offset += literal.length;
			return { kind: "scalar", start, end: cursor.offset };
		}
	}
	NUMBER_PATTERN.lastIndex = start;
	const number = NUMBER_PATTERN.exec(text);
	if (number !== null && number[0].length > 0) {
		cursor.offset += number[0].length;
		return { kind: "scalar", start, end: cursor.offset };
	}
	throw new JsonSyntaxError("unexpected character", start);
}

export function parseJsonSpans(text: string): JsonNode {
	const cursor: Cursor = { offset: 0 };
	const root = parseValue(text, cursor, 0);
	skipWhitespace(text, cursor);
	if (cursor.offset !== text.length) {
		throw new JsonSyntaxError("unexpected content after the document", cursor.offset);
	}
	return root;
}

export function nodeValue(text: string, node: JsonNode): unknown {
	return JSON.parse(text.slice(node.start, node.end));
}

export function findMember(node: JsonObjectNode, key: string): JsonMember | undefined {
	return node.members.find((member) => member.key === key);
}

export function applyEdit(text: string, edit: TextEdit): string {
	return text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
}

export function detectLayout(text: string): Layout {
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	const indentUnit = /\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";
	return { indentUnit, newline };
}

function lineIndentAt(text: string, offset: number): string {
	const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
	return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? "";
}

function renderPretty(value: unknown, layout: Layout, baseIndent: string): string {
	return JSON.stringify(value, null, layout.indentUnit)
		.split("\n")
		.join(layout.newline + baseIndent);
}

function childSpans(container: JsonArrayNode | JsonObjectNode): Span[] {
	return container.kind === "array"
		? container.items.map((item) => ({ start: item.start, end: item.end }))
		: container.members.map((member) => ({ start: member.start, end: member.value.end }));
}

function renderChild(
	container: JsonArrayNode | JsonObjectNode,
	key: string | null,
	rendered: string,
	pretty: boolean,
): string {
	if (container.kind === "array") return rendered;
	return `${JSON.stringify(key)}:${pretty ? " " : ""}${rendered}`;
}

function appendChild(
	text: string,
	container: JsonArrayNode | JsonObjectNode,
	key: string | null,
	value: unknown,
	layout: Layout,
): TextEdit {
	const spans = childSpans(container);
	const last = spans.at(-1);
	const first = spans[0];
	if (last === undefined || first === undefined) {
		const baseIndent = lineIndentAt(text, container.start);
		const childIndent = baseIndent + layout.indentUnit;
		const rendered = renderPretty(value, layout, childIndent);
		return {
			start: container.start + 1,
			end: container.end - 1,
			replacement: `${layout.newline}${childIndent}${renderChild(container, key, rendered, true)}${layout.newline}${baseIndent}`,
		};
	}
	const leading = text.slice(container.start + 1, first.start);
	if (leading.includes("\n")) {
		const childIndent = leading.slice(leading.lastIndexOf("\n") + 1);
		const rendered = renderPretty(value, layout, childIndent);
		return {
			start: last.end,
			end: last.end,
			replacement: `,${layout.newline}${childIndent}${renderChild(container, key, rendered, true)}`,
		};
	}
	const second = spans[1];
	const separator = second === undefined ? ", " : text.slice(first.end, second.start);
	return {
		start: last.end,
		end: last.end,
		replacement: `${separator}${renderChild(container, key, JSON.stringify(value), false)}`,
	};
}

export function appendArrayItemEdit(
	text: string,
	array: JsonArrayNode,
	value: unknown,
	layout: Layout,
): TextEdit {
	return appendChild(text, array, null, value, layout);
}

export function appendObjectMemberEdit(
	text: string,
	object: JsonObjectNode,
	key: string,
	value: unknown,
	layout: Layout,
): TextEdit {
	return appendChild(text, object, key, value, layout);
}

export function removeChildEdit(
	container: JsonArrayNode | JsonObjectNode,
	index: number,
): TextEdit {
	const spans = childSpans(container);
	const target = spans[index];
	if (target === undefined) throw new RangeError(`no child at index ${index}`);
	if (spans.length === 1)
		return { start: container.start + 1, end: container.end - 1, replacement: "" };
	const previous = spans[index - 1];
	if (previous !== undefined) return { start: previous.end, end: target.end, replacement: "" };
	const next = spans[index + 1];
	if (next === undefined) throw new RangeError(`no sibling after index ${index}`);
	return { start: target.start, end: next.start, replacement: "" };
}

export function replaceNodeEdit(
	text: string,
	node: JsonNode,
	value: unknown,
	layout: Layout,
): TextEdit {
	const pretty = text.includes("\n");
	const replacement = pretty
		? renderPretty(value, layout, lineIndentAt(text, node.start))
		: JSON.stringify(value);
	return { start: node.start, end: node.end, replacement };
}
