import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMaestriAsyncTools } from "./ask-async.ts";
import { registerAskNotifier } from "./ask-notifier.ts";
import { registerCanvasTools } from "./canvas-tools.ts";
import { hasMaestriContext, registerMaestriTools } from "./maestri.ts";
import { registerPortalTools } from "./portal-tools.ts";
import { registerMaestriOperatorCommand } from "./operator-command.ts";

export * from "./readiness.ts";

export default function maestriPiOperator(pi: ExtensionAPI): void {
	const env = process.env;
	if (!hasMaestriContext(env)) return;

	registerMaestriOperatorCommand(pi);
	registerMaestriTools(pi, { env });
	registerMaestriAsyncTools(pi, { env });
	registerAskNotifier(pi, { env });
	registerCanvasTools(pi, { env });
	registerPortalTools(pi, { env });
}
