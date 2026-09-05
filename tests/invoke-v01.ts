import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMaestriTools } from "../src/maestri.ts";

type RegisteredTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, string>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: { cwd: string },
	) => Promise<unknown>;
};

const action = process.argv[2];
const tools = new Map<string, RegisteredTool>();
const pi = {
	registerTool(tool: RegisteredTool) {
		tools.set(tool.name, tool);
	},
} as unknown as ExtensionAPI;

registerMaestriTools(pi);

let toolName: string;
let params: Record<string, string>;
switch (action) {
	case "list":
		toolName = "maestri_list";
		params = {};
		break;
	case "check":
		toolName = "maestri_check";
		params = { agent: process.argv[3] ?? "" };
		break;
	case "ask":
		toolName = "maestri_ask";
		params = { agent: process.argv[3] ?? "", prompt: process.argv[4] ?? "" };
		break;
	default:
		throw new Error("usage: invoke-v01.ts list | check <agent> | ask <agent> <prompt>");
}

const tool = tools.get(toolName);
if (!tool) throw new Error(`tool was not registered: ${toolName}`);
const controller = new AbortController();
const abort = () => controller.abort();
process.once("SIGHUP", abort);
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
try {
	const result = await tool.execute("smoke", params, controller.signal, undefined, { cwd: process.cwd() });
	process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
	process.removeListener("SIGHUP", abort);
	process.removeListener("SIGINT", abort);
	process.removeListener("SIGTERM", abort);
}
