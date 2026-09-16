import { registerMaestriAsyncTools } from "../src/ask-async.ts";
import { createPiToolHarness } from "./support/pi-tools.ts";

const cwd = process.env.ASYNC_TEST_CWD ?? process.cwd();
const harness = createPiToolHarness(cwd);
registerMaestriAsyncTools(harness.registrar);
const result = await harness.invoke("maestri_ask_async", {
	agent: process.env.ASYNC_TEST_AGENT ?? "",
	prompt: process.env.ASYNC_TEST_PROMPT ?? "",
	client_request_id: process.env.ASYNC_TEST_CLIENT_ID ?? "",
});
process.stdout.write(`${JSON.stringify(result)}\n`);
