import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMaestriAsyncTools } from "./ask-async.ts";
import { registerAskNotifier } from "./ask-notifier.ts";
import { registerCanvasTools } from "./canvas-tools.ts";
import { registerMaestriTools } from "./maestri.ts";
import { registerPortalTools } from "./portal-tools.ts";

export * from "./readiness.ts";

export default function maestriPiOperator(pi: ExtensionAPI): void {
	registerMaestriTools(pi);
	registerMaestriAsyncTools(pi);
	registerAskNotifier(pi);
	registerCanvasTools(pi);
	registerPortalTools(pi);
}
