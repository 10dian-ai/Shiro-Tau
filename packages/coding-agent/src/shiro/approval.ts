// Settles whether a tool call may run: asks the policy engine, and the user when the engine says to ask.

import type { ExtensionContext } from "../core/extensions/types.ts";
import type { Decision, DecisionStage, ToolRequest } from "./policy/index.ts";
import type { ShiroSession } from "./session.ts";
import type { DecisionVia } from "./workgraph/index.ts";

/** The final answer for one call. `decision` holds the stage and reason that go into the work log. */
export interface Settlement {
	outcome: "allow" | "deny";
	via: DecisionVia;
	decision: Decision;
}

const YES = "Yes";
const NO = "No";

const VIA_BY_STAGE: Record<DecisionStage, DecisionVia> = {
	"deny-rule": "rule",
	"command-rule": "rule",
	"ask-rule": "rule",
	"allow-rule": "rule",
	hook: "hook",
	"plan-mode": "mode",
	"protected-path": "mode",
	boundary: "mode",
	"read-only": "mode",
	mode: "mode",
};

/**
 * Settles tool calls. Calls that need the user are handled one at a time, so two prompts never
 * compete for the screen and an "always allow" answer covers the calls waiting behind it.
 */
export class ApprovalGate {
	private tail: Promise<unknown> = Promise.resolve();

	/**
	 * Decide `request`. `shown` is the description of the call the user reads in the prompt, and
	 * `hookPermission` is what PreToolUse hooks asked for.
	 */
	settle(
		session: ShiroSession,
		request: ToolRequest,
		shown: string,
		hookPermission: "allow" | "ask" | undefined,
		ctx: ExtensionContext,
	): Promise<Settlement> {
		const decision = session.policy.evaluate(request, hookPermission);
		if (decision.outcome !== "ask") return Promise.resolve(settled(decision));
		const turn = this.tail.then(() => askUser(session, request, shown, hookPermission, ctx));
		// A failed prompt must not block the calls queued behind it; its own caller still sees the failure.
		this.tail = turn.catch(() => undefined);
		return turn;
	}
}

async function askUser(
	session: ShiroSession,
	request: ToolRequest,
	shown: string,
	hookPermission: "allow" | "ask" | undefined,
	ctx: ExtensionContext,
): Promise<Settlement> {
	// Evaluated again: the answer to an earlier prompt may have granted this call while it waited.
	const decision = session.policy.evaluate(request, hookPermission);
	if (decision.outcome !== "ask") return settled(decision);
	if (!ctx.hasUI) {
		const reason = `${decision.reason}. Nobody can be asked in this mode: allow it with a permission rule or start with --permission-mode`;
		return { outcome: "deny", via: "no-ui", decision: { ...decision, reason } };
	}

	const grant = session.policy.suggestGrant(request, decision);
	const always = grant ? `Yes, and do not ask again this session for ${grant.text}` : undefined;
	const choice = await ctx.ui.select(
		`Allow ${request.toolName}?\n\n${shown}\n\n${decision.reason}`,
		always ? [YES, always, NO] : [YES, NO],
		ctx.signal ? { signal: ctx.signal } : undefined,
	);
	if (grant && choice === always) {
		session.policy.grant(grant);
		return {
			outcome: "allow",
			via: "user",
			decision: { ...decision, reason: `The user allowed ${grant.text} for the session` },
		};
	}
	if (choice === YES)
		return { outcome: "allow", via: "user", decision: { ...decision, reason: "The user allowed this call" } };
	return { outcome: "deny", via: "user", decision: { ...decision, reason: "The user declined this call" } };
}

function settled(decision: Decision): Settlement {
	return { outcome: decision.outcome === "allow" ? "allow" : "deny", via: VIA_BY_STAGE[decision.stage], decision };
}
