import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	askScopeKey,
	assertRequestInScope,
	atomicWriteRecord,
	clientDigest,
	createAcceptedRequest,
	createOutput,
	discardOutput,
	ensureAskStateRoot,
	listRequests,
	lockPath,
	outputPath,
	outputSize,
	promptDigest,
	pruneTerminalRequests,
	readClientRequest,
	readOutput,
	readProcessIdentity,
	readRequest,
	requestState,
	sameIdentity,
	transitionCancelling,
	transitionOrphan,
	transitionTerminal,
	type AskRequestRecord,
	type AskRequestState,
	withFileLock,
	withRequestLock,
} from "./ask-store.ts";
import {
	MAESTRI_RAW_OUTPUT_MAX_BYTES,
	assertAgent,
	assertConnected,
	assertPrompt,
	formatMaestriOutput,
	maestriCliEnvironment,
	resolveMaestriCli,
	runBoundedProcess,
	type Environment,
	type MaestriExec,
	type MaestriRuntimeOptions,
} from "./maestri.ts";
import { classifyPiReadiness } from "./readiness.ts";
import { envelopedPrompt, extractReplyEnvelope } from "./reply-envelope.ts";
import { terminalEnvelope } from "./ask-terminal.ts";
import { assertAskPrompt, MAX_PROMPT_BYTES } from "./cli-text.ts";
import { redactSensitiveText } from "./output.ts";

export const MAESTRI_ASYNC_PREFLIGHT_TIMEOUT_MS = 10_000;
export const MAESTRI_ASYNC_HANDSHAKE_TIMEOUT_MS = 2_000;
export const MAESTRI_ASYNC_KILL_GRACE_MS = 5_000;
const MAX_CLIENT_REQUEST_ID_BYTES = 256;
const ASYNC_STALE_ACCEPTED_MS = 15_000;
const RUNNER_PATH = fileURLToPath(new URL("./ask-runner.mjs", import.meta.url));

type Platform = NodeJS.Platform;

interface AsyncToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

export interface MaestriAsyncRuntimeOptions extends MaestriRuntimeOptions {
	asyncAskTimeoutMs?: number;
	asyncHandshakeTimeoutMs?: number;
	asyncKillGraceMs?: number;
	asyncPreflightTimeoutMs?: number;
	asyncRunnerPath?: string;
	asyncReadProcessIdentity?: typeof readProcessIdentity;
	asyncCancelProcessGroup?: (
		runner: NonNullable<AskRequestRecord["runner"]>,
		killGraceMs: number,
	) => Promise<boolean>;
}

function errno(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException).code === code;
}

function assertClientRequestId(value: string): void {
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes < 1 || bytes > MAX_CLIENT_REQUEST_ID_BYTES || value.includes("\0")) {
		throw new Error(`client_request_id must contain 1-${MAX_CLIENT_REQUEST_ID_BYTES} UTF-8 bytes and no NUL`);
	}
}

function assertRequestId(value: string): void {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
		throw new Error("request_id must be a UUID v4");
	}
}

export function assertReadyPiScreen(screen: string): void {
	const now = Date.now();
	const readiness = classifyPiReadiness({
		terminal_type: "pi",
		screen,
		truncated: false,
		encoding_valid: true,
		captured_at_ms: now,
		now_ms: now,
		max_age_ms: 0,
	});
	if (readiness.verdict === "busy") {
		throw new Error("The target Pi is busy; no async request was launched");
	}
	if (readiness.verdict !== "ready") {
		throw new Error("The target is missing, ambiguous, or not a ready Pi; no async request was launched");
	}
}

export async function resolveNodeExecutable(env: Environment): Promise<string> {
	for (const directory of (env.PATH ?? "").split(path.delimiter)) {
		if (!directory) continue;
		try {
			const executable = await realpath(path.resolve(directory, "node"));
			if (!(await stat(executable)).isFile()) continue;
			await access(executable, fsConstants.X_OK);
			return executable;
		} catch {}
	}
	throw new Error("Node.js is unavailable on PATH for the asynchronous Maestri runner");
}

