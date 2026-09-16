import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, appendFile, chmod, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import {
	ASK_TERMINAL_RETENTION_COUNT,
	ASK_TERMINAL_RETENTION_MS,
	AskRequestNotFoundError,
	AskRequestRefusalError,
	LegacyLockProtocolError,
	askStateBase,
	atomicWriteRecord,
	clientDigest,
	clientPath,
	createAcceptedRequest,
	createOutput,
	ensureAskStateRoot,
	listRequests,
	locateRequest,
	outputPath,
	promptDigest,
	pruneTerminalRequests,
	readClientRequest,
	readRequest,
	requestPath,
	transactRequest,
	transitionCancelling,
	transitionOrphan,
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

function terminal(record: AskRequestRecord, completedAt = new Date().toISOString()): AskRequestRecord {
	return transitionTerminal(record, {
		delivery: "confirmed",
		reply: "received",
		reason: "completed",
		termination: null,
		exitCode: 0,
		rawBytes: 7,
		truncated: false,
		completedAt,
	});
}

async function store(root: string, record: AskRequestRecord): Promise<void> {
	await createAcceptedRequest(root, record, clientDigest(record.client_request_id));
}

async function missing(file: string): Promise<boolean> {
	try {
		await access(file);
		return false;
	} catch {
		return true;
	}
}

test("allows only reachable transitions with monotonic versions", () => {
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
	assert.equal(cancelling.cleanup_deadline_ms, 1234);
	assert.equal(cancelling.state_version, 3);
	assert.ok(cancelling.cancel_requested_at);
	for (const [record, delivery, reply] of [
		[base, "not-attempted", "none"],
		[base, "not-attempted", "cancelled"],
		[running, "unknown", "unknown"],
		[running, "unknown", "cancelled"],
		[running, "confirmed", "received"],
		[running, "confirmed", "unknown"],
	] as const) {
		const completed = transitionTerminal(record, {
			delivery,
			reply,
			reason: "test",
			termination: null,
			exitCode: 0,
			rawBytes: 0,
			truncated: false,
		});
		assert.deepEqual([completed.phase, completed.delivery, completed.reply], ["terminal", delivery, reply]);
		assert.equal(completed.state_version, record.state_version + 1);
		assert.throws(() => transitionTerminal(completed, {
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

test("claims one client key and validates transactional version changes", async (t) => {
	const { root } = await fixture(t);
	const key = clientDigest("same-client-key");
	const left = accepted("same-client-key", undefined, path.basename(root));
	const right = { ...accepted("same-client-key", undefined, path.basename(root)), prompt_digest: left.prompt_digest };
	const results = await Promise.all([createAcceptedRequest(root, left, key), createAcceptedRequest(root, right, key)]);
	assert.equal(results.filter((result) => result.created).length, 1);
	assert.equal(results[0].record.request_id, results[1].record.request_id);
	assert.equal((await listRequests(root)).length, 1);
	assert.doesNotMatch(await readFile(requestPath(root, results[0].record.request_id), "utf8"), /one prompt/);
	assert.equal((await stat(root)).mode & 0o777, 0o700);
	assert.equal((await stat(requestPath(root, results[0].record.request_id))).mode & 0o777, 0o600);
	await Promise.all(Array.from({ length: 8 }, () => transactRequest(root, results[0].record.request_id, (current) => ({
		...current,
		state_version: current.state_version + 1,
	}))));
	assert.equal((await readRequest(root, results[0].record.request_id)).state_version, 9);
	await assert.rejects(transactRequest(root, results[0].record.request_id, (current) => ({ ...current })), /increment state_version/);
	await assert.rejects(transactRequest(root, results[0].record.request_id, (current) => ({
		...current,
		request_id: randomUUID(),
		state_version: current.state_version + 1,
	})), /immutable receipt header/);
	const completed = terminal(await readRequest(root, results[0].record.request_id));
	const staleDigest = `sha256:${"1".repeat(64)}`;
	await atomicWriteRecord(root, { ...completed, notification: { ...completed.notification, digest: staleDigest } });
	const claimed = await transactRequest(root, completed.request_id, (current) => ({
		...current,
		notification: {
			...current.notification,
			digest: completed.notification.digest,
			claim: { pid: process.pid, identity: { start_time: "1", cmdline_hex: "aa" } },
		},
	}));
	assert.equal(claimed.state_version, completed.state_version);
	assert.equal(claimed.notification.digest, completed.notification.digest);
	const receipt = requestPath(root, completed.request_id);
	const beforeNoop = await stat(receipt);
	const skipped = await transactRequest(root, completed.request_id, () => null);
	assert.equal(skipped, null);
	assert.equal((await stat(receipt)).ino, beforeNoop.ino);
	await assert.rejects(transactRequest(root, completed.request_id, (current) => {
		current.output.raw_bytes += 1;
		return current;
	}), /Terminal async request facts are immutable/);
	assert.equal((await readRequest(root, completed.request_id)).output.raw_bytes, completed.output.raw_bytes);
	await assert.rejects(transactRequest(root, completed.request_id, (current) => {
		current.notification.digest = `sha256:${"2".repeat(64)}`;
		return current;
	}), /Terminal async request facts are immutable/);
	await assert.rejects(transactRequest(root, completed.request_id, (current) => ({
		...current,
		terminal: { ...current.terminal!, reason: "rewritten" },
		state_version: current.state_version + 1,
	})), /Terminal async request facts are immutable/);
});

const LOCK_WORKER = `
	import { appendFile } from "node:fs/promises";
	import { setTimeout as sleep } from "node:timers/promises";
	import { withFileLock } from ${JSON.stringify(pathToFileURL(path.resolve("src/ask-store.ts")).href)};
	await withFileLock(process.env.LOCK_FILE, async () => {
		await appendFile(process.env.EVENTS_FILE, "enter " + process.pid + "\\n");
		if (process.env.CRASH_HOLDER === "1") {
			process.stdout.write("locked\\n");
			await new Promise(() => {});
		}
		await sleep(15);
		await appendFile(process.env.EVENTS_FILE, "exit " + process.pid + "\\n");
	}, 15_000);
`;

function lockWorker(file: string, events: string, crash = false): ChildProcess {
	return spawn(process.execPath, ["--input-type=module", "--eval", LOCK_WORKER], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, LOCK_FILE: file, EVENTS_FILE: events, CRASH_HOLDER: crash ? "1" : "0" },
	});
}

async function childExit(child: ChildProcess): Promise<void> {
	const [code, signal] = await once(child, "exit");
	assert.equal(signal, null);
	assert.equal(code, 0);
}

test("recovers a crashed owner and serializes 32 processes without deleting a successor", async (t) => {
	const { root } = await fixture(t);
	const file = path.join(root, "multiprocess.lock");
	const events = path.join(root, "lock-events");
	const holder = lockWorker(file, events, true);
	await once(holder.stdout!, "data");
	const holderExit = once(holder, "exit");
	holder.kill("SIGKILL");
	await holderExit;
	const workers = Array.from({ length: 32 }, () => lockWorker(file, events));
	await Promise.all(workers.map(childExit));
	const lines = (await readFile(events, "utf8")).trim().split("\n").slice(1);
	let active = 0;
	let maximum = 0;
	for (const line of lines) {
		active += line.startsWith("enter ") ? 1 : -1;
		maximum = Math.max(maximum, active);
		assert.ok(active >= 0);
	}
	assert.equal(lines.length, 64);
	assert.equal(maximum, 1);
	assert.equal(active, 0);
	assert.equal((await stat(path.join(root, ".receipt-locks.sqlite"))).mode & 0o777, 0o600);
	let release = () => {};
	const held = new Promise<void>((resolve) => { release = resolve; });
	let entered = () => {};
	const acquired = new Promise<void>((resolve) => { entered = resolve; });
	const owner = withFileLock(file, async () => { entered(); await held; });
	await acquired;
	await assert.rejects(withFileLock(file, async () => undefined, 40), /Timed out waiting/);
	release();
	await owner;
});

test("isolates lock resources while serializing the same resource", async (t) => {
	const { root } = await fixture(t);
	let release = () => {};
	const held = new Promise<void>((resolve) => { release = resolve; });
	let entered = () => {};
	const acquired = new Promise<void>((resolve) => { entered = resolve; });
	const first = withFileLock(path.join(root, "first.lock"), async () => { entered(); await held; });
	await acquired;
	let secondEntered = false;
	await withFileLock(path.join(root, "second.lock"), async () => { secondEntered = true; });
	assert.equal(secondEntered, true);
	release();
	await first;
	await assert.rejects(withFileLock(path.join(root, "failure.lock"), () => {
		throw new Error("operation failure is preserved");
	}), /operation failure is preserved/);
	await withFileLock(path.join(root, "failure.lock"), async () => undefined);
});

test("refuses live, stale, and uncertain legacy lock markers without changing them", async (t) => {
	const { root } = await fixture(t);
	for (const [name, marker] of [
		["live", { pid: process.pid, identity: { start_time: "live", cmdline_hex: "aa" }, token: "live-token" }],
		["stale", { pid: 2_147_483_647, identity: { start_time: "stale", cmdline_hex: "bb" }, token: "stale-token" }],
		["uncertain", { malformed: true }],
	] as const) {
		const file = path.join(root, `${name}.lock`);
		const contents = `${JSON.stringify(marker)}\n`;
		await writeFile(file, contents, { mode: 0o600 });
		const before = await stat(file);
		let entered = false;
		await assert.rejects(withFileLock(file, async () => {
			entered = true;
		}), LegacyLockProtocolError);
		assert.equal(entered, false);
		assert.equal(await readFile(file, "utf8"), contents);
		assert.equal((await stat(file)).ino, before.ino);
	}
	assert.equal(await missing(path.join(root, ".receipt-locks.sqlite")), true);
});

test("migrates legacy lock ownership without retaining command-line payload", async (t) => {
	const { root } = await fixture(t);
	const databaseFile = path.join(root, ".receipt-locks.sqlite");
	const legacy = new DatabaseSync(databaseFile);
	legacy.exec(`
		CREATE TABLE receipt_locks (
			resource TEXT PRIMARY KEY,
			pid INTEGER NOT NULL,
			start_time TEXT NOT NULL,
			cmdline_hex TEXT NOT NULL,
			token TEXT NOT NULL
		) STRICT
	`);
	const payload = Buffer.from(`--prompt=${"private-prompt-token-".repeat(16)}`, "utf8").toString("hex");
	legacy.prepare("INSERT INTO receipt_locks(resource, pid, start_time, cmdline_hex, token) VALUES (?, ?, ?, ?, ?)")
		.run("legacy.lock", 2_147_483_647, "1", payload, randomUUID());
	legacy.close();
	await chmod(databaseFile, 0o600);
	const events = path.join(root, "migration-events");
	const workers = Array.from({ length: 8 }, () => lockWorker(path.join(root, "legacy.lock"), events));
	await Promise.all(workers.map(childExit));
	const lines = (await readFile(events, "utf8")).trim().split("\n");
	let active = 0;
	for (const line of lines) {
		active += line.startsWith("enter ") ? 1 : -1;
		assert.ok(active === 0 || active === 1);
	}
	assert.equal(lines.length, 16);
	assert.equal(active, 0);
	assert.doesNotMatch((await readFile(databaseFile)).toString("latin1"), new RegExp(payload));
});

test("rejects an altered lock table before entering the protected operation", async (t) => {
	const { root } = await fixture(t);
	const databaseFile = path.join(root, ".receipt-locks.sqlite");
	const altered = new DatabaseSync(databaseFile);
	altered.exec(`
		CREATE TABLE receipt_locks (
			resource TEXT NOT NULL,
			pid INTEGER NOT NULL,
			start_time TEXT NOT NULL,
			cmdline_digest TEXT NOT NULL,
			token TEXT NOT NULL
		) STRICT
	`);
	altered.close();
	await chmod(databaseFile, 0o600);
	let entered = false;
	await assert.rejects(withFileLock(path.join(root, "altered.lock"), async () => {
		entered = true;
	}), /Unsupported async request lock table schema/);
	assert.equal(entered, false);
});

test("strictly parses current records and explicitly normalizes the legacy schema", async (t) => {
	const { root } = await fixture(t);
	const record = accepted("strict", undefined, path.basename(root));
	await store(root, record);
	const {
		custody: _custody,
		cleanup_deadline_ms: _cleanup,
		notification: _notification,
		...legacy
	} = record;
	await writeFile(requestPath(root, record.request_id), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
	const normalized = await readRequest(root, record.request_id);
	assert.equal(normalized.custody, "none");
	assert.equal(normalized.cleanup_deadline_ms, null);
	assert.equal(normalized.notification.state, "none");
	const provisional = {
		...record,
		runner: { pid: process.pid, pgid: process.pid, identity: { start_time: "1", cmdline_hex: "aa" } },
	};
	await atomicWriteRecord(root, provisional);
	assert.deepEqual((await readRequest(root, record.request_id)).runner, provisional.runner);
	const orphan = transitionOrphan(provisional, "runner-handshake-missing");
	await atomicWriteRecord(root, orphan);
	assert.equal((await readRequest(root, record.request_id)).custody, "orphan");
	const running = transitionRunning(record, {
		pid: process.pid,
		pgid: process.pid,
		identity: { start_time: "1", cmdline_hex: "aa" },
	}, "runner-token");
	const { custody, cleanup_deadline_ms, notification, ...legacyRunning } = running;
	await writeFile(requestPath(root, record.request_id), `${JSON.stringify({
		...legacyRunning,
		runner: { ...legacyRunning.runner, started_at: new Date().toISOString() },
	})}\n`, { mode: 0o600 });
	const normalizedRunning = await readRequest(root, record.request_id);
	assert.equal(normalizedRunning.custody, "held");
	assert.deepEqual(normalizedRunning.runner, running.runner);
	assert.notEqual(custody, undefined);
	assert.equal(cleanup_deadline_ms, null);
	assert.equal(notification.state, "none");
	const invalid = [
		{ ...record, extra: true },
		{ ...record, state_version: 1.5 },
		{ ...record, created_at: "not-a-date" },
		{ ...record, phase: "terminal" },
		{ ...record, notification: { ...record.notification, attempts: -1 } },
	];
	for (const value of invalid) {
		await writeFile(requestPath(root, record.request_id), `${JSON.stringify(value)}\n`, { mode: 0o600 });
		await assert.rejects(readRequest(root, record.request_id), /Invalid|terminal|timestamp/);
	}
	await writeFile(requestPath(root, record.request_id), "{truncated", { mode: 0o600 });
	await assert.rejects(readRequest(root, record.request_id), /Corrupt/);
	await assert.rejects(atomicWriteRecord(root, { ...record, prompt_bytes: -1 }), /Invalid/);
	await writeFile(clientPath(root, clientDigest("wrong-index")), `${JSON.stringify(record)}\n`, { mode: 0o600 });
	await assert.rejects(readClientRequest(root, clientDigest("wrong-index")), /index identity mismatch/);
});

test("locates only the required workspace and terminal scope", async (t) => {
	const { env, home, root } = await fixture(t);
	const local = accepted("local", undefined, path.basename(root));
	await store(root, local);
	assert.equal((await locateRequest(env, local.request_id)).root, root);
	const foreignEnv = { ...env, MAESTRI_WORKSPACE_ID: "foreign-workspace", MAESTRI_TERMINAL_ID: "foreign-terminal" };
	const foreignRoot = await ensureAskStateRoot(foreignEnv);
	const foreign = accepted("foreign", undefined, path.basename(foreignRoot));
	await store(foreignRoot, foreign);
	await assert.rejects(locateRequest(env, foreign.request_id), AskRequestRefusalError);
	await assert.rejects(locateRequest(env, randomUUID()), AskRequestNotFoundError);
	await assert.rejects(locateRequest({ HOME: home }, local.request_id), AskRequestRefusalError);
	await assert.rejects(locateRequest(env, "not-a-uuid"), AskRequestRefusalError);
	const legacyId = randomUUID();
	await writeFile(path.join(askStateBase(env), `${legacyId}.json`), "{}\n", { mode: 0o600 });
	await assert.rejects(locateRequest(env, legacyId), AskRequestRefusalError);
	const scopes = path.join(askStateBase(env), "scopes");
	await chmod(scopes, 0o755);
	await assert.rejects(locateRequest(env, local.request_id), AskRequestRefusalError);
	await chmod(scopes, 0o700);
	const realScopes = `${scopes}.real`;
	await rename(scopes, realScopes);
	await symlink(realScopes, scopes);
	await assert.rejects(locateRequest(env, local.request_id), AskRequestRefusalError);
	await rm(scopes);
	await rename(realScopes, scopes);
	await chmod(requestPath(root, local.request_id), 0o644);
	await assert.rejects(locateRequest(env, local.request_id), AskRequestRefusalError);
});

test("opportunistic retention applies age and quantity and recovers a staged crash", async (t) => {
	const { root } = await fixture(t);
	const now = Date.now();
	const active = accepted("active", new Date(now - 30 * 24 * 60 * 60_000).toISOString(), path.basename(root));
	await store(root, active);
	const old = accepted("old", undefined, path.basename(root));
	await store(root, old);
	await createOutput(root, old.request_id);
	await appendFile(outputPath(root, old.request_id), "output");
	await atomicWriteRecord(root, terminal(old, new Date(now - ASK_TERMINAL_RETENTION_MS - 1).toISOString()));
	const records: AskRequestRecord[] = [];
	for (let index = 0; index < ASK_TERMINAL_RETENTION_COUNT + 1; index += 1) {
		const record = accepted(`terminal-${index}`, undefined, path.basename(root));
		await store(root, record);
		const completed = terminal(record, new Date(now - index).toISOString());
		await atomicWriteRecord(root, completed);
		records.push(completed);
	}
	await pruneTerminalRequests(root, now);
	const retained = await listRequests(root);
	assert.equal(retained.filter((record) => record.phase === "terminal").length, ASK_TERMINAL_RETENTION_COUNT);
	assert.ok(retained.some((record) => record.request_id === active.request_id));
	assert.equal(await missing(outputPath(root, old.request_id)), true);
	assert.equal(await readClientRequest(root, clientDigest(old.client_request_id)), null);
	const pruned = records.at(-1)!;
	assert.equal(await readClientRequest(root, clientDigest(pruned.client_request_id)), null);
	const crashed = terminal(accepted("crashed-prune", undefined, path.basename(root)), new Date(0).toISOString());
	await store(root, { ...crashed, phase: "accepted", delivery: "not-attempted", reply: "none", custody: "none", terminal: undefined, notification: { state: "none", digest: null, sent_at: null, attempts: 0, claim: null }, state_version: 1 });
	await atomicWriteRecord(root, crashed);
	await createOutput(root, crashed.request_id);
	await rename(requestPath(root, crashed.request_id), path.join(root, `${crashed.request_id}.prune`));
	await pruneTerminalRequests(root, now);
	assert.equal(await missing(path.join(root, `${crashed.request_id}.prune`)), true);
	assert.equal(await missing(outputPath(root, crashed.request_id)), true);
	assert.equal(await readClientRequest(root, clientDigest(crashed.client_request_id)), null);
});
