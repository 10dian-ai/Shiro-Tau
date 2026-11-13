import { describe, expect, it } from "vitest";
import { isInsideRoots, isReadOnlyCommand } from "../../../src/shiro/policy/read-only.ts";
import { parseShell } from "../../../src/shiro/policy/shell.ts";

const cwd = "/work/app";
const home = "/home/me";

function readOnly(source: string): boolean {
	const parsed = parseShell(source);
	if (parsed.kind !== "simple" || parsed.commands.length !== 1) throw new Error(`not a single command: ${source}`);
	return isReadOnlyCommand(parsed.commands[0], cwd, home, [cwd]);
}

describe("isReadOnlyCommand", () => {
	it.each([
		"ls -la",
		"cat src/a.ts",
		"grep -rn TODO .",
		"git status",
		"git log --oneline -5",
		"git diff HEAD~1",
		"pwd",
		"wc -l a b",
	])("%s only reads", (source) => {
		expect(readOnly(source)).toBe(true);
	});

	it.each([
		"rm a",
		"npm test",
		"node script.js",
		"git commit -m x",
		"git push",
		"curl https://example.com",
		"sed -i s/a/b/ f",
		"tee out",
	])("%s is not known to only read", (source) => {
		expect(readOnly(source)).toBe(false);
	});

	it("refuses read commands that write through a redirect", () => {
		expect(readOnly("cat a > b")).toBe(false);
		expect(readOnly("cat a > /dev/null")).toBe(true);
	});

	it("refuses the arguments that make a reader write or execute", () => {
		expect(readOnly("find . -name '*.ts'")).toBe(true);
		expect(readOnly("find . -delete")).toBe(false);
		expect(readOnly("find . -exec rm {} ;")).toBe(false);
		expect(readOnly("sort -o out in")).toBe(false);
		expect(readOnly("sort --output=out in")).toBe(false);
		expect(readOnly("rg --pre ./run pattern")).toBe(false);
		expect(readOnly("date -s tomorrow")).toBe(false);
	});

	it("accepts only the listing forms of git branch and git remote", () => {
		expect(readOnly("git branch -a")).toBe(true);
		expect(readOnly("git branch feature")).toBe(false);
		expect(readOnly("git branch -D feature")).toBe(false);
		expect(readOnly("git remote -v")).toBe(true);
		expect(readOnly("git remote add x y")).toBe(false);
	});

	it("refuses git forms that can run other programs or write files", () => {
		expect(readOnly("git -c core.pager=evil log")).toBe(false);
		expect(readOnly("git diff --output=patch.diff")).toBe(false);
		expect(readOnly("git diff --ext-diff")).toBe(false);
		expect(readOnly("git")).toBe(false);
	});

	it("refuses reads that leave the workspace", () => {
		expect(readOnly("cat /etc/passwd")).toBe(false);
		expect(readOnly("cat ../other/secret")).toBe(false);
		expect(readOnly("cat ~/.ssh/id_ed25519")).toBe(false);
		expect(readOnly("cat $HOME/.netrc")).toBe(false);
		expect(readOnly("grep --file=/etc/shadow x")).toBe(false);
		expect(readOnly("cat /work/app/src/a.ts")).toBe(true);
		expect(readOnly("cat src/../README.md")).toBe(true);
	});
});

describe("isInsideRoots", () => {
	it("accepts a root and anything below it, and nothing that merely shares a prefix", () => {
		expect(isInsideRoots("/work/app", ["/work/app"])).toBe(true);
		expect(isInsideRoots("/work/app/src/a.ts", ["/work/app"])).toBe(true);
		expect(isInsideRoots("/work/app-other/a.ts", ["/work/app"])).toBe(false);
		expect(isInsideRoots("/work", ["/work/app"])).toBe(false);
		expect(isInsideRoots("/extra/x", ["/work/app", "/extra"])).toBe(true);
	});
});
