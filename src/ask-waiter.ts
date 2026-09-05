import {
	locateRequest,
	readRequest,
} from "./ask-store.ts";
import { terminalEnvelope, type AskTerminalEnvelope } from "./ask-terminal.ts";

export {
	ASK_TERMINAL_ENVELOPE_MAX_BYTES,
	ASK_TERMINAL_ENVELOPE_SCHEMA,
	canonicalJson,
	terminalEnvelope,
	type AskTerminalEnvelope,
} from "./ask-terminal.ts";
export const ASK_WAITER_DEFAULT_TIMEOUT_SECONDS = 55;
export const ASK_WAITER_MAX_TIMEOUT_SECONDS = 55;

type Environment = Readonly<Record<string, string | undefined>>;

export async function waitForTerminalRequest(
	env: Environment,
	requestId: string,
	timeoutMs: number,
	pollMs = 100,
): Promise<AskTerminalEnvelope | null> {
	const located = await locateRequest(env, requestId);
	if (located.record.phase === "terminal") return terminalEnvelope(located.record);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
		const record = await readRequest(located.root, requestId);
		if (record.phase === "terminal") return terminalEnvelope(record);
	}
	return null;
}
