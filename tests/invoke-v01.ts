import { registerMaestriTools } from "../src/maestri.ts";
import { createPiToolHarness } from "./support/pi-tools.ts";

const action = process.argv[2];
const controller = new AbortController();
const harness = createPiToolHarness(process.cwd());
registerMaestriTools(harness.registrar);

function invokeAction() {
	switch (action) {
		case "list":
			return harness.invoke("maestri_list", {}, controller.signal);
		case "check":
			return harness.invoke("maestri_check", { agent: process.argv[3] ?? "" }, controller.signal);
		case "ask":
			return harness.invoke("maestri_ask", {
				agent: process.argv[3] ?? "",
				prompt: process.argv[4] ?? "",
			}, controller.signal);
		default:
			throw new Error("usage: invoke-v01.ts list | check <agent> | ask <agent> <prompt>");
	}
}

const abort = () => controller.abort();
process.once("SIGHUP", abort);
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
try {
	const result = await invokeAction();
	process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
	process.removeListener("SIGHUP", abort);
	process.removeListener("SIGINT", abort);
	process.removeListener("SIGTERM", abort);
}
