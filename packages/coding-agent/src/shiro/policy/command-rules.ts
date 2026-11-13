// Command prefix rules: `prefix_rule(...)` files in the format Codex uses for its `.rules` files.

import { parseShell } from "./shell.ts";

/** What a rule says about a command. When several rules match, the most restrictive one wins. */
export type CommandDecision = "allow" | "prompt" | "forbidden";

/** A command matches when its words start with `pattern`; a list element accepts any of its words. */
export interface PrefixRule {
	pattern: (string | string[])[];
	decision: CommandDecision;
	justification?: string;
	/** File and line the rule came from, for messages. */
	source: string;
}

export interface ParsedRulesFile {
	rules: PrefixRule[];
	/** Problems found, each with its line. A file with errors still yields its valid rules. */
	errors: string[];
}

const SEVERITY: Record<CommandDecision, number> = { allow: 0, prompt: 1, forbidden: 2 };

/** The most restrictive rule matching `argv`, or undefined when none does. */
export function matchPrefixRules(rules: readonly PrefixRule[], argv: readonly string[]): PrefixRule | undefined {
	let strictest: PrefixRule | undefined;
	for (const rule of rules) {
		if (!prefixMatches(rule.pattern, argv)) continue;
		if (!strictest || SEVERITY[rule.decision] > SEVERITY[strictest.decision]) strictest = rule;
	}
	return strictest;
}

/**
 * Parse a rules file. Supported statements are calls to `prefix_rule` with the keyword arguments
 * `pattern`, `decision`, `justification`, `match` and `not_match`; `#` starts a comment. The
 * `match` and `not_match` examples are checked against the rule while loading.
 */
export function parseRulesFile(text: string, source: string): ParsedRulesFile {
	const rules: PrefixRule[] = [];
	const errors: string[] = [];
	let tokens: Token[];
	try {
		tokens = tokenize(text);
	} catch (error) {
		return { rules, errors: [`${source}: ${(error as Error).message}`] };
	}
	let position = 0;
	while (position < tokens.length) {
		const start = tokens[position];
		let call: ReturnType<typeof parseCall>;
		try {
			call = parseCall(tokens, position);
		} catch (error) {
			errors.push(`${source}:${start.line}: ${(error as Error).message}`);
			// The statement's end is unknown: resume at the next identifier that starts a line-level call.
			position = nextStatement(tokens, position + 1);
			continue;
		}
		position = call.next;
		if (call.name !== "prefix_rule") {
			errors.push(`${source}:${start.line}: unsupported statement "${call.name}"`);
			continue;
		}
		try {
			rules.push(buildRule(call.args, `${source}:${start.line}`));
		} catch (error) {
			errors.push(`${source}:${start.line}: ${(error as Error).message}`);
		}
	}
	return { rules, errors };
}

function prefixMatches(pattern: PrefixRule["pattern"], argv: readonly string[]): boolean {
	if (argv.length < pattern.length) return false;
	return pattern.every((part, index) =>
		typeof part === "string" ? part === argv[index] : part.includes(argv[index]),
	);
}

type Value = string | Value[];

interface Token {
	kind: "ident" | "string" | "punct";
	text: string;
	line: number;
}

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let line = 1;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "\n") line++;
		else if (char === "#") {
			while (i + 1 < text.length && text[i + 1] !== "\n") i++;
		} else if (char === '"' || char === "'") {
			let value = "";
			let j = i + 1;
			for (; j < text.length && text[j] !== char; j++) {
				if (text[j] === "\n") throw new Error(`line ${line}: unterminated string`);
				if (text[j] === "\\" && j + 1 < text.length) {
					j++;
					value += text[j] === "n" ? "\n" : text[j] === "t" ? "\t" : text[j];
				} else value += text[j];
			}
			if (j >= text.length) throw new Error(`line ${line}: unterminated string`);
			tokens.push({ kind: "string", text: value, line });
			i = j;
		} else if (/[A-Za-z_]/.test(char)) {
			let j = i;
			while (j + 1 < text.length && /[A-Za-z0-9_]/.test(text[j + 1])) j++;
			tokens.push({ kind: "ident", text: text.slice(i, j + 1), line });
			i = j;
		} else if ("()[],=".includes(char)) {
			tokens.push({ kind: "punct", text: char, line });
		} else if (!/\s/.test(char)) {
			throw new Error(`line ${line}: unexpected character "${char}"`);
		}
	}
	return tokens;
}

