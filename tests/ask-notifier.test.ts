import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { registerMaestriAsyncTools } from "../src/ask-async.ts";
import { parseAskRequestRecord } from "../src/ask-receipt.ts";
import {
	registerAskNotifier,
	type AskNotifierMessage,
	type AskNotifierPi,
	type NotifierContext,
	type NotifierEventName,
	type NotifierHandler,
} from "../src/ask-notifier.ts";
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
import { createPiToolHarness } from "./support/pi-tools.ts";

interface TestOwner {
	pid: number;
	identity: ProcessIdentity;
}

function fakePi(sendFails: () => boolean = () => false, onSend: () => void = () => {}) {
	const handlers = new Map<NotifierEventName, NotifierHandler[]>();
	const messages: Array<{ message: AskNotifierMessage; options: { deliverAs: "followUp"; triggerTurn: true } }> = [];
	const pi: AskNotifierPi = {
		on(name, handler) {
			const entries = handlers.get(name) ?? [];
			entries.push(handler);
			handlers.set(name, entries);
		},
		sendMessage(message, options) {
			if (sendFails()) throw new Error("send failed");
			messages.push({ message, options });
			onSend();
		},
	};
	return {
		pi,
		messages,
		async emit(name: NotifierEventName, ctx: NotifierContext) {
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

function owner(pid: number): TestOwner {
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
	assert.equal(idle.messages[0].message.customType, "mpo.ask-terminal");
	const message = idle.messages[0].message;
	const followup = JSON.parse(message.content);
	assert.deepEqual({ schema: followup.schema, request_id: followup.request_id, digest: followup.digest }, {
		schema: "mpo.ask-terminal-followup.v1",
		request_id: first.request_id,
		digest: (await readRequest(root, first.request_id)).notification.digest,
	});
	assert.equal((await readRequest(root, first.request_id)).notification.state, "sent");
	await idle.emit("agent_end", { isIdle: () => true });
	assert.equal(idle.messages.length, 1);
	await idle.emit("session_shutdown", { isIdle: () => true });
	assert.equal(closed, 1);
	const harness = createPiToolHarness("/tmp");
	registerMaestriAsyncTools(harness.registrar, { env, platform: "linux" });
	await harness.invoke("maestri_ask_request", { action: "result", request_id: followup.request_id });
	assert.equal((await readRequest(root, first.request_id)).notification.state, "acked");

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
	await deferred.emit("session_shutdown", { isIdle: () => true });
});

test("completion during busy survives agent_end and a long continuation without another idle event", { timeout: 2_000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { env, root } = await fixture(t);
	const delivered = latch();
	let busy = true;
	const deliveryIdle: boolean[] = [];
	const fake = fakePi(() => false, () => { deliveryIdle.push(!busy); delivered.resolve(); });
	const ctx = { isIdle: () => !busy };
	let changed = () => {};
	registerAskNotifier(fake.pi, {
		...notifierOptions(env, owner(151), () => {}),
		watch: (_path, listener) => { changed = listener; return { close() {} }; },
	});
	t.after(() => fake.emit("session_shutdown", ctx));
	await fake.emit("session_start", ctx);
	const completed = await terminal(root);
	changed();
	await fake.emit("agent_end", ctx);
	for (let continuation = 0; continuation < 5; continuation += 1) t.mock.timers.tick(60_000);
	assert.equal(fake.messages.length, 0);
	const pending = await readRequest(root, completed.request_id);
	assert.equal(pending.notification.state, "pending");
	assert.equal(pending.notification.attempts, 0);
	// OMP clears its in-flight counter only after the extension's agent_end handler returns.
	busy = false;
	t.mock.timers.tick(60_000);
	await delivered.promise;
	await fake.emit("agent_end", ctx);
	await fake.emit("session_shutdown", ctx);
	t.mock.timers.tick(60_000);
	assert.deepEqual(deliveryIdle, [true]);
	assert.equal(fake.messages.length, 1);
	assert.equal(fake.messages[0].message.details.request_id, completed.request_id);
	const sent = await readRequest(root, completed.request_id);
	assert.equal(sent.notification.state, "sent");
	assert.equal(sent.notification.attempts, 1);
});

test("shutdown cancels a pending idle wake and ignores late watcher or agent events", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { env, root } = await fixture(t);
	const completed = await terminal(root);
	const fake = fakePi();
	let busy = true;
	let closed = 0;
	let changed = () => {};
	const ctx = { isIdle: () => !busy };
	registerAskNotifier(fake.pi, {
		...notifierOptions(env, owner(152), () => {}),
		watch: (_path, listener) => { changed = listener; return { close() { closed += 1; } }; },
	});
	t.after(() => fake.emit("session_shutdown", ctx));
	await fake.emit("session_start", ctx);
	await fake.emit("agent_end", ctx);
	t.mock.timers.tick(60_000);
	await fake.emit("session_shutdown", ctx);
	busy = false;
	changed();
	await fake.emit("agent_end", ctx);
	t.mock.timers.tick(60_000);
	assert.equal(closed, 1);
	assert.equal(fake.messages.length, 0);
	assert.equal((await readRequest(root, completed.request_id)).notification.attempts, 0);
	await fake.emit("session_start", ctx);
	assert.equal(fake.messages.length, 1);
	assert.equal((await readRequest(root, completed.request_id)).notification.state, "sent");
	await fake.emit("session_shutdown", ctx);
});

test("busy or shutdown during asynchronous claim must prevent sending until an idle session", { timeout: 2_000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const stop of [false, true]) {
		const { env, root } = await fixture(t);
		const completed = await terminal(root);
		await atomicWriteRecord(root, { ...completed, notification: { ...completed.notification, claim: owner(161) } });
		const delivered = latch();
		const fake = fakePi(() => false, delivered.resolve);
		let busy = false;
		const ctx = { isIdle: () => !busy };
		let shuttingDown: Promise<void> | undefined;
		registerAskNotifier(fake.pi, {
			...notifierOptions(env, owner(162), () => {}),
			readIdentity: async () => {
				if (stop) shuttingDown = fake.emit("session_shutdown", ctx);
				else busy = true;
				return null;
			},
		});
		t.after(() => fake.emit("session_shutdown", ctx));
		await fake.emit("session_start", ctx);
		await shuttingDown;
		assert.equal(fake.messages.length, 0, stop ? "stopped" : "busy");
		assert.equal((await readRequest(root, completed.request_id)).notification.attempts, 0);
		busy = false;
		t.mock.timers.tick(60_000);
		if (!stop) await delivered.promise;
		await fake.emit("session_shutdown", ctx);
		assert.equal(fake.messages.length, stop ? 0 : 1);
		assert.equal((await readRequest(root, completed.request_id)).notification.state, stop ? "pending" : "sent");
	}
});