function terminalRecord(
	record: AskRequestRecord,
	delivery: AskRequestRecord["delivery"],
	reply: AskRequestRecord["reply"],
	reason: string,
	termination: NonNullable<AskRequestRecord["terminal"]>["termination"],
	exitCode: number | null,
	rawBytes: number,
	truncated: boolean,
): AskRequestRecord {
	return transitionTerminal(record, {
		delivery,
		reply,
		reason,
		termination,
		exitCode,
		rawBytes,
		truncated,
	});
}

async function preflightReady(
	execute: MaestriExec,
	command: string,
	agent: string,
	cwd: string,
	env: Environment,
	platform: Platform,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<void> {
	const result = await execute(command, ["check", agent], {
		cwd,
		env: maestriCliEnvironment(env),
		platform,
		signal,
		timeoutMs,
		maxOutputBytes: MAESTRI_RAW_OUTPUT_MAX_BYTES,
	});
	if (result.killed || result.code !== 0) {
		throw new Error("Maestri readiness check failed; no async request was launched");
	}
	assertReadyPiScreen(result.stdout);
}

async function reconcileRequest(
	root: string,
	requestId: string,
	readIdentity: typeof readProcessIdentity,
): Promise<AskRequestRecord> {
	return withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase === "terminal") return record;
		if (record.custody === "orphan") {
			if (!record.runner || processGroupStatus(record.runner.pgid) !== "gone") return record;
			const terminal = terminalRecord(record, "unknown", "unknown", "orphan-process-group-gone", "process-error", null, record.output.raw_bytes, true);
			await discardOutput(root, requestId);
			await atomicWriteRecord(root, terminal);
			return terminal;
		}
		if (record.phase === "accepted") {
			if (Date.now() - Date.parse(record.created_at) <= ASYNC_STALE_ACCEPTED_MS) return record;
			if (record.runner) {
				let identity: Awaited<ReturnType<typeof readProcessIdentity>>;
				try {
					identity = await readIdentity(record.runner.pid);
				} catch {
					identity = null;
				}
				if (processGroupStatus(record.runner.pgid) !== "gone") {
					const orphan = transitionOrphan(record, identity && sameIdentity(identity.identity, record.runner.identity)
						? "runner-handshake-missing"
						: "runner-handshake-identity-uncertain");
					await atomicWriteRecord(root, orphan);
					return orphan;
				}
			}
			const terminal = terminalRecord(record, "unknown", "unknown", "launch-unknown", "launch-unknown", null, 0, true);
			await discardOutput(root, requestId);
			await atomicWriteRecord(root, terminal);
			return terminal;
		}
		if (!record.runner) throw new Error("Running async request has no process identity");
		let current: Awaited<ReturnType<typeof readProcessIdentity>>;
		let uncertain = false;
		try {
			current = await readIdentity(record.runner.pid);
		} catch {
			current = null;
			uncertain = true;
		}
		if (current && current.pgid === record.runner.pgid && sameIdentity(current.identity, record.runner.identity)) {
			return record;
		}
		if (processGroupStatus(record.runner.pgid) !== "gone") {
			const orphan = transitionOrphan(record, uncertain
				? "process-identity-uncertain"
				: current ? "process-identity-mismatch" : "runner-missing-group-present");
			await atomicWriteRecord(root, orphan);
			return orphan;
		}
		const rawBytes = await outputSize(root, requestId);
		await discardOutput(root, requestId);
		const reason = uncertain
			? "process-identity-uncertain-group-gone"
			: current ? "process-identity-mismatch-group-gone" : "runner-exited-without-result";
		const terminal = terminalRecord(record, "unknown", "unknown", reason, "process-error", null, rawBytes, true);
		await atomicWriteRecord(root, terminal);
		return terminal;
	});
}

async function mappedRequest(root: string, digest: string): Promise<AskRequestRecord | null> {
	const indexed = await readClientRequest(root, digest);
	if (!indexed) return null;
	try {
		return await readRequest(root, indexed.request_id);
	} catch (error) {
		if (!errno(error, "ENOENT")) throw error;
		const recovered = terminalRecord(
			indexed,
			"not-attempted",
			"none",
			"record-commit-interrupted",
			"launch-unknown",
			null,
			0,
			true,
		);
		await atomicWriteRecord(root, recovered);
		return recovered;
	}
}

