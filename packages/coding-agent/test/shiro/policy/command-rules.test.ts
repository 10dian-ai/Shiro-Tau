import { describe, expect, it } from "vitest";
import { matchPrefixRules, type PrefixRule, parseRulesFile } from "../../../src/shiro/policy/command-rules.ts";

function rule(pattern: PrefixRule["pattern"], decision: PrefixRule["decision"]): PrefixRule {
	return { pattern, decision, source: "test" };
}

describe("matchPrefixRules", () => {
	it("matches when the command starts with the pattern", () => {
		const rules = [rule(["git", "push"], "prompt")];
		expect(matchPrefixRules(rules, ["git", "push", "origin"])?.decision).toBe("prompt");
		expect(matchPrefixRules(rules, ["git", "pull"])).toBeUndefined();
		expect(matchPrefixRules(rules, ["git"])).toBeUndefined();
	});

	it("accepts any alternative of a list element", () => {
		const rules = [rule(["npm", ["test", "run"]], "allow")];
		expect(matchPrefixRules(rules, ["npm", "run", "build"])?.decision).toBe("allow");
		expect(matchPrefixRules(rules, ["npm", "publish"])).toBeUndefined();
	});

	it("returns the most restrictive match", () => {
		const rules = [
			rule(["git"], "allow"),
			rule(["git", "push", "--force"], "forbidden"),
			rule(["git", "push"], "prompt"),
		];
		expect(matchPrefixRules(rules, ["git", "push", "--force"])?.decision).toBe("forbidden");
		expect(matchPrefixRules(rules, ["git", "push"])?.decision).toBe("prompt");
		expect(matchPrefixRules(rules, ["git", "log"])?.decision).toBe("allow");
	});
});

describe("parseRulesFile", () => {
	it("parses a Codex-style rules file", () => {
		const text = `
# Never rewrite published history.
prefix_rule(
    pattern = ["git", "push", ["--force", "-f"]],
    decision = "forbidden",
    justification = "Use --force-with-lease after review.",
    match = ["git push --force origin main", ["git", "push", "-f"]],
    not_match = ["git push origin main"],
)

prefix_rule(pattern=["npm", "test"])
`;
		const parsed = parseRulesFile(text, "team.rules");
		expect(parsed.errors).toEqual([]);
		expect(parsed.rules).toEqual([
			{
				pattern: ["git", "push", ["--force", "-f"]],
				decision: "forbidden",
				justification: "Use --force-with-lease after review.",
				source: "team.rules:3",
			},
			{ pattern: ["npm", "test"], decision: "allow", source: "team.rules:11" },
		]);
	});

	it("rejects a rule whose examples contradict its pattern", () => {
		const parsed = parseRulesFile(
			'prefix_rule(pattern=["rm"], decision="prompt", match=["ls -la"])\nprefix_rule(pattern=["rm"], not_match=["rm x"])',
			"bad.rules",
		);
		expect(parsed.rules).toEqual([]);
		expect(parsed.errors).toEqual([
			'bad.rules:1: "match" example does not match: ls -la',
			'bad.rules:2: "not_match" example matches: rm x',
		]);
	});

	it("reports a bad rule with its line and keeps the good ones", () => {
		const text = [
			'prefix_rule(pattern=["a"], decision="maybe")',
			'prefix_rule(pattern=["b"], decision="prompt")',
			'host_executable(name="git")',
			"prefix_rule(pattern=[])",
			'prefix_rule(pattern=["c"], colour="red")',
		].join("\n");
		const parsed = parseRulesFile(text, "mixed.rules");
		expect(parsed.rules.map((entry) => entry.pattern)).toEqual([["b"]]);
		expect(parsed.errors).toEqual([
			'mixed.rules:1: "decision" must be "allow", "prompt" or "forbidden"',
			'mixed.rules:3: unsupported statement "host_executable"',
			'mixed.rules:4: "pattern" must be a non-empty list',
			'mixed.rules:5: unknown argument "colour"',
		]);
	});

	it("reports text it cannot tokenize instead of throwing", () => {
		expect(parseRulesFile('prefix_rule(pattern=["a)', "torn.rules").errors).toEqual([
			"torn.rules: line 1: unterminated string",
		]);
		expect(parseRulesFile("prefix_rule(pattern=[1])", "num.rules").errors).toEqual([
			'num.rules: line 1: unexpected character "1"',
		]);
	});
});