test("an acknowledgment after the claim suppresses that notice without blocking other results", async (t) => {
	const { env, root } = await fixture(t);
	const acknowledged = await terminal(root);
	const file = path.join(root, `${acknowledged.request_id}.json`);
	const own = owner(163);
	const fake = fakePi();
	const ctx = {
		isIdle() {
			const current = parseAskRequestRecord(readFileSync(file, "utf8"));
			if (current.notification.state === "pending" && current.notification.claim?.pid === own.pid) {
				// Let a durable ACK win after claim releases its lock, before dispatch takes it.
				writeFileSync(file, JSON.stringify({ ...current, notification: { ...current.notification, state: "acked", claim: null } }), { mode: 0o600 });
			}
			return true;
		},
	};
	registerAskNotifier(fake.pi, notifierOptions(env, own, () => {}));
	t.after(() => fake.emit("session_shutdown", ctx));
	await fake.emit("session_start", ctx);
	assert.equal(fake.messages.length, 0);
	assert.equal((await readRequest(root, acknowledged.request_id)).notification.state, "acked");
	assert.equal((await readRequest(root, acknowledged.request_id)).notification.attempts, 0);
	const next = await terminal(root);
	await fake.emit("agent_end", ctx);
	assert.deepEqual(fake.messages.map(({ message }) => message.details.request_id), [next.request_id]);
	assert.equal((await readRequest(root, next.request_id)).notification.state, "sent");
	assert.equal((await readRequest(root, acknowledged.request_id)).notification.state, "acked");
	await fake.emit("session_shutdown", ctx);
});

function latch() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

test("an idle wake overlapping a scan is retained without continuous polling", { timeout: 2_000 }, async (t) => {
	const { env, root } = await fixture(t);
	const first = await terminal(root);
	await atomicWriteRecord(root, { ...first, notification: { ...first.notification, claim: owner(171) } });
	const entered = latch();
	const release = latch();
	const delivered = latch();
	let sends = 0;
	const fake = fakePi(() => false, () => { if (++sends === 2) delivered.resolve(); });
	const ctx = { isIdle: () => true };
	registerAskNotifier(fake.pi, {
		...notifierOptions(env, owner(172), () => {}),
		readIdentity: async () => { entered.resolve(); await release.promise; return null; },
	});
	t.after(() => fake.emit("session_shutdown", ctx));
	const starting = fake.emit("session_start", ctx);
	await entered.promise;
	const second = await terminal(root); // Not in the in-flight scan's list snapshot; fake watcher is silent.
	await fake.emit("agent_end", ctx);
	release.resolve();
	await starting;
	await delivered.promise;
	await fake.emit("agent_end", ctx);
	// Shutdown must drain the durable write that follows sendMessage, not outlive the fixture.
	await fake.emit("session_shutdown", ctx);
	assert.equal((await readRequest(root, second.request_id)).notification.state, "sent");
	assert.equal(fake.messages.length, 2);
	assert.deepEqual(fake.messages.map(({ message }) => message.details.request_id).sort(), [first.request_id, second.request_id].sort());
});