async function markLaunchFailure(root: string, requestId: string, reason: string): Promise<AskRequestRecord> {
	return withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase !== "accepted") return record;
		const terminal = terminalRecord(record, "not-attempted", "none", reason, "launch-unknown", null, 0, true);
		await discardOutput(root, requestId);
		await atomicWriteRecord(root, terminal);
		return terminal;
	});
}

async function cancelAccepted(root: string, requestId: string): Promise<AskRequestRecord> {
	return withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase !== "accepted" || record.custody === "orphan") return record;
		const terminal = terminalRecord(record, "not-attempted", "cancelled", "cancelled-before-spawn", "abort", null, 0, true);
		await discardOutput(root, requestId);
		await atomicWriteRecord(root, terminal);
		return terminal;
	});
}

async function cancelDuringHandshake(
	root: string,
	requestId: string,
	childPid: number | undefined,
	killGraceMs: number,
	readIdentity: typeof readProcessIdentity,
	cancelProcessGroup: NonNullable<MaestriAsyncRuntimeOptions["asyncCancelProcessGroup"]>,
): Promise<AskRequestRecord> {
	let observed: NonNullable<AskRequestRecord["runner"]> | undefined;
	let running = false;
	let uncertain = false;
	const prepared = await withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase === "terminal") return record;
		if (record.phase === "running") {
			running = true;
			return record;
		}
		if (childPid) {
			try {
				const identity = await readIdentity(childPid);
				if (identity && identity.pgid === childPid) {
					observed = {
						pid: childPid,
						pgid: identity.pgid,
						identity: identity.identity,
					};
				}
				if (!identity || identity.pgid !== childPid) uncertain = processGroupStatus(childPid) !== "gone";
			} catch {
				uncertain = true;
			}
		}
		if (uncertain) {
			const orphan = transitionOrphan(record, "cancelled-with-uncertain-launch-identity", undefined, Date.now() + killGraceMs + 5_000);
			await atomicWriteRecord(root, orphan);
			return orphan;
		}
		if (!observed) {
			const terminal = terminalRecord(record, "not-attempted", "cancelled", "cancelled-before-runner-handshake", "abort", null, 0, true);
			await discardOutput(root, requestId);
			await atomicWriteRecord(root, terminal);
			return terminal;
		}
		const orphan = transitionOrphan(record, "cancelled-before-runner-handshake", observed, Date.now() + killGraceMs + 5_000);
		await atomicWriteRecord(root, orphan);
		return orphan;
	});
	if (running) return (await cancelRequest(root, requestId, killGraceMs, cancelProcessGroup, readIdentity)).record;
	if (!observed) return prepared;
	if (!(await cancelProcessGroup(observed, killGraceMs).catch(() => false))) return prepared;
	return withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase === "terminal") return record;
		const terminal = terminalRecord(record, "not-attempted", "cancelled", "cancelled-before-runner-handshake", "abort", null, 0, true);
		await discardOutput(root, requestId);
		await atomicWriteRecord(root, terminal);
		return terminal;
	});
}

async function rememberLaunchedChild(
	root: string,
	requestId: string,
	pid: number | undefined,
	readIdentity: typeof readProcessIdentity,
): Promise<AskRequestRecord["runner"]> {
	if (!pid) return undefined;
	let identity: Awaited<ReturnType<typeof readProcessIdentity>>;
	try {
		identity = await readIdentity(pid);
	} catch {
		return undefined;
	}
	if (!identity || identity.pgid !== pid) return undefined;
	const runner = {
		pid,
		pgid: identity.pgid,
		identity: identity.identity,
	};
	await withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase !== "accepted" || record.custody !== "none") return;
		await atomicWriteRecord(root, { ...record, runner, state_version: record.state_version + 1 });
	});
	return runner;
}

function writeRunnerPayload(input: Writable, payload: string, deadline: number, signal?: AbortSignal) {
	return new Promise<"written" | "failed" | "timed-out" | "cancelled">((resolve) => {
		let settled = false;
		const finish = (result: "written" | "failed" | "timed-out" | "cancelled") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolve(result);
		};
		const abort = () => finish("cancelled");
		const error = () => finish("failed");
		const timer = setTimeout(() => finish("timed-out"), Math.max(0, deadline - Date.now()));
		// A timeout leaves a pending write until process cleanup; keep its error observed.
		input.once("error", error);
		input.once("close", () => input.removeListener("error", error));
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) return abort();
		try { input.end(payload, () => finish("written")); } catch { finish("failed"); }
	});
}

