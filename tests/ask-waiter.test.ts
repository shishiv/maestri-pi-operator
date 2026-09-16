import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
	AskRequestNotFoundError,
	AskRequestRefusalError,
	askStateBase,
	atomicWriteRecord,
	clientDigest,
	createAcceptedRequest,
	ensureAskStateRoot,
	locateRequest,
	promptDigest,
	readRequest,
	requestPath,
	transitionTerminal,
	type AskRequestRecord,
} from "../src/ask-store.ts";
import {
	ASK_TERMINAL_ENVELOPE_SCHEMA,
	AskWaiterContextError,
	canonicalJson,
	waitForTerminalRequest,
} from "../src/ask-waiter.ts";
import type { CanonicalJsonObject } from "../src/ask-terminal.ts";

const BIN = new URL("../src/extension-cli.mjs", import.meta.url).pathname;
const PACKAGE_VERSION = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;

async function fixture(t: TestContext) {
	const home = await mkdtemp(path.join(tmpdir(), "maestri-ask-waiter-"));
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

function accepted(root: string, clientRequestId = randomUUID()): AskRequestRecord {
	return {
		schema: 1,
		scope_key: path.basename(root),
		runner_token_digest: promptDigest("runner-token"),
		request_id: randomUUID(),
		client_request_id: clientRequestId,
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

async function store(root: string, record: AskRequestRecord): Promise<void> {
	await createAcceptedRequest(root, record, clientDigest(record.client_request_id));
}

async function runBin(
	args: string[],
	env: Record<string, string | undefined>,
	input: string | Uint8Array = "",
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
		child.stdin.end(input);
	});
}

function terminal(record: AskRequestRecord, reply: "received" | "cancelled" = "received"): AskRequestRecord {
	return transitionTerminal(record, {
		delivery: reply === "received" ? "confirmed" : "unknown",
		reply,
		reason: reply === "received" ? "envelope-received" : "cancelled",
		termination: reply === "received" ? null : "abort",
		exitCode: reply === "received" ? 0 : null,
		rawBytes: 42,
		truncated: reply !== "received",
		completedAt: "2026-09-04T12:00:00.000Z",
	});
}

test("returns a stable bounded terminal envelope without consuming the result", async (t) => {
	const { env, root } = await fixture(t);
	const record = accepted(root);
	await store(root, record);
	const completed = terminal(record);
	await atomicWriteRecord(root, completed);
	const first = await waitForTerminalRequest(env, record.request_id, 20, 5);
	const second = await waitForTerminalRequest(env, record.request_id, 20, 5);
	assert.deepEqual(first, second);
	assert.equal(first?.schema, ASK_TERMINAL_ENVELOPE_SCHEMA);
	assert.equal(first?.state_version, 2);
	assert.equal(first?.output.extracted, true);
	const { digest, ...unsigned } = first!;
	assert.equal(digest, `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}`);
	assert.ok(Buffer.byteLength(canonicalJson(first)) <= 4 * 1024);
	assert.deepEqual(await readRequest(root, record.request_id), completed);
});

test("canonicalizes null-prototype JSON objects with the same sorted order", () => {
	const nullPrototype: CanonicalJsonObject = Object.assign(Object.create(null), {
		zulu: { second: 2, first: 1 },
		alpha: ["x", null],
	});
	assert.equal(canonicalJson(nullPrototype), canonicalJson({
		alpha: ["x", null],
		zulu: { first: 1, second: 2 },
	}));
});

test("sanitizes persisted reasons before canonical digest and keeps the envelope bounded", async (t) => {
	const { env, root } = await fixture(t);
	const record = accepted(root);
	await store(root, record);
	const completed = transitionTerminal(record, {
		delivery: "unknown",
		reply: "unknown",
		reason: `TOKEN=supersecret\r\n\u001b[31m${"x".repeat(130)}😀tail\u202e`,
		termination: "process-error",
		exitCode: 9,
		rawBytes: 42,
		truncated: true,
	});
	await atomicWriteRecord(root, completed);
	const first = await waitForTerminalRequest(env, record.request_id, 20, 5);
	const second = await waitForTerminalRequest(env, record.request_id, 20, 5);
	assert.ok(first);
	assert.equal(first.reason.includes("supersecret"), false);
	assert.equal(first.reason.includes("\u001b"), false);
	assert.equal(first.reason.includes("\u0085"), false);
	assert.equal(first.reason.includes("\u202e"), false);
	assert.equal(first.reason.includes("\n"), true);
	assert.equal(Array.from(first.reason).length <= 160, true);
	const lastCodePoint = first.reason.codePointAt(first.reason.length - 1) ?? 0;
	assert.equal(lastCodePoint >= 0xd800 && lastCodePoint <= 0xdbff, false);
	assert.equal(first.digest, second?.digest);
	assert.ok(Buffer.byteLength(canonicalJson(first)) <= 4 * 1024);
});

test("re-armed and duplicate waiters emit the same terminal event while timeout stays silent", async (t) => {
	const { env, root } = await fixture(t);
	const record = accepted(root);
	await store(root, record);
	assert.equal(await waitForTerminalRequest(env, record.request_id, 20, 5), null);
	const waiters = [
		waitForTerminalRequest(env, record.request_id, 500, 5),
		waitForTerminalRequest(env, record.request_id, 500, 5),
	];
	setTimeout(() => { void atomicWriteRecord(root, terminal(record)); }, 25);
	const [left, right] = await Promise.all(waiters);
	assert.deepEqual(left, right);
	const pending = accepted(root);
	await store(root, pending);
	const plainTimeout = await runBin(["wait", "--request", pending.request_id, "--timeout", "1"], env);
	assert.equal(plainTimeout.code, 0);
	assert.equal(plainTimeout.stdout, "");
	const adapterTimeout = await runBin(["invoke"], env, JSON.stringify({
		schema: "firstmate.extension-request.v1",
		request_id: `sha256:${"4".repeat(64)}`,
		host_protocol: 1,
		extension_id: "org.maestri.pi-operator",
		extension_version: PACKAGE_VERSION,
		package_digest: `sha256:${"5".repeat(64)}`,
		capability: "process-event-adapter",
		capability_version: 1,
		adapter: "maestri-ask",
		operation: "source.poll",
		input: { source_id: "ask-timeout", config_ref: `ask:${pending.request_id}?timeout=1` },
	}));
	assert.deepEqual(JSON.parse(adapterTimeout.stdout).result, { status: "no-result", output: "" });
});

test("plain and adapter modes emit one typed terminal result and no reply body", async (t) => {
	const { env, root } = await fixture(t);
	const record = accepted(root);
	await store(root, record);
	await atomicWriteRecord(root, terminal(record, "cancelled"));
	const plain = await runBin(["wait", "--request", record.request_id, "--timeout", "1"], env);
	assert.equal(plain.code, 0);
	const plainEnvelope = JSON.parse(plain.stdout);
	assert.equal(plainEnvelope.reply, "cancelled");
	assert.equal("content" in plainEnvelope, false);
	assert.equal((await runBin(["wait", "--request", record.request_id, "--timeout", "55", "--timeout", "1"], env)).code, 0);
	assert.equal((await runBin(["wait", "--request", record.request_id, "--timeout", "1", "--timeout", "56"], env)).code, 2);
	const handshakeRequest = {
		schema: "firstmate.extension-handshake-request.v1",
		request_id: `sha256:${"1".repeat(64)}`,
		host_protocols: [1],
		extension_id: "org.maestri.pi-operator",
		extension_version: PACKAGE_VERSION,
		package_digest: `sha256:${"2".repeat(64)}`,
		capability: { name: "process-event-adapter", versions: [1], adapter_names: ["maestri-ask"] },
	};
	const handshake = await runBin(["handshake"], env, JSON.stringify(handshakeRequest));
	assert.equal(handshake.code, 0);
	assert.equal(JSON.parse(handshake.stdout).request_id, handshakeRequest.request_id);
	const invokeRequest = {
		schema: "firstmate.extension-request.v1",
		request_id: `sha256:${"3".repeat(64)}`,
		host_protocol: 1,
		extension_id: "org.maestri.pi-operator",
		extension_version: PACKAGE_VERSION,
		package_digest: `sha256:${"2".repeat(64)}`,
		capability: "process-event-adapter",
		capability_version: 1,
		adapter: "maestri-ask",
		operation: "source.poll",
		input: { source_id: "ask-one", config_ref: `ask:${record.request_id}?timeout=1` },
	};
	const invoked = await runBin(["invoke"], env, JSON.stringify(invokeRequest));
	assert.equal(invoked.code, 0);
	const adapter = JSON.parse(invoked.stdout);
	assert.equal(adapter.request_id, invokeRequest.request_id);
	assert.equal(adapter.result.status, "result");
	assert.deepEqual(JSON.parse(adapter.result.output), plainEnvelope);
	assert.deepEqual(await readRequest(root, record.request_id), terminal(record, "cancelled"));
});

test("refuses invalid, foreign, unscoped, and unsafe request records", async (t) => {
	const { env, root } = await fixture(t);
	const missingContext = { ...env, MAESTRI_WORKSPACE_ID: undefined, MAESTRI_TERMINAL_ID: undefined };
	await assert.rejects(
		waitForTerminalRequest(missingContext, randomUUID(), 1),
		AskWaiterContextError,
	);
	const missingPlain = await runBin(["wait", "--request", randomUUID(), "--timeout", "1"], missingContext);
	assert.equal(missingPlain.code, 2);
	assert.match(missingPlain.stderr, /MAESTRI_WORKSPACE_ID and MAESTRI_TERMINAL_ID/);
	const invalidUtf8 = await runBin(["invoke"], env, Uint8Array.from([0xff]));
	assert.equal(JSON.parse(invalidUtf8.stdout).error.code, "invalid-request");
	const oversized = await runBin(["invoke"], env, Buffer.alloc(65_537, 0x20));
	assert.equal(JSON.parse(oversized.stdout).error.code, "invalid-request");
	const missingId = randomUUID();
	await assert.rejects(locateRequest(env, missingId), AskRequestNotFoundError);
	const missing = await runBin(["wait", "--request", missingId, "--timeout", "1"], env);
	assert.equal(missing.code, 2);
	assert.equal(missing.stdout, "");
	const legacyId = randomUUID();
	await writeFile(path.join(askStateBase(env), `${legacyId}.json`), "{}\n", { mode: 0o600 });
	await assert.rejects(locateRequest(env, legacyId), AskRequestRefusalError);
	assert.equal((await runBin(["wait", "--request", legacyId, "--timeout", "1"], env)).code, 3);
	const foreignId = randomUUID();
	const foreignRoot = path.join(askStateBase(env), "scopes", "foreign");
	await mkdir(path.join(foreignRoot, "by-client"), { recursive: true, mode: 0o700 });
	await writeFile(requestPath(foreignRoot, foreignId), `${JSON.stringify({ ...accepted(foreignRoot), request_id: foreignId })}\n`, { mode: 0o600 });
	await assert.rejects(locateRequest(env, foreignId), AskRequestRefusalError);
	assert.equal((await runBin(["wait", "--request", foreignId, "--timeout", "1"], env)).code, 3);
	const refused = await runBin(["invoke"], env, JSON.stringify({
		schema: "firstmate.extension-request.v1",
		request_id: `sha256:${"6".repeat(64)}`,
		host_protocol: 1,
		extension_id: "org.maestri.pi-operator",
		extension_version: PACKAGE_VERSION,
		package_digest: `sha256:${"7".repeat(64)}`,
		capability: "process-event-adapter",
		capability_version: 1,
		adapter: "maestri-ask",
		operation: "source.poll",
		input: { source_id: "foreign", config_ref: `ask:${foreignId}?timeout=1` },
	}));
	assert.equal(JSON.parse(refused.stdout).error.code, "conflict");
	const missingInvoke = await runBin(["invoke"], missingContext, JSON.stringify({
		schema: "firstmate.extension-request.v1",
		request_id: `sha256:${"8".repeat(64)}`,
		host_protocol: 1,
		extension_id: "org.maestri.pi-operator",
		extension_version: PACKAGE_VERSION,
		package_digest: `sha256:${"9".repeat(64)}`,
		capability: "process-event-adapter",
		capability_version: 1,
		adapter: "maestri-ask",
		operation: "source.poll",
		input: { source_id: "missing-context", config_ref: `ask:${foreignId}?timeout=1` },
	}));
	const missingResponse = JSON.parse(missingInvoke.stdout);
	assert.equal(missingResponse.error.code, "missing-context");
	assert.equal(missingResponse.error.retryable, false);
	const unsafe = accepted(root);
	await store(root, unsafe);
	await import("node:fs/promises").then((fs) => fs.chmod(requestPath(root, unsafe.request_id), 0o644));
	await assert.rejects(locateRequest(env, unsafe.request_id), AskRequestRefusalError);
	assert.equal((await stat(requestPath(root, unsafe.request_id))).mode & 0o777, 0o644);
});
