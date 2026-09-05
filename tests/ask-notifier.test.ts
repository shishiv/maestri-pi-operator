import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMaestriAsyncTools } from "../src/ask-async.ts";
import { registerAskNotifier } from "../src/ask-notifier.ts";
import {
	atomicWriteRecord,
	clientDigest,
	createAcceptedRequest,
	createOutput,
	ensureAskStateRoot,
	promptDigest,
	readRequest,
	transitionTerminal,
	type AskRequestRecord,
	type ProcessIdentity,
} from "../src/ask-store.ts";
import { waitForTerminalRequest } from "../src/ask-waiter.ts";

type Handler = (event: unknown, ctx: { isIdle(): boolean }) => unknown;

function fakePi(sendFails = false) {
	const handlers = new Map<string, Handler[]>();
	const messages: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		on(name: string, handler: Handler) {
			const entries = handlers.get(name) ?? [];
			entries.push(handler);
			handlers.set(name, entries);
		},
		registerTool() {},
		sendMessage(message: unknown, options: unknown) {
			if (sendFails) throw new Error("send failed");
			messages.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		messages,
		async emit(name: string, ctx: { isIdle(): boolean }) {
			for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
		},
	};
}

async function fixture(t: TestContext) {
	const home = await mkdtemp(path.join(tmpdir(), "maestri-ask-notifier-"));
	const env = {
		HOME: home,
		XDG_STATE_HOME: path.join(home, "state"),
		MAESTRI_WORKSPACE_ID: "workspace",
		MAESTRI_TERMINAL_ID: "terminal",
	};
	const root = await ensureAskStateRoot(env);
	t.after(async () => rm(home, { recursive: true, force: true }));
	return { env, root };
}

function accepted(root: string): AskRequestRecord {
	return {
		schema: 1,
		scope_key: path.basename(root),
		runner_token_digest: promptDigest("runner"),
		request_id: randomUUID(),
		client_request_id: randomUUID(),
		agent: "Farol",
		prompt_digest: promptDigest("prompt"),
		prompt_bytes: 6,
		created_at: new Date().toISOString(),
		phase: "accepted",
		delivery: "not-attempted",
		reply: "none",
		custody: "none",
		cleanup_deadline_ms: null,
		notification: { state: "none", digest: null, sent_at: null, attempts: 0, claim: null },
		output: { raw_bytes: 0, truncated: false },
		state_version: 1,
	};
}

async function terminal(root: string, reply: "received" | "cancelled" = "received") {
	const record = accepted(root);
	await createAcceptedRequest(root, record, clientDigest(record.client_request_id));
	await createOutput(root, record.request_id);
	const completed = transitionTerminal(record, {
		delivery: reply === "received" ? "confirmed" : "unknown",
		reply,
		reason: reply === "received" ? "envelope-received" : "cancelled",
		termination: reply === "received" ? null : "abort",
		exitCode: reply === "received" ? 0 : null,
		rawBytes: 0,
		truncated: reply !== "received",
	});
	await atomicWriteRecord(root, completed);
	return completed;
}

function owner(pid: number): { pid: number; identity: ProcessIdentity } {
	return { pid, identity: { start_time: String(pid), cmdline_hex: Buffer.from(`owner-${pid}`).toString("hex") } };
}

function notifierOptions(env: Record<string, string>, own: ReturnType<typeof owner>, close: () => void, alive = new Map<number, ProcessIdentity>()) {
	return {
		env,
		owner: own,
		watch: () => ({ close }),
		readIdentity: async (pid: number) => {
			const identity = alive.get(pid);
			return identity ? { identity, pgid: pid } : null;
		},
	};
}

