// Splits a shell command line into its simple commands so rules can judge each one separately.

/** One command between separators, with quotes removed and redirections taken out. */
export interface SimpleCommand {
	/** Command name and arguments, after leading `NAME=value` assignments. */
	argv: string[];
	/** Files the command's output is redirected into, as written; /dev/null is left out. */
	writeTargets: string[];
}

/**
 * `simple`: every command on the line is listed. `complex`: the line uses a construct this parser
 * does not follow (substitution, subshell, heredoc), so no rule may auto-allow it.
 */
export type ParsedShell = { kind: "simple"; commands: SimpleCommand[] } | { kind: "complex"; reason: string };

/** Parse a command line. Never throws; anything it cannot follow comes back as `complex`. */
export function parseShell(source: string): ParsedShell {
	const commands: SimpleCommand[] = [];
	let words: string[] = [];
	let word = "";
	let hasWord = false;
	let writeTargets: string[] = [];
	// Set after a redirection operator: the next word is its target, not an argument.
	let redirect: "read" | "write" | undefined;

	const endWord = (): void => {
		if (!hasWord) return;
		if (redirect) {
			if (redirect === "write" && word !== "/dev/null") writeTargets.push(word);
			redirect = undefined;
		} else {
			words.push(word);
		}
		word = "";
		hasWord = false;
	};
	const endCommand = (): string | undefined => {
		endWord();
		if (redirect) return "redirection without a target";
		let start = 0;
		while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start])) start++;
		const argv = words.slice(start);
		if (argv.length > 0) {
			if (argv[0].startsWith("$")) return "the command name is a variable";
			if (argv[0] === "{" || argv[0] === "}") return "command group";
			commands.push({ argv, writeTargets });
		}
		words = [];
		writeTargets = [];
		return undefined;
	};

	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		const next = source[i + 1];
		if (char === "'") {
			const close = source.indexOf("'", i + 1);
			if (close === -1) return complex("unterminated quote");
			word += source.slice(i + 1, close);
			hasWord = true;
			i = close;
		} else if (char === '"') {
			let j = i + 1;
			for (; j < source.length && source[j] !== '"'; j++) {
				if (source[j] === "`" || (source[j] === "$" && source[j + 1] === "("))
					return complex("command substitution");
				if (source[j] === "\\" && j + 1 < source.length) j++;
				word += source[j];
			}
			if (j >= source.length) return complex("unterminated quote");
			hasWord = true;
			i = j;
		} else if (char === "\\") {
			if (next === undefined) return complex("trailing backslash");
			if (next !== "\n") {
				word += next;
				hasWord = true;
			}
			i++;
		} else if (char === "`" || (char === "$" && next === "(")) {
			return complex("command substitution");
		} else if (char === "(" || char === ")") {
			return complex("subshell");
		} else if (char === "#" && !hasWord) {
			const lineEnd = source.indexOf("\n", i);
			i = lineEnd === -1 ? source.length : lineEnd - 1;
		} else if (char === ">" || char === "<") {
			// A file descriptor number or `&` glued to the operator belongs to it, not to the arguments.
			if (hasWord && /^(\d+|&)$/.test(word)) {
				word = "";
				hasWord = false;
			}
			endWord();
			if (redirect) return complex("redirection without a target");
			if (char === "<" && next === "<" && source[i + 2] !== "<") return complex("heredoc");
			if (char === "<" && next === "(") return complex("process substitution");
			while (source[i + 1] === char) i++;
			if (source[i + 1] === "(") return complex("process substitution");
			if (source[i + 1] === "&" && /[\d-]/.test(source[i + 2] ?? "")) {
				i += 2;
				while (/\d/.test(source[i + 1] ?? "")) i++;
			} else {
				if (source[i + 1] === "&" || source[i + 1] === "|") i++;
				redirect = char === ">" ? "write" : "read";
			}
		} else if (char === "&" && next === ">") {
			// `&>file` redirects both streams; the `>` branch handles it on the next character.
			endWord();
		} else if (char === ";" || char === "\n" || char === "|" || char === "&") {
			const problem = endCommand();
			if (problem) return complex(problem);
			if ((char === "|" || char === "&") && (next === char || (char === "|" && next === "&"))) i++;
		} else if (char === " " || char === "\t" || char === "\r") {
			endWord();
		} else {
			word += char;
			hasWord = true;
		}
	}
	const problem = endCommand();
	return problem ? complex(problem) : { kind: "simple", commands };
}

/**
 * Rough command candidates for a line `parseShell` calls complex: the text is cut at every
 * separator and substitution boundary and each piece split on whitespace. It over-reports on
 * purpose and is only used to apply deny rules, never to allow anything.
 */
export function looseCommands(source: string): string[][] {
	return source
		.split(/\$\(|[;|&(){}`\n]/)
		.map((piece) => {
			const words = piece.trim().split(/\s+/).filter(Boolean);
			let start = 0;
			while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start])) start++;
			return words.slice(start).map((entry) => entry.replace(/^["']|["']$/g, ""));
		})
		.filter((words) => words.length > 0);
}

function complex(reason: string): ParsedShell {
	return { kind: "complex", reason };
}
