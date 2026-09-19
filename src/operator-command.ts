import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
// OMP remaps bare "typebox" to its tool facade; internal schemas must match typebox/value.
import * as Type from "typebox/type";
import { Check } from "typebox/value";

const CUSTOM_TYPE = "mpo.maestri-operator";
const InvocationDetailsSchema = Type.Object({ digest: Type.String() });

const OPERATOR_GUIDANCE = `Maestri operator context:
- Discover exact connected names with maestri_list before addressing an agent, note, role, or portal.
- Prefer the native maestri_* tools. Use maestri_portal for web and maestri_portal_device for Android; refresh snapshots after screen changes.
- Respect permissions and resource custody: do not close portals, resend uncertain requests, or perform consequential actions without authorization.
- For async asks, retain the original request_id and recover it; do not resend after timeout, cancellation, unknown delivery, or permission failure.
- Use the documented Maestri CLI only when the extension capability is absent or a failure is proven before any send. Never use it as fallback after timeout, cancellation, unknown delivery, or a permission failure.`;

function invocationDigest(args: string): string {
	return createHash("sha256").update(args, "utf8").digest("hex");
}

function hasInvocation(ctx: ExtensionCommandContext, digest: string): boolean {
	return ctx.sessionManager.getEntries().some((entry) => {
		if (entry.type !== "custom_message" || entry.customType !== CUSTOM_TYPE) return false;
		if (!Check(InvocationDetailsSchema, entry.details)) return false;
		return entry.details.digest === digest;
	});
}

export function registerMaestriOperatorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("maestri-operator", {
		description: "Inject Maestri operating guidance, optionally for a task",
		async handler(args, ctx) {
			const task = args.trim();
			const digest = invocationDigest(task);
			if (hasInvocation(ctx, digest)) {
				ctx.ui.notify("Maestri operator guidance is already active for this invocation.", "info");
				return;
			}
			const content = task ? `${OPERATOR_GUIDANCE}\n\nTask: ${task}` : OPERATOR_GUIDANCE;
			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content,
				display: true,
				details: { digest },
			}, task
				? { deliverAs: "followUp", triggerTurn: true }
				: { deliverAs: "nextTurn" });
		},
	});
}