async function runnerStartupFailure(
	root: string,
	requestId: string,
	child: ReturnType<typeof spawn>,
): Promise<Pick<NonNullable<AskRequestRecord["terminal"]>, "reason" | "termination" | "exit_code">> {
	if (child.exitCode === null && child.signalCode === null) {
		return { reason: "runner-handshake-timeout", termination: "launch-unknown", exit_code: null };
	}
	// Never expose startup stderr or paths as a peer reply. Keep only known runtime codes.
	const output = await readOutput(root, requestId).then((bytes) => bytes.toString("utf8"), () => "");
	const code = ["ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING", "ERR_MODULE_NOT_FOUND", "ERR_UNKNOWN_FILE_EXTENSION", "ERR_REQUIRE_ESM", "MODULE_NOT_FOUND"]
		.find((candidate) => output.includes(candidate));
	return {
		reason: code ? `runner-startup:${code}` : "runner-startup-failed",
		termination: "process-error",
		exit_code: child.exitCode,
	};
}

async function launchRunner(
	root: string,
	record: AskRequestRecord,
	command: string,
	nodeCommand: string,
	runnerPath: string,
	token: string,
	cwd: string,
	env: Environment,
	prompt: string,
	askTimeoutMs: number,
	handshakeTimeoutMs: number,
	killGraceMs: number,
	readIdentity: typeof readProcessIdentity,
	signal: AbortSignal | undefined,
	cancelProcessGroup: NonNullable<MaestriAsyncRuntimeOptions["asyncCancelProcessGroup"]>,
): Promise<AskRequestRecord> {
	if (signal?.aborted) return cancelAccepted(root, record.request_id);
	await createOutput(root, record.request_id);
	const output = await open(outputPath(root, record.request_id), fsConstants.O_WRONLY | fsConstants.O_APPEND);
	let child: ReturnType<typeof spawn>;
	let spawnFailed = false;
	try {
		child = spawn(nodeCommand, [runnerPath, root, record.request_id, token], {
			cwd,
			detached: true,
			env: maestriCliEnvironment(env),
			shell: false,
			stdio: ["ignore", output.fd, output.fd, "pipe"],
			windowsHide: true,
		});
		child.once("error", () => { spawnFailed = true; });
	} catch {
		await output.close();
		return markLaunchFailure(root, record.request_id, "runner-spawn-failed");
	}
	await output.close();
	const launched = await rememberLaunchedChild(root, record.request_id, child.pid, readIdentity);
	const input = child.stdio[3];
	if (!input || !("end" in input)) {
		return markLaunchFailure(root, record.request_id, "runner-input-unavailable");
	}
	const deadline = Date.now() + handshakeTimeoutMs;
	const written = await writeRunnerPayload(input,
		JSON.stringify({ token, command, cwd, agent: record.agent, prompt, askTimeoutMs, killGraceMs }), deadline, signal);
	if (written === "cancelled") {
		return cancelDuringHandshake(root, record.request_id, child.pid, killGraceMs, readIdentity, cancelProcessGroup);
	}
	child.unref();
	while (Date.now() < deadline && !spawnFailed) {
		if (signal?.aborted) {
			return cancelDuringHandshake(root, record.request_id, child.pid, killGraceMs, readIdentity, cancelProcessGroup);
		}
		const current = await readRequest(root, record.request_id);
		if (current.phase !== "accepted") {
			if (signal?.aborted) {
				return cancelDuringHandshake(root, record.request_id, child.pid, killGraceMs, readIdentity, cancelProcessGroup);
			}
			return current;
		}
		if (child.exitCode !== null || child.signalCode !== null) break;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	const failure = await runnerStartupFailure(root, record.request_id, child);
	if (failure.reason === "runner-handshake-timeout" && written !== "written") {
		failure.reason = written === "timed-out" ? "runner-payload-timeout" : "runner-input-failed";
	}
	let observed: NonNullable<AskRequestRecord["runner"]> | undefined = launched;
	let uncertain = false;
	const timedOut = await withRequestLock(root, record.request_id, async () => {
		const current = await readRequest(root, record.request_id);
		if (current.phase !== "accepted") return current;
		if (!spawnFailed && child.pid) {
			try {
				const identity = await readIdentity(child.pid);
				if (identity && identity.pgid === child.pid) {
					observed = {
						pid: child.pid,
						pgid: identity.pgid,
						identity: identity.identity,
					};
				}
				if (!identity && processGroupStatus(child.pid) !== "gone") uncertain = true;
			} catch {
				uncertain = true;
			}
		}
		if (observed || uncertain) {
			const orphan = transitionOrphan(
				current,
				failure.reason,
				observed,
				Date.now() + killGraceMs + 5_000,
			);
			await atomicWriteRecord(root, orphan);
			return orphan;
		}
		const failed = terminalRecord(current, "unknown", "unknown", failure.reason, failure.termination, failure.exit_code, 0, true);
		await discardOutput(root, record.request_id);
		await atomicWriteRecord(root, failed);
		return failed;
	});
	if (!observed) return timedOut;
	const cleaned = await cancelProcessGroup(observed, killGraceMs).catch(() => false);
	if (!cleaned) return timedOut;
	return withRequestLock(root, record.request_id, async () => {
		const current = await readRequest(root, record.request_id);
		if (current.phase === "terminal") return current;
		const failed = terminalRecord(current, "unknown", "unknown", failure.reason, failure.termination, failure.exit_code, 0, true);
		await discardOutput(root, record.request_id);
		await atomicWriteRecord(root, failed);
		return failed;
	});
}

async function acceptAsyncRequest(
	agent: string,
	prompt: string,
	clientRequestId: string,
	cwd: string,
	env: Environment,
	platform: Platform,
	execute: MaestriExec,
	signal: AbortSignal | undefined,
	askTimeoutMs: number,
	handshakeTimeoutMs: number,
	killGraceMs: number,
	preflightTimeoutMs: number,
	runnerPath: string,
	readIdentity: typeof readProcessIdentity,
	cancelProcessGroup: NonNullable<MaestriAsyncRuntimeOptions["asyncCancelProcessGroup"]>,
): Promise<AskRequestRecord> {
	assertConnected(env, platform);
	assertAgent(agent);
	assertPrompt(prompt);
	assertClientRequestId(clientRequestId);
	const root = await ensureAskStateRoot(env);
	const scopeKey = askScopeKey(env);
	const digest = clientDigest(clientRequestId);
	const bodyDigest = promptDigest(prompt);
	const replay = await withFileLock(lockPath(root, "create"), async () => {
		await pruneTerminalRequests(root);
		await assertRequestInScope(env, { clientKeyDigest: digest });
		const existing = await mappedRequest(root, digest);
		if (existing) {
			if (existing.agent !== agent || existing.prompt_digest !== bodyDigest) {
				throw new Error("client_request_id already exists with a different agent or prompt");
			}
			return existing;
		}
		return null;
	});
	if (replay) return reconcileRequest(root, replay.request_id, readIdentity);
	const requestId = randomUUID();
	const runnerPrompt = envelopedPrompt(prompt, requestId);
	assertAskPrompt(runnerPrompt);
	const command = await resolveMaestriCli(env, platform);
	const nodeCommand = await resolveNodeExecutable(env);
	await preflightReady(execute, command, agent, cwd, env, platform, signal, preflightTimeoutMs);
	if (signal?.aborted) throw new Error("maestri_ask_async was cancelled before request acceptance");
	let runnerToken: string | undefined;
	const result = await withFileLock(lockPath(root, "create"), async () => {
		await assertRequestInScope(env, { clientKeyDigest: digest });
		const existing = await mappedRequest(root, digest);
		if (existing) {
			if (existing.agent !== agent || existing.prompt_digest !== bodyDigest) {
				throw new Error("client_request_id already exists with a different agent or prompt");
			}
			return { record: await reconcileRequest(root, existing.request_id, readIdentity), created: false };
		}
		for (const candidate of await listRequests(root)) {
			if (candidate.agent !== agent || candidate.phase === "terminal") continue;
			const current = await reconcileRequest(root, candidate.request_id, readIdentity);
			if (current.phase !== "terminal") {
				throw new Error(`Agent ${agent} already has active async request ${current.request_id}`);
			}
		}
		if (signal?.aborted) throw new Error("maestri_ask_async was cancelled before request acceptance");
		const now = new Date().toISOString();
		runnerToken = randomUUID();
		const record: AskRequestRecord = {
			schema: 1,
			scope_key: scopeKey,
			runner_token_digest: promptDigest(runnerToken),
			request_id: requestId,
			client_request_id: clientRequestId,
			agent,
			prompt_digest: bodyDigest,
			prompt_bytes: Buffer.byteLength(prompt, "utf8"),
			created_at: now,
			phase: "accepted",
			delivery: "not-attempted",
			reply: "none",
			custody: "none",
			cleanup_deadline_ms: null,
			notification: { state: "none", digest: null, sent_at: null, attempts: 0, claim: null },
			output: { raw_bytes: 0, truncated: false },
			state_version: 1,
		};
		return createAcceptedRequest(root, record, digest);
	});
	if (!result.created) return result.record;
	if (signal?.aborted) return cancelAccepted(root, result.record.request_id);
	if (!command || !nodeCommand || !runnerToken || !runnerPrompt) throw new Error("Async request executable resolution failed after acceptance");
	return launchRunner(
		root,
		result.record,
		command,
		nodeCommand,
		runnerPath,
		runnerToken,
		cwd,
		env,
		runnerPrompt,
		askTimeoutMs,
		handshakeTimeoutMs,
		killGraceMs,
		readIdentity,
		signal,
		cancelProcessGroup,
	);
}

function processGroupStatus(pgid: number): "alive" | "gone" | "unknown" {
	try {
		process.kill(-pgid, 0);
		return "alive";
	} catch (error) {
		return errno(error, "ESRCH") ? "gone" : "unknown";
	}
}

function groupAlive(pgid: number): boolean {
	return processGroupStatus(pgid) !== "gone";
}

async function cancelRequest(
	root: string,
	requestId: string,
	killGraceMs: number,
	cancelProcessGroup: NonNullable<MaestriAsyncRuntimeOptions["asyncCancelProcessGroup"]>,
	readIdentity: typeof readProcessIdentity,
): Promise<{ record: AskRequestRecord; refusal?: string }> {
	let runner: NonNullable<AskRequestRecord["runner"]> | undefined;
	const prepared = await withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase === "terminal") {
			if (record.reply === "cancelled") await discardOutput(root, requestId);
			return { record };
		}
		if (record.custody === "orphan") {
			return { record, refusal: "Request custody is orphaned; no signal was sent" };
		}
		if (record.phase === "accepted") {
			const terminal = terminalRecord(record, "not-attempted", "cancelled", "cancelled-before-handshake", "abort", null, 0, true);
			await discardOutput(root, requestId);
			await atomicWriteRecord(root, terminal);
			return { record: terminal };
		}
		if (!record.runner) throw new Error("Running async request has no process identity");
		let current: Awaited<ReturnType<typeof readProcessIdentity>>;
		let uncertain = false;
		try {
			current = await readIdentity(record.runner.pid);
		} catch {
			current = null;
			uncertain = true;
		}
		if (!current || current.pgid !== record.runner.pgid || !sameIdentity(current.identity, record.runner.identity)) {
			if (processGroupStatus(record.runner.pgid) !== "gone") {
				const orphan = transitionOrphan(
					record,
					uncertain ? "cancellation-process-identity-uncertain" : "cancellation-process-identity-mismatch",
				);
				await atomicWriteRecord(root, orphan);
				return { record: orphan, refusal: "Process identity was uncertain; no signal was sent" };
			}
			const rawBytes = await outputSize(root, requestId);
			await discardOutput(root, requestId);
			const terminal = terminalRecord(record, "unknown", "unknown", "cancellation-refused-process-identity", "process-error", null, rawBytes, true);
			await atomicWriteRecord(root, terminal);
			return { record: terminal, refusal: "Process identity did not match; no signal was sent" };
		}
		runner = record.runner;
		const cancelling = transitionCancelling(record, Date.now() + killGraceMs + 5_000);
		await atomicWriteRecord(root, cancelling);
		return { record: cancelling };
	});
	if (!runner) return prepared;
	if (!(await cancelProcessGroup(runner, killGraceMs).catch(() => false))) {
		return withRequestLock(root, requestId, async () => {
			const record = await readRequest(root, requestId);
			if (record.phase === "terminal") return { record };
			const orphan = transitionOrphan(record, "cancellation-cleanup-unconfirmed", record.runner, record.cleanup_deadline_ms);
			await atomicWriteRecord(root, orphan);
			return { record: orphan, refusal: "Process identity or cleanup was uncertain; cancellation was not reported" };
		});
	}
	return withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase === "terminal") {
			if (record.reply === "cancelled") await discardOutput(root, requestId);
			return { record };
		}
		const rawBytes = await outputSize(root, requestId);
		await discardOutput(root, requestId);
		const terminal = terminalRecord(record, "unknown", "cancelled", "cancelled", "abort", null, rawBytes, true);
		await atomicWriteRecord(root, terminal);
		return { record: terminal };
	});
}

