import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMaestriAsyncTools } from "./ask-async.ts";
import { registerAskNotifier } from "./ask-notifier.ts";
import { registerCanvasTools } from "./canvas-tools.ts";
import { hasMaestriContext, registerMaestriTools } from "./maestri.ts";
import { registerPortalTools } from "./portal-tools.ts";

export * from "./readiness.ts";

const MAESTRI_SKILLS_PATH = fileURLToPath(new URL("../resources/skills/", import.meta.url));

export default function maestriPiOperator(pi: ExtensionAPI): void {
	const env = process.env;
	if (!hasMaestriContext(env)) return;

	pi.on("resources_discover", () => ({ skillPaths: [MAESTRI_SKILLS_PATH] }));
	registerMaestriTools(pi, { env });
	registerMaestriAsyncTools(pi, { env });
	registerAskNotifier(pi, { env });
	registerCanvasTools(pi, { env });
	registerPortalTools(pi, { env });
}