test("one idle wake becomes sent and busy delivery waits for agent_end", async (t) => {
	const { env, root } = await fixture(t);
	const first = await terminal(root);
	let closed = 0;
	const idle = fakePi();
	registerAskNotifier(idle.pi, notifierOptions(env, owner(101), () => { closed += 1; }));
	await idle.emit("session_start", { isIdle: () => true });
	assert.equal(idle.messages.length, 1);
	assert.deepEqual(idle.messages[0].options, { deliverAs: "followUp", triggerTurn: true });
	assert.equal((idle.messages[0].message as { customType: string }).customType, "mpo.ask-terminal");
	const message = idle.messages[0].message;
	assert.ok(message && typeof message === "object" && "content" in message && typeof message.content === "string");
	assert.deepEqual(JSON.parse(message.content), {
		schema: "mpo.ask-terminal-followup.v1",
		request_id: first.request_id,
		digest: (await readRequest(root, first.request_id)).notification.digest,
		next_action: "Call maestri_ask_request with action=result and this request_id, once. Do not resend the prompt.",
	});
	assert.equal((await readRequest(root, first.request_id)).notification.state, "sent");
	await idle.emit("agent_end", { isIdle: () => true });
	assert.equal(idle.messages.length, 1);
	await idle.emit("session_shutdown", { isIdle: () => true });
	assert.equal(closed, 1);
	const sent = await readRequest(root, first.request_id);
	await atomicWriteRecord(root, { ...sent, notification: { ...sent.notification, state: "acked", claim: null } });

	const second = await terminal(root);
	let busy = true;
	const deferred = fakePi();
	registerAskNotifier(deferred.pi, notifierOptions(env, owner(102), () => {}));
	await deferred.emit("session_start", { isIdle: () => !busy });
	assert.equal(deferred.messages.length, 0);
	busy = false;
	await deferred.emit("agent_end", { isIdle: () => true });
	assert.equal(deferred.messages.length, 1);
	assert.equal((await readRequest(root, second.request_id)).notification.state, "sent");
});

test("restart reannounces sent-unacked once and acked result suppresses later sessions", async (t) => {
	const { env, root } = await fixture(t);
	const completed = await terminal(root);
	const first = fakePi();
	registerAskNotifier(first.pi, notifierOptions(env, owner(201), () => {}));
	await first.emit("session_start", { isIdle: () => true });
	assert.equal(first.messages.length, 1);

	const restarted = fakePi();
	registerAskNotifier(restarted.pi, notifierOptions(env, owner(202), () => {}));
	await restarted.emit("session_start", { isIdle: () => true });
	await restarted.emit("agent_end", { isIdle: () => true });
	assert.equal(restarted.messages.length, 1);

	const tools = new Map<string, { execute: Function }>();
	registerMaestriAsyncTools({ registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); } } as never, { env, platform: "linux" });
	await tools.get("maestri_ask_request")!.execute("call", { action: "result", request_id: completed.request_id }, undefined, undefined, { cwd: "/tmp" });
	assert.equal((await readRequest(root, completed.request_id)).notification.state, "acked");
	const afterAck = fakePi();
	registerAskNotifier(afterAck.pi, notifierOptions(env, owner(203), () => {}));
	await afterAck.emit("session_start", { isIdle: () => true });
	assert.equal(afterAck.messages.length, 0);
});

test("live foreign claim yields one sender and dead claim is reclaimable", async (t) => {
	const { env, root } = await fixture(t);
	const completed = await terminal(root);
	const alive = new Map<number, ProcessIdentity>([[301, owner(301).identity]]);
	const first = fakePi();
	registerAskNotifier(first.pi, notifierOptions(env, owner(301), () => {}, alive));
	await first.emit("session_start", { isIdle: () => true });
	const second = fakePi();
	registerAskNotifier(second.pi, notifierOptions(env, owner(302), () => {}, alive));
	await second.emit("session_start", { isIdle: () => true });
	assert.equal(first.messages.length + second.messages.length, 1);
	alive.delete(301);
	const restarted = fakePi();
	registerAskNotifier(restarted.pi, notifierOptions(env, owner(303), () => {}, alive));
	await restarted.emit("session_start", { isIdle: () => true });
	assert.equal(restarted.messages.length, 1);
	assert.equal((await readRequest(root, completed.request_id)).notification.attempts, 2);
});

test("send failure stays pending and finite waiter never mutates notification state", async (t) => {
	const { env, root } = await fixture(t);
	const completed = await terminal(root, "cancelled");
	const failing = fakePi(true);
	registerAskNotifier(failing.pi, notifierOptions(env, owner(401), () => {}));
	await failing.emit("session_start", { isIdle: () => true });
	const pending = await readRequest(root, completed.request_id);
	assert.equal(pending.notification.state, "pending");
	assert.equal(pending.notification.attempts, 1);
	const before = JSON.stringify(pending.notification);
	const envelope = await waitForTerminalRequest(env, completed.request_id, 10, 2);
	assert.ok(envelope);
	assert.equal(JSON.stringify((await readRequest(root, completed.request_id)).notification), before);
});