async function terminateProcessGroup(
	runner: NonNullable<AskRequestRecord["runner"]>,
	killGraceMs: number,
	readIdentity: typeof readProcessIdentity = readProcessIdentity,
): Promise<boolean> {
	let current: Awaited<ReturnType<typeof readProcessIdentity>>;
	try {
		current = await readIdentity(runner.pid);
	} catch {
		return false;
	}
	if (!current) return !groupAlive(runner.pgid);
	if (current.pgid !== runner.pgid || !sameIdentity(current.identity, runner.identity)) return false;
	try {
		process.kill(-runner.pgid, "SIGTERM");
	} catch (error) {
		if (!errno(error, "ESRCH")) throw error;
		return !groupAlive(runner.pgid);
	}
	const deadline = Date.now() + killGraceMs;
	while (Date.now() < deadline && groupAlive(runner.pgid)) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	if (groupAlive(runner.pgid)) {
		try {
			current = await readIdentity(runner.pid);
		} catch {
			return false;
		}
		if (!current || current.pgid !== runner.pgid || !sameIdentity(current.identity, runner.identity)) return false;
		process.kill(-runner.pgid, "SIGKILL");
	}
	const cleanupDeadline = Date.now() + 5_000;
	while (Date.now() < cleanupDeadline && groupAlive(runner.pgid)) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !groupAlive(runner.pgid);
}

