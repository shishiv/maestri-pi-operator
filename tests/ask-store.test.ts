import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
	ASK_TERMINAL_RETENTION_COUNT,
	atomicWriteRecord,
	clientDigest,
	createAcceptedRequest,
	ensureAskStateRoot,
	listRequests,
	promptDigest,
	pruneTerminalRequests,
	readClientRequest,
	requestPath,
	transitionCancelling,
	transitionRunning,
	transitionTerminal,
	type AskRequestRecord,
	withFileLock,
} from "../src/ask-store.ts";

async function fixture(t: TestContext) {
	const home = await mkdtemp(path.join(tmpdir(), "maestri-ask-store-"));
	const env = {
		HOME: home,
		XDG_STATE_HOME: path.join(home, "state"),
		MAESTRI_WORKSPACE_ID: "workspace",
		MAESTRI_TERMINAL_ID: "terminal",
	};
	const root = await ensureAskStateRoot(env);
	t.after(async () => rm(home, { recursive: true, force: true }));
	return { env, home, root };
}

function accepted(
	clientRequestId: string = randomUUID(),
	createdAt = new Date().toISOString(),
	scopeKey = "scope",
): AskRequestRecord {
	return {
		schema: 1,
		scope_key: scopeKey,
		runner_token_digest: promptDigest("runner-token"),
		request_id: randomUUID(),
		client_request_id: clientRequestId,
		agent: "Farol",
		prompt_digest: promptDigest("one prompt"),
		prompt_bytes: 10,
		created_at: createdAt,
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

test("allows only the reachable running and terminal state pairs with monotonic versions", () => {
	const base = accepted();
	const running = transitionRunning(base, {
		pid: 10,
		pgid: 10,
		identity: { start_time: "20", cmdline_hex: "abcd" },
	}, "runner-token");
	assert.throws(() => transitionRunning(base, running.runner!, "wrong-token"), /Runner token/);
	assert.deepEqual([running.phase, running.delivery, running.reply, running.state_version], ["running", "unknown", "pending", 2]);
	const cancelling = transitionCancelling(running, 1234);
	assert.equal(cancelling.phase, "running");
	assert.equal(cancelling.reply, "pending");
	assert.equal(cancelling.state_version, 3);
	assert.equal(cancelling.cleanup_deadline_ms, 1234);
	assert.ok(cancelling.cancel_requested_at);
	const pairs = [
		[base, "not-attempted", "none"],
		[base, "not-attempted", "cancelled"],
		[running, "unknown", "unknown"],
		[running, "unknown", "cancelled"],
		[running, "confirmed", "received"],
		[running, "confirmed", "unknown"],
	] as const;
	for (const [record, delivery, reply] of pairs) {
		const terminal = transitionTerminal(record, {
			delivery,
			reply,
			reason: "test",
			termination: null,
			exitCode: 0,
			rawBytes: 0,
			truncated: false,
		});
		assert.deepEqual([terminal.phase, terminal.delivery, terminal.reply], ["terminal", delivery, reply]);
		assert.equal(terminal.state_version, record.state_version + 1);
		assert.throws(() => transitionTerminal(terminal, {
			delivery,
			reply,
			reason: "again",
			termination: null,
			exitCode: 0,
			rawBytes: 0,
			truncated: false,
		}), /cannot transition again/);
	}
	assert.throws(() => transitionTerminal(base, {
		delivery: "confirmed",
		reply: "cancelled",
		reason: "invalid",
		termination: null,
		exitCode: 0,
		rawBytes: 0,
		truncated: false,
	}), /Invalid terminal/);
});

test("atomically claims one client key and never exposes a partially-written lock", async (t) => {
	const { root } = await fixture(t);
	const key = clientDigest("same-client-key");
	const left = accepted("same-client-key", undefined, path.basename(root));
	const right = { ...accepted("same-client-key", undefined, path.basename(root)), prompt_digest: left.prompt_digest };
	const results = await Promise.all([
		createAcceptedRequest(root, left, key),
		createAcceptedRequest(root, right, key),
	]);
	assert.equal(results.filter((result) => result.created).length, 1);
	assert.equal(results[0].record.request_id, results[1].record.request_id);
	assert.equal((await listRequests(root)).length, 1);
	assert.doesNotMatch(await readFile(requestPath(root, results[0].record.request_id), "utf8"), /one prompt/);
	assert.equal((await stat(root)).mode & 0o777, 0o700);
	assert.equal((await stat(requestPath(root, results[0].record.request_id))).mode & 0o777, 0o600);
	const partial = path.join(root, "partial.lock");
	await writeFile(partial, "", { mode: 0o600 });
	await assert.rejects(withFileLock(partial, async () => undefined, 75), /Timed out waiting/);
	assert.equal((await stat(partial)).size, 0);
});

test("prunes only terminal records and bounds exactly-once replay to the retention window", async (t) => {
	const { root } = await fixture(t);
	const now = Date.now();
	const active = accepted("active", new Date(now - 30 * 24 * 60 * 60_000).toISOString(), path.basename(root));
	await createAcceptedRequest(root, active, clientDigest(active.client_request_id));
	const records: AskRequestRecord[] = [];
	for (let index = 0; index < ASK_TERMINAL_RETENTION_COUNT + 1; index += 1) {
		const record = accepted(`terminal-${index}`, new Date(now - index).toISOString(), path.basename(root));
		await createAcceptedRequest(root, record, clientDigest(record.client_request_id));
		const terminal = transitionTerminal(record, {
			delivery: "confirmed",
			reply: "received",
			reason: "completed",
			termination: null,
			exitCode: 0,
			rawBytes: 0,
			truncated: false,
			completedAt: new Date(now - index).toISOString(),
		});
		await atomicWriteRecord(root, terminal);
		records.push(terminal);
	}
	await pruneTerminalRequests(root, now);
	const retained = await listRequests(root);
	assert.equal(retained.filter((record) => record.phase === "terminal").length, ASK_TERMINAL_RETENTION_COUNT);
	assert.ok(retained.some((record) => record.request_id === active.request_id));
	const pruned = records.at(-1)!;
	assert.equal(await readClientRequest(root, clientDigest(pruned.client_request_id)), null);
	const replacement = accepted(pruned.client_request_id, undefined, path.basename(root));
	assert.equal((await createAcceptedRequest(root, replacement, clientDigest(replacement.client_request_id))).created, true);
});