test("a completed idle scan does not poll the journal without a new wake", { timeout: 2_000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { env, root } = await fixture(t);
	const first = await terminal(root);
	const delivered = latch();
	let sends = 0;
	const fake = fakePi(() => false, () => { if (++sends === 2) delivered.resolve(); });
	let idleChecks = 0;
	const ctx = { isIdle: () => { idleChecks += 1; return true; } };
	let changed = () => {};
	registerAskNotifier(fake.pi, {
		...notifierOptions(env, owner(173), () => {}),
		watch: (_path, listener) => { changed = listener; return { close() {} }; },
	});
	t.after(() => fake.emit("session_shutdown", ctx));
	await fake.emit("session_start", ctx);
	const checksAfterScan = idleChecks;
	const second = await terminal(root);
	t.mock.timers.tick(60_000);
	assert.equal(idleChecks, checksAfterScan, "without pending work even idle checks must stop");
	assert.deepEqual(fake.messages.map(({ message }) => message.details.request_id), [first.request_id]);
	assert.equal((await readRequest(root, second.request_id)).notification.state, "pending");
	changed();
	t.mock.timers.tick(60_000);
	await delivered.promise;
	await fake.emit("session_shutdown", ctx);
	assert.deepEqual(fake.messages.map(({ message }) => message.details.request_id), [first.request_id, second.request_id]);
	assert.equal((await readRequest(root, second.request_id)).notification.state, "sent");
});

