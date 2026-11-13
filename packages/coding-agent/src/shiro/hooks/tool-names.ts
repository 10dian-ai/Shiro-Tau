// Translates between this agent's tools and the tool names and fields that existing hooks were written against.

/** The names hooks know the built-in tools by; they are Claude Code's. Other tools keep their own name. */
const HOOK_TOOL_NAMES: Record<string, string> = {
	bash: "Bash",
	powershell: "PowerShell",
	read: "Read",
	write: "Write",
	edit: "Edit",
	grep: "Grep",
	find: "Glob",
	ls: "LS",
};

/** Fields added for hooks only. They are never passed on to the tool. */
const ALIAS_FIELDS = ["file_path", "old_string", "new_string"];

/** The tool name a hook sees in its matcher and payload. */
export function hookToolName(toolName: string): string {
	return HOOK_TOOL_NAMES[toolName] ?? toolName;
}

/**
 * The tool input a hook sees: the tool's own fields plus the ones hooks expect, so a script that
 * reads `tool_input.file_path` or `tool_input.old_string` keeps working.
 */
export function hookToolInput(input: Record<string, unknown>): Record<string, unknown> {
	const view: Record<string, unknown> = { ...input };
	if (typeof input.path === "string") view.file_path = input.path;
	const edit = singleEdit(input);
	if (edit) {
		view.old_string = edit.oldText;
		view.new_string = edit.newText;
	}
	return view;
}

/**
 * The tool input after a hook rewrote it. `updated` uses the fields the hook was shown; the result
 * uses the tool's own. Fields the hook left out keep their current value.
 */
export function applyUpdatedInput(
	input: Record<string, unknown>,
	updated: Record<string, unknown>,
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...input };
	for (const [key, value] of Object.entries(updated)) {
		if (!ALIAS_FIELDS.includes(key)) next[key] = value;
	}
	// An alias only wins when the hook changed it: hooks usually echo the whole input back.
	const shown = hookToolInput(input);
	if (typeof updated.file_path === "string" && updated.file_path !== shown.file_path) next.path = updated.file_path;
	const edit = singleEdit(input);
	if (edit && (updated.old_string !== shown.old_string || updated.new_string !== shown.new_string)) {
		next.edits = [
			{
				...edit,
				...(typeof updated.old_string === "string" ? { oldText: updated.old_string } : {}),
				...(typeof updated.new_string === "string" ? { newText: updated.new_string } : {}),
			},
		];
	}
	return next;
}

interface TextEdit {
	oldText: string;
	newText: string;
}

/** The edit of an `edit` call that makes exactly one replacement; hooks expect that flat form. */
function singleEdit(input: Record<string, unknown>): TextEdit | undefined {
	// Tool input reaches hooks from the model, and `updatedInput` from a script: both are checked here.
	if (!Array.isArray(input.edits) || input.edits.length !== 1) return undefined;
	const edit: unknown = input.edits[0];
	if (typeof edit !== "object" || edit === null) return undefined;
	const { oldText, newText } = edit as Partial<TextEdit>;
	return typeof oldText === "string" && typeof newText === "string" ? { oldText, newText } : undefined;
}
