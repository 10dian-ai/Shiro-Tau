import { describe, expect, it } from "vitest";
import { applyUpdatedInput, hookToolInput, hookToolName } from "../../../src/shiro/hooks/tool-names.ts";

describe("hookToolName", () => {
	it("uses the names hooks were written against and leaves other tools alone", () => {
		expect(["bash", "read", "write", "edit", "grep", "find", "ls"].map(hookToolName)).toEqual([
			"Bash",
			"Read",
			"Write",
			"Edit",
			"Grep",
			"Glob",
			"LS",
		]);
		expect(hookToolName("mcp__github__create_issue")).toBe("mcp__github__create_issue");
	});
});

describe("hookToolInput", () => {
	it("adds the fields hooks expect next to the tool's own", () => {
		expect(hookToolInput({ command: "ls" })).toEqual({ command: "ls" });
		expect(hookToolInput({ path: "a.ts", content: "x" })).toEqual({ path: "a.ts", content: "x", file_path: "a.ts" });
		expect(hookToolInput({ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] })).toEqual({
			path: "a.ts",
			edits: [{ oldText: "a", newText: "b" }],
			file_path: "a.ts",
			old_string: "a",
			new_string: "b",
		});
	});

	it("gives no flat edit fields when a call makes several edits", () => {
		const view = hookToolInput({
			path: "a.ts",
			edits: [
				{ oldText: "a", newText: "b" },
				{ oldText: "c", newText: "d" },
			],
		});
		expect(view.old_string).toBeUndefined();
	});
});

describe("applyUpdatedInput", () => {
	it("applies a rewritten command", () => {
		expect(applyUpdatedInput({ command: "npm test", timeout: 5 }, { command: "npm test -- --run" })).toEqual({
			command: "npm test -- --run",
			timeout: 5,
		});
	});

	it("maps the hook-side fields back onto the tool's own and never passes them on", () => {
		expect(applyUpdatedInput({ path: "a.ts", content: "x" }, { file_path: "b.ts", content: "y" })).toEqual({
			path: "b.ts",
			content: "y",
		});
		expect(
			applyUpdatedInput(
				{ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
				{ file_path: "a.ts", old_string: "a", new_string: "B" },
			),
		).toEqual({ path: "a.ts", edits: [{ oldText: "a", newText: "B" }] });
	});

	it("keeps the tool's own field when a hook echoes the whole input and changes only that", () => {
		const shown = hookToolInput({ path: "a.ts", content: "x" });
		expect(applyUpdatedInput({ path: "a.ts", content: "x" }, { ...shown, path: "c.ts" })).toEqual({
			path: "c.ts",
			content: "x",
		});
	});
});