async function readResultOutput(root: string, record: AskRequestRecord): Promise<string> {
	try {
		return (await readOutput(root, record.request_id)).toString("utf8");
	} catch (error) {
		if (errno(error, "ENOENT")) return "";
		throw error;
	}
}

async function acknowledgeTerminalNotification(root: string, requestId: string): Promise<void> {
	await withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase !== "terminal" || record.notification.state === "acked") return;
		await atomicWriteRecord(root, {
			...record,
			notification: {
				...record.notification,
				state: "acked",
				digest: record.notification.digest ?? terminalEnvelope(record).digest,
				claim: null,
			},
		});
	});
}

function visibleState(record: AskRequestRecord, env: Environment) {
	return {
		...requestState(record),
		...(record.phase === "terminal" && record.terminal ? {
			reason: redactSensitiveText(record.terminal.reason, env).slice(0, 160),
			termination: record.terminal.termination,
			exit_code: record.terminal.exit_code,
		} : {}),
	};
}

function stateResult(action: string, state: AskRequestState, refusal?: string): AsyncToolResult {
	const value = refusal ? { ...state, refusal } : state;
	return {
		content: [{ type: "text", text: JSON.stringify(value) }],
		details: { action, ...value },
	};
}

async function requestAction(
	action: string,
	requestId: string,
	env: Environment,
	killGraceMs: number,
	cancelProcessGroup: NonNullable<MaestriAsyncRuntimeOptions["asyncCancelProcessGroup"]>,
	readIdentity: typeof readProcessIdentity,
): Promise<AsyncToolResult> {
	assertRequestId(requestId);
	const root = await ensureAskStateRoot(env);
	await assertRequestInScope(env, { requestId });
	if (action === "cancel") {
		const cancelled = await cancelRequest(root, requestId, killGraceMs, cancelProcessGroup, readIdentity);
		return stateResult(action, visibleState(cancelled.record, env), cancelled.refusal);
	}
	const record = await reconcileRequest(root, requestId, readIdentity);
	let state = visibleState(record, env);
	if (action !== "result" || record.phase !== "terminal") return stateResult(action, state);
	const output = await readResultOutput(root, record);
	const envelope = extractReplyEnvelope(output, requestId);
	const extracted = record.reply === "received" && envelope.reply === "received";
	if (record.reply === "received" && !extracted) state = { ...state, reply: "unknown" };
	const formatted = formatMaestriOutput({
		stdout: extracted ? envelope.content : output,
		stderr: "",
		code: record.terminal?.exit_code ?? 1,
		killed: record.terminal?.termination !== null,
		termination: record.terminal?.termination === "launch-unknown"
			? "process-error"
			: record.terminal?.termination ?? null,
		totalOutputBytes: record.output.raw_bytes,
	}, env, JSON.stringify({ ...state, output: extracted ? "extracted-reply" : "full-capture-evidence" }));
	await acknowledgeTerminalNotification(root, requestId);
	return {
		content: [{ type: "text", text: formatted.text }],
		details: { action, ...state, outputKind: extracted ? "extracted-reply" : "full-capture-evidence", ...formatted.details },
	};
}