test("restart reannounces sent-unacked once and acked result suppresses later sessions", async (t) => {
	const { env, root } = await fixture(t);
	const completed = await terminal(root);
	const beforeNotice = await waitForTerminalRequest(env, completed.request_id, 20, 5);
	assert.ok(beforeNotice);
	const first = fakePi();
	registerAskNotifier(first.pi, notifierOptions(env, owner(201), () => {}));
	await first.emit("session_start", { isIdle: () => true });
	assert.equal(first.messages.length, 1);
	assert.deepEqual(await waitForTerminalRequest(env, completed.request_id, 20, 5), beforeNotice);

	const restarted = fakePi();
	registerAskNotifier(restarted.pi, notifierOptions(env, owner(202), () => {}));
	await restarted.emit("session_start", { isIdle: () => true });
	await restarted.emit("agent_end", { isIdle: () => true });
	assert.equal(restarted.messages.length, 1);

	const harness = createPiToolHarness("/tmp");
	registerMaestriAsyncTools(harness.registrar, { env, platform: "linux" });
	await harness.invoke("maestri_ask_request", { action: "result", request_id: completed.request_id });
	assert.equal((await readRequest(root, completed.request_id)).notification.state, "acked");
	assert.deepEqual(await waitForTerminalRequest(env, completed.request_id, 20, 5), beforeNotice);
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

test("background journal failures are reported without an unhandled rejection and recover on a later event", { timeout: 2_000 }, async (t) => {
	const { env, root } = await fixture(t);
	const fake = fakePi();
	const warned = latch();
	const warnings: string[] = [];
	let idle = false;
	const ctx = {
		isIdle: () => idle,
		hasUI: true,
		ui: { notify(message: string) { warnings.push(message); warned.resolve(); } },
	};
	let changed = () => {};
	registerAskNotifier(fake.pi, {
		...notifierOptions(env, owner(501), () => {}),
		watch: (_path, listener) => { changed = listener; return { close() {} }; },
	});
	t.after(() => fake.emit("session_shutdown", ctx));
	await fake.emit("session_start", ctx);
	const malformed = path.join(root, `${randomUUID()}.json`);
	await writeFile(malformed, '{"private-canary":', { mode: 0o600 });
	idle = true;
	changed();
	await warned.promise;
	assert.equal(fake.messages.length, 0);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /Maestri.*notifications/i);
	assert.doesNotMatch(warnings[0], /private-canary|maestri-ask-notifier-/);
	await fake.emit("agent_end", ctx);
	assert.equal(warnings.length, 1, "repeated failure must not flood the UI");
	await rm(malformed);
	const completed = await terminal(root);
	await fake.emit("agent_end", ctx);
	assert.equal(fake.messages.length, 1);
	assert.equal((await readRequest(root, completed.request_id)).notification.state, "sent");
});

test("send failure stays pending and finite waiter never mutates notification state", async (t) => {
	const { env, root } = await fixture(t);
	const completed = await terminal(root, "cancelled");
	const failing = fakePi(() => true);
	registerAskNotifier(failing.pi, notifierOptions(env, owner(401), () => {}));
	await failing.emit("session_start", { isIdle: () => true });
	const pending = await readRequest(root, completed.request_id);
	assert.equal(pending.notification.state, "pending");
	assert.equal(pending.notification.attempts, 1);
	const before = JSON.stringify(pending.notification);
	const envelope = await waitForTerminalRequest(env, completed.request_id, 10, 2);
	assert.ok(envelope);
	assert.equal(JSON.stringify((await readRequest(root, completed.request_id)).notification), before);
	const restarted = fakePi();
	registerAskNotifier(restarted.pi, notifierOptions(env, owner(402), () => {}));
	await restarted.emit("session_start", { isIdle: () => true });
	assert.equal(restarted.messages.length, 1, "a later session retries the failed notification, never the prompt");
	const retried = await readRequest(root, completed.request_id);
	assert.equal(retried.notification.state, "sent");
	assert.equal(retried.notification.attempts, 2);
	assert.equal(restarted.messages[0].message.content.includes(completed.request_id), true);
	assert.equal(restarted.messages[0].message.content.includes("prompt_digest"), false);
});


test("synchronous send failures retry only after agent_end or restart, never on watcher or busy wakes", { timeout: 2_000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { env, root } = await fixture(t);
	const completed = await terminal(root);
	const delivered = latch();
	let fail = true;
	let busy = false;
	const flaky = fakePi(() => fail, delivered.resolve);
	const ctx = { isIdle: () => !busy };
	let changed = () => {};
	registerAskNotifier(flaky.pi, {
		...notifierOptions(env, owner(402), () => {}),
		watch: (_path, listener) => { changed = listener; return { close() {} }; },
	});
	t.after(() => flaky.emit("session_shutdown", ctx));

	await flaky.emit("session_start", ctx);
	const pending = await readRequest(root, completed.request_id);
	assert.equal(pending.notification.state, "pending");
	assert.equal(pending.notification.attempts, 1);
	assert.equal(pending.notification.claim, null);
	assert.equal(flaky.messages.length, 0);
	changed();
	t.mock.timers.tick(60_000);
	await flaky.emit("session_shutdown", ctx);
	assert.equal((await readRequest(root, completed.request_id)).notification.attempts, 1);
	await flaky.emit("session_start", ctx);
	await flaky.emit("agent_end", ctx);
	assert.equal((await readRequest(root, completed.request_id)).notification.attempts, 3);
	assert.equal(flaky.messages.length, 0);

	fail = false;
	busy = true;
	await flaky.emit("agent_end", ctx);
	for (let continuation = 0; continuation < 5; continuation += 1) t.mock.timers.tick(60_000);
	assert.equal((await readRequest(root, completed.request_id)).notification.attempts, 3);
	assert.equal(flaky.messages.length, 0);
	busy = false;
	t.mock.timers.tick(60_000);
	await delivered.promise;
	await flaky.emit("session_shutdown", ctx);
	const sent = await readRequest(root, completed.request_id);
	assert.equal(sent.notification.state, "sent");
	assert.equal(sent.notification.attempts, 4);
	assert.equal(flaky.messages.length, 1);
});

test("a post-send journal failure does not reannounce after restart", async (t) => {
	const { env, root } = await fixture(t);
	const completed = await terminal(root);
	const unavailable = `${root}-unavailable`;
	const first = fakePi(() => false, () => {
		renameSync(root, unavailable);
		writeFileSync(root, "unavailable");
	});
	const ctx = { isIdle: () => true, hasUI: true, ui: { notify() {} } };
	registerAskNotifier(first.pi, notifierOptions(env, owner(403), () => {}));
	t.after(() => first.emit("session_shutdown", ctx));

	await first.emit("session_start", ctx);
	rmSync(root, { recursive: true, force: true });
	renameSync(unavailable, root);
	assert.equal(first.messages.length, 1);
	assert.equal((await readRequest(root, completed.request_id)).notification.state, "dispatching");
	await first.emit("agent_end", ctx);
	assert.equal(first.messages.length, 1);
	assert.equal((await readRequest(root, completed.request_id)).notification.state, "dispatching");

	const restarted = fakePi();
	registerAskNotifier(restarted.pi, notifierOptions(env, owner(404), () => {}));
	t.after(() => restarted.emit("session_shutdown", ctx));
	await restarted.emit("session_start", ctx);
	assert.equal(restarted.messages.length, 0);
});
