import { describe, expect, test } from "bun:test";
import {
	appendArrayItemEdit,
	appendObjectMemberEdit,
	applyEdit,
	detectLayout,
	findMember,
	nodeValue,
	parseJsonSpans,
	removeChildEdit,
} from "../src/json-span.js";

describe("parseJsonSpans", () => {
	test("spans reproduce JSON.parse values", () => {
		const text = '{\n  "a": [1, 2.50, {"b": "\\u00e9"}],\n  "10": true,\n  "c": null\n}\n';
		const root = parseJsonSpans(text);
		expect(nodeValue(text, root)).toEqual(JSON.parse(text));
		if (root.kind !== "object") throw new Error("expected object");
		expect(root.members.map((member) => member.key)).toEqual(["a", "10", "c"]);
		const first = findMember(root, "a");
		expect(first === undefined ? null : text.slice(first.value.start, first.value.end)).toBe(
			'[1, 2.50, {"b": "\\u00e9"}]',
		);
	});

	test.each([
		['{"a": 1,}', "trailing comma"],
		['{"a": 1 // note\n}', "comment"],
		['{"a": 1, "a": 2}', "duplicate key"],
		['{"a": 1} {}', "second document"],
		['{"a": "unterminated}', "unterminated string"],
	])("rejects %j (%s)", (text) => {
		expect(() => parseJsonSpans(text)).toThrow();
	});
});

describe("edits", () => {
	test("append into an empty array and remove it again restores the bytes", () => {
		const original = '{\n  "hooks": {\n    "Stop": []\n  }\n}\n';
		const root = parseJsonSpans(original);
		if (root.kind !== "object") throw new Error("expected object");
		const hooks = findMember(root, "hooks")?.value;
		if (hooks?.kind !== "object") throw new Error("expected hooks object");
		const stop = findMember(hooks, "Stop")?.value;
		if (stop?.kind !== "array") throw new Error("expected array");
		const added = applyEdit(
			original,
			appendArrayItemEdit(original, stop, { hooks: [] }, detectLayout(original)),
		);
		expect(JSON.parse(added)).toEqual({ hooks: { Stop: [{ hooks: [] }] } });
		const reparsed = parseJsonSpans(added);
		if (reparsed.kind !== "object") throw new Error("expected object");
		const reparsedHooks = findMember(reparsed, "hooks")?.value;
		if (reparsedHooks?.kind !== "object") throw new Error("expected hooks object");
		const reparsedStop = findMember(reparsedHooks, "Stop")?.value;
		if (reparsedStop?.kind !== "array") throw new Error("expected array");
		expect(applyEdit(added, removeChildEdit(reparsedStop, 0))).toBe(original);
	});

	test("appending a member to a pretty object matches the sibling indentation and reverts exactly", () => {
		const original = '{\n\t"theme": "dark",\n\t"statusLine": {\n\t\t"type": "command"\n\t}\n}\n';
		const root = parseJsonSpans(original);
		if (root.kind !== "object") throw new Error("expected object");
		const added = applyEdit(
			original,
			appendObjectMemberEdit(original, root, "hooks", { Stop: [] }, detectLayout(original)),
		);
		expect(added).toContain('\n\t"hooks": {\n\t\t"Stop": []\n\t}\n}');
		const reparsed = parseJsonSpans(added);
		if (reparsed.kind !== "object") throw new Error("expected object");
		expect(applyEdit(added, removeChildEdit(reparsed, 2))).toBe(original);
	});

	test("appending into an inline array reuses its separator", () => {
		const original = '{"list":[1,2]}';
		const root = parseJsonSpans(original);
		if (root.kind !== "object") throw new Error("expected object");
		const list = findMember(root, "list")?.value;
		if (list?.kind !== "array") throw new Error("expected array");
		expect(
			applyEdit(original, appendArrayItemEdit(original, list, 3, detectLayout(original))),
		).toBe('{"list":[1,2,3]}');
	});
});