export function registerMaestriAsyncTools(pi: ExtensionAPI, options: MaestriAsyncRuntimeOptions = {}): void {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const execute = options.execute ?? runBoundedProcess;
	const askTimeoutMs = options.asyncAskTimeoutMs ?? 10 * 60_000;
	const handshakeTimeoutMs = options.asyncHandshakeTimeoutMs ?? MAESTRI_ASYNC_HANDSHAKE_TIMEOUT_MS;
	const killGraceMs = options.asyncKillGraceMs ?? MAESTRI_ASYNC_KILL_GRACE_MS;
	const preflightTimeoutMs = options.asyncPreflightTimeoutMs ?? MAESTRI_ASYNC_PREFLIGHT_TIMEOUT_MS;
	const runnerPath = options.asyncRunnerPath ?? RUNNER_PATH;
	const readIdentity = options.asyncReadProcessIdentity ?? readProcessIdentity;
	const cancelProcessGroup = options.asyncCancelProcessGroup ?? ((runner, grace) => terminateProcessGroup(runner, grace, readIdentity));
	for (const [name, value] of Object.entries({ askTimeoutMs, handshakeTimeoutMs, killGraceMs, preflightTimeoutMs })) {
		if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
	}

	pi.registerTool({
		name: "maestri_ask_async",
		label: "Maestri ask async",
		description: "Start one durable Maestri ask and return its request ID within seconds without retrying delivery.",
		promptSnippet: "Start a durable asynchronous Maestri ask",
		promptGuidelines: [
			"Supply a stable client_request_id. Reuse it to recover the same request; never create a new key after timeout or cancellation.",
		],
		parameters: Type.Object({
			agent: Type.String({ minLength: 1, maxLength: 128 }),
			prompt: Type.String({ minLength: 1, maxLength: MAX_PROMPT_BYTES }),
			client_request_id: Type.String({ minLength: 1, maxLength: MAX_CLIENT_REQUEST_ID_BYTES }),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const record = await acceptAsyncRequest(
				params.agent,
				params.prompt,
				params.client_request_id,
				ctx.cwd,
				env,
				platform,
				execute,
				signal,
				askTimeoutMs,
				handshakeTimeoutMs,
				killGraceMs,
				preflightTimeoutMs,
				runnerPath,
				readIdentity,
				cancelProcessGroup,
			);
			return stateResult("ask_async", visibleState(record, env));
		},
	});

	pi.registerTool({
		name: "maestri_ask_request",
		label: "Maestri ask request",
		description: "Read status or terminal result, or cancel one durable asynchronous Maestri ask.",
		promptSnippet: "Inspect or cancel a durable asynchronous Maestri ask",
		promptGuidelines: [
			"Use the original request_id. A pending result has no partial reply; cancellation and unknown delivery must never cause an automatic resend.",
		],
		parameters: Type.Object({
			action: Type.String({ enum: ["status", "result", "cancel"] }),
			request_id: Type.String({ minLength: 36, maxLength: 36 }),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params) {
			if (!["status", "result", "cancel"].includes(params.action)) throw new Error("action must be status, result, or cancel");
			return requestAction(params.action, params.request_id, env, killGraceMs, cancelProcessGroup, readIdentity);
		},
	});
}
