import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMaestriAsyncTools } from "../src/ask-async.ts";

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

const tools = new Map<string, RegisteredTool>();
const pi = { registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
registerMaestriAsyncTools(pi);
const tool = tools.get("maestri_ask_async");
if (!tool) throw new Error("maestri_ask_async was not registered");
const result = await tool.execute("cross-process", {
	agent: process.env.ASYNC_TEST_AGENT ?? "",
	prompt: process.env.ASYNC_TEST_PROMPT ?? "",
	client_request_id: process.env.ASYNC_TEST_CLIENT_ID ?? "",
}, undefined, undefined, { cwd: process.env.ASYNC_TEST_CWD ?? process.cwd() });
process.stdout.write(`${JSON.stringify(result)}\n`);
