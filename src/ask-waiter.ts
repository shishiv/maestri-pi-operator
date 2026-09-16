import {
	AskRequestRefusalError,
	askStateRoot,
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

export type Environment = Readonly<Record<string, string | undefined>>;

export class AskWaiterContextError extends Error {
	constructor() {
		super("Async waiter requires MAESTRI_WORKSPACE_ID and MAESTRI_TERMINAL_ID");
		this.name = "AskWaiterContextError";
	}
}

function requireWaiterContext(env: Environment): void {
	if (!env.MAESTRI_WORKSPACE_ID || !env.MAESTRI_TERMINAL_ID) throw new AskWaiterContextError();
}

function requireLocalRequest(env: Environment, root: string): void {
	if (root !== askStateRoot(env)) throw new AskRequestRefusalError("Refusing an async request from a foreign Maestri scope");
}

export async function waitForTerminalRequest(
	env: Environment,
	requestId: string,
	timeoutMs: number,
	pollMs = 100,
): Promise<AskTerminalEnvelope | null> {
	requireWaiterContext(env);
	const located = await locateRequest(env, requestId);
	requireLocalRequest(env, located.root);
	if (located.record.phase === "terminal") return terminalEnvelope(located.record);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
		const record = await readRequest(located.root, requestId);
		if (record.phase === "terminal") return terminalEnvelope(record);
	}
	return null;
}