function parseCall(tokens: Token[], start: number): { name: string; args: Map<string, Value>; next: number } {
	let position = start;
	const take = (kind: Token["kind"], text?: string): Token => {
		const token = tokens[position];
		if (!token || token.kind !== kind || (text !== undefined && token.text !== text)) {
			throw new Error(`expected ${text ?? kind}${token ? `, got "${token.text}"` : " before the end of the file"}`);
		}
		position++;
		return token;
	};
	const parseValue = (): Value => {
		const token = tokens[position];
		if (token?.kind === "string") {
			position++;
			return token.text;
		}
		take("punct", "[");
		const items: Value[] = [];
		while (tokens[position]?.text !== "]") {
			items.push(parseValue());
			if (tokens[position]?.text === ",") position++;
			else if (tokens[position]?.text !== "]") take("punct", "]");
		}
		position++;
		return items;
	};

	const name = take("ident").text;
	take("punct", "(");
	const args = new Map<string, Value>();
	while (tokens[position]?.text !== ")") {
		const key = take("ident").text;
		take("punct", "=");
		args.set(key, parseValue());
		if (tokens[position]?.text === ",") position++;
		else if (tokens[position]?.text !== ")") take("punct", ")");
	}
	position++;
	return { name, args, next: position };
}

function nextStatement(tokens: Token[], from: number): number {
	for (let i = from; i < tokens.length; i++) {
		if (tokens[i].kind === "ident" && tokens[i + 1]?.text === "(" && tokens[i].line !== tokens[i - 1]?.line) return i;
	}
	return tokens.length;
}

function buildRule(args: Map<string, Value>, source: string): PrefixRule {
	for (const key of args.keys()) {
		if (!["pattern", "decision", "justification", "match", "not_match"].includes(key)) {
			throw new Error(`unknown argument "${key}"`);
		}
	}
	const rawPattern = args.get("pattern");
	if (!Array.isArray(rawPattern) || rawPattern.length === 0) throw new Error('"pattern" must be a non-empty list');
	const pattern = rawPattern.map((part) => {
		if (typeof part === "string") return part;
		if (part.length > 0 && part.every((option) => typeof option === "string")) return part as string[];
		throw new Error('"pattern" elements must be strings or non-empty lists of strings');
	});
	const decision = args.get("decision") ?? "allow";
	if (decision !== "allow" && decision !== "prompt" && decision !== "forbidden") {
		throw new Error('"decision" must be "allow", "prompt" or "forbidden"');
	}
	const justification = args.get("justification");
	if (justification !== undefined && typeof justification !== "string")
		throw new Error('"justification" must be a string');

	const rule: PrefixRule = { pattern, decision, source, ...(justification === undefined ? {} : { justification }) };
	for (const example of examples(args.get("match"), "match")) {
		if (!prefixMatches(pattern, example)) throw new Error(`"match" example does not match: ${example.join(" ")}`);
	}
	for (const example of examples(args.get("not_match"), "not_match")) {
		if (prefixMatches(pattern, example)) throw new Error(`"not_match" example matches: ${example.join(" ")}`);
	}
	return rule;
}

/** Examples are command lines (split like a shell would) or ready-made word lists. */
function examples(value: Value | undefined, name: string): string[][] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`"${name}" must be a list`);
	return value.map((example) => {
		if (typeof example !== "string") {
			if (example.every((word) => typeof word === "string")) return example as string[];
			throw new Error(`"${name}" examples must be strings or lists of strings`);
		}
		const parsed = parseShell(example);
		if (parsed.kind !== "simple" || parsed.commands.length !== 1) {
			throw new Error(`"${name}" example is not a single plain command: ${example}`);
		}
		return parsed.commands[0].argv;
	});
}
