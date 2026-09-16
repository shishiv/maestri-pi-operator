import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
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
	transactRequest,
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
	type MaestriExecResult,
	type MaestriRuntimeOptions,
} from "./maestri.ts";
import { classifyPiReadiness } from "./readiness.ts";
import { envelopedPrompt, extractReplyEnvelope } from "./reply-envelope.ts";
import { terminalEnvelope } from "./ask-terminal.ts";
import { assertAskPrompt, MAX_PROMPT_BYTES } from "./cli-text.ts";
import { redactSensitiveText } from "./output.ts";
import {
	inspectLaunchedRunner,
	inspectRecordedRunner,
	processGroupStatus,
	terminateVerifiedRunner,
	type AsyncRunner,
} from "./async-custody.ts";
import type { PiToolRegistrar } from "./pi-tool.ts";

export const MAESTRI_ASYNC_PREFLIGHT_TIMEOUT_MS = 10_000;
export const MAESTRI_ASYNC_HANDSHAKE_TIMEOUT_MS = 2_000;
export const MAESTRI_ASYNC_KILL_GRACE_MS = 5_000;
const MAX_CLIENT_REQUEST_ID_BYTES = 256;
const ASYNC_STALE_ACCEPTED_MS = 15_000;
const RUNNER_PATH = fileURLToPath(new URL("./ask-runner.mjs", import.meta.url));

type Platform = NodeJS.Platform;
type CancelProcessGroup = (runner: AsyncRunner, killGraceMs: number) => Promise<boolean>;
type RequestAction = "status" | "result" | "cancel";
type OutputKind = "discarded" | "extracted-reply" | "full-capture-evidence";

interface AsyncVisibleState extends AskRequestState {
	reason?: string;
	termination?: NonNullable<AskRequestRecord["terminal"]>["termination"];
	exit_code?: number | null;
}

interface AsyncToolDetails {
	action: string;
	request_id: string;
	phase: AskRequestState["phase"];
	delivery: AskRequestState["delivery"];
	reply: AskRequestState["reply"];
	state_version: number;
	reason?: string;
	exit_code?: number | null;
	termination?: NonNullable<AskRequestRecord["terminal"]>["termination"] | MaestriExecResult["termination"];
	refusal?: string;
	outputKind?: OutputKind;
	truncated?: boolean;
	truncatedBy?: "lines" | "bytes" | null;
	totalLines?: number;
	totalBytes?: number;
	outputLines?: number;
	outputBytes?: number;
	rawBytesObserved?: number;
}

interface AsyncToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: AsyncToolDetails;
}

export interface MaestriAsyncRuntimeOptions extends MaestriRuntimeOptions {
	asyncAskTimeoutMs?: number;
	asyncHandshakeTimeoutMs?: number;
	asyncKillGraceMs?: number;
	asyncPreflightTimeoutMs?: number;
	asyncRunnerPath?: string;
	asyncReadProcessIdentity?: typeof readProcessIdentity;
	asyncCancelProcessGroup?: CancelProcessGroup;
}

interface AsyncRuntime {
	env: Environment;
	platform: Platform;
	execute: MaestriExec;
	askTimeoutMs: number;
	handshakeTimeoutMs: number;
	killGraceMs: number;
	preflightTimeoutMs: number;
	runnerPath: string;
	readIdentity: typeof readProcessIdentity;
	cancelProcessGroup: CancelProcessGroup;
}

interface AsyncSubmission {
	agent: string;
	prompt: string;
	clientRequestId: string;
	cwd: string;
	signal?: AbortSignal;
}

interface LaunchPlan {
	root: string;
	record: AskRequestRecord;
	command: string;
	nodeCommand: string;
	runnerPath: string;
	token: string;
	cwd: string;
	env: Environment;
	prompt: string;
	askTimeoutMs: number;
	handshakeTimeoutMs: number;
	killGraceMs: number;
	readIdentity: typeof readProcessIdentity;
	signal?: AbortSignal;
	cancelProcessGroup: CancelProcessGroup;
}

interface RunnerPayload {
	token: string;
	command: string;
	cwd: string;
	agent: string;
	prompt: string;
	askTimeoutMs: number;
	killGraceMs: number;
}

interface SpawnedRunner {
	child: ChildProcess;
	spawnFailed(): boolean;
}

interface CancelResult {
	record: AskRequestRecord;
	refusal?: string;
}

type AcceptanceSelection =
	| { kind: "created"; record: AskRequestRecord; token: string }
	| { kind: "replay"; record: AskRequestRecord };

type HandshakeCancellation =
	| { kind: "record"; record: AskRequestRecord }
	| { kind: "running"; record: AskRequestRecord }
	| { kind: "signal"; record: AskRequestRecord; runner: AsyncRunner };

function hasErrno(error: Error, code: string): boolean {
	return "code" in error && error.code === code;
}

function caughtErrno(caught: Error, code: string): boolean {
	return hasErrno(caught, code);
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

function isRequestAction(value: string): value is RequestAction {
	return value === "status" || value === "result" || value === "cancel";
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
		throw new PreflightError("The target Pi is busy; no async request was launched", "busy");
	}
	if (readiness.verdict !== "ready") {
		const reason = readiness.verdict === "unsupported" ? readiness.reason : readiness.verdict;
		throw new PreflightError("The target is missing, ambiguous, or not a ready Pi; no async request was launched", reason);
	}
}

export class PreflightError extends Error {
	readonly preflight: { stage: "readiness"; reason: string; request_created: false };

	constructor(message: string, reason: string) {
		super(message);
		this.name = "PreflightError";
		this.preflight = {
			stage: "readiness",
			reason: reason.replace(/[^a-z0-9-]/gi, "").slice(0, 64) || "unknown",
			request_created: false,
		};
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
		throw new PreflightError("Maestri readiness check failed; no async request was launched", "check-failed");
	}
	assertReadyPiScreen(result.stdout);
}

async function persistUnknownTerminal(
	root: string,
	record: AskRequestRecord,
	reason: string,
	rawBytes: number,
): Promise<AskRequestRecord> {
	const terminal = terminalRecord(record, "unknown", "unknown", reason, "process-error", null, rawBytes, true);
	await discardOutput(root, record.request_id);
	await atomicWriteRecord(root, terminal);
	return terminal;
}

async function reconcileOrphan(root: string, record: AskRequestRecord): Promise<AskRequestRecord> {
	if (!record.runner || processGroupStatus(record.runner.pgid) !== "gone") return record;
	return persistUnknownTerminal(root, record, "orphan-process-group-gone", record.output.raw_bytes);
}

async function reconcileAccepted(
	root: string,
	record: AskRequestRecord,
	readIdentity: typeof readProcessIdentity,
): Promise<AskRequestRecord> {
	if (Date.now() - Date.parse(record.created_at) <= ASYNC_STALE_ACCEPTED_MS) return record;
	if (!record.runner) return persistUnknownTerminal(root, record, "launch-unknown", 0);
	const inspection = await inspectRecordedRunner(record.runner, readIdentity);
	if (inspection.groupStatus === "gone") return persistUnknownTerminal(root, record, "launch-unknown", 0);
	const reason = inspection.identityStatus === "verified"
		? "runner-handshake-missing"
		: "runner-handshake-identity-uncertain";
	const orphan = transitionOrphan(record, reason);
	await atomicWriteRecord(root, orphan);
	return orphan;
}

function runningFailureReason(identityStatus: string, groupGone: boolean): string {
	if (identityStatus === "unreadable") {
		return groupGone ? "process-identity-uncertain-group-gone" : "process-identity-uncertain";
	}
	if (identityStatus === "mismatch") {
		return groupGone ? "process-identity-mismatch-group-gone" : "process-identity-mismatch";
	}
	return groupGone ? "runner-exited-without-result" : "runner-missing-group-present";
}

async function reconcileRunning(
	root: string,
	record: AskRequestRecord,
	readIdentity: typeof readProcessIdentity,
): Promise<AskRequestRecord> {
	if (!record.runner) throw new Error("Running async request has no process identity");
	const inspection = await inspectRecordedRunner(record.runner, readIdentity);
	if (inspection.identityStatus === "verified") return record;
	const reason = runningFailureReason(inspection.identityStatus, inspection.groupStatus === "gone");
	if (inspection.groupStatus !== "gone") {
		const orphan = transitionOrphan(record, reason);
		await atomicWriteRecord(root, orphan);
		return orphan;
	}
	const rawBytes = await outputSize(root, record.request_id);
	return persistUnknownTerminal(root, record, reason, rawBytes);
}

async function reconcileRequest(
	root: string,
	requestId: string,
	readIdentity: typeof readProcessIdentity,
): Promise<AskRequestRecord> {
	return withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase === "terminal") return record;
		if (record.custody === "orphan") return reconcileOrphan(root, record);
		if (record.phase === "accepted") return reconcileAccepted(root, record, readIdentity);
		return reconcileRunning(root, record, readIdentity);
	});
}

async function mappedRequest(root: string, digest: string): Promise<AskRequestRecord | null> {
	const indexed = await readClientRequest(root, digest);
	if (!indexed) return null;
	try {
		return await readRequest(root, indexed.request_id);
	} catch (caught) {
		if (!(caught instanceof Error) || !caughtErrno(caught, "ENOENT")) throw caught;
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

function assertReplayMatches(record: AskRequestRecord, agent: string, bodyDigest: string): void {
	if (record.agent !== agent || record.prompt_digest !== bodyDigest) {
		throw new Error("client_request_id already exists with a different agent or prompt");
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

async function prepareHandshakeCancellation(
	plan: LaunchPlan,
	childPid: number | undefined,
): Promise<HandshakeCancellation> {
	return withRequestLock(plan.root, plan.record.request_id, async () => {
		const record = await readRequest(plan.root, plan.record.request_id);
		if (record.phase === "terminal") return { kind: "record", record };
		if (record.phase === "running") return { kind: "running", record };
		const inspection = await inspectLaunchedRunner(childPid, plan.readIdentity);
		if (inspection.runner) {
			const orphan = transitionOrphan(
				record,
				"cancelled-before-runner-handshake",
				inspection.runner,
				Date.now() + plan.killGraceMs + 5_000,
			);
			await atomicWriteRecord(plan.root, orphan);
			return { kind: "signal", record: orphan, runner: inspection.runner };
		}
		if (inspection.identityStatus === "unreadable" || inspection.groupStatus !== "gone") {
			const orphan = transitionOrphan(
				record,
				"cancelled-with-uncertain-launch-identity",
				undefined,
				Date.now() + plan.killGraceMs + 5_000,
			);
			await atomicWriteRecord(plan.root, orphan);
			return { kind: "record", record: orphan };
		}
		const terminal = terminalRecord(record, "not-attempted", "cancelled", "cancelled-before-runner-handshake", "abort", null, 0, true);
		await discardOutput(plan.root, record.request_id);
		await atomicWriteRecord(plan.root, terminal);
		return { kind: "record", record: terminal };
	});
}

async function terminalAfterHandshakeCancellation(plan: LaunchPlan): Promise<AskRequestRecord> {
	return withRequestLock(plan.root, plan.record.request_id, async () => {
		const record = await readRequest(plan.root, plan.record.request_id);
		if (record.phase === "terminal") return record;
		const terminal = terminalRecord(record, "not-attempted", "cancelled", "cancelled-before-runner-handshake", "abort", null, 0, true);
		await discardOutput(plan.root, record.request_id);
		await atomicWriteRecord(plan.root, terminal);
		return terminal;
	});
}

async function cancelDuringHandshake(plan: LaunchPlan, childPid: number | undefined): Promise<AskRequestRecord> {
	const prepared = await prepareHandshakeCancellation(plan, childPid);
	if (prepared.kind === "running") {
		return (await cancelRequest(
			plan.root,
			plan.record.request_id,
			plan.killGraceMs,
			plan.cancelProcessGroup,
			plan.readIdentity,
		)).record;
	}
	if (prepared.kind === "record") return prepared.record;
	const cleaned = await plan.cancelProcessGroup(prepared.runner, plan.killGraceMs).catch(() => false);
	if (!cleaned) return prepared.record;
	return terminalAfterHandshakeCancellation(plan);
}

async function rememberLaunchedChild(plan: LaunchPlan, pid: number | undefined): Promise<void> {
	const inspection = await inspectLaunchedRunner(pid, plan.readIdentity);
	if (!inspection.runner) return;
	await withRequestLock(plan.root, plan.record.request_id, async () => {
		const record = await readRequest(plan.root, plan.record.request_id);
		if (record.phase !== "accepted" || record.custody !== "none") return;
		await atomicWriteRecord(plan.root, {
			...record,
			runner: inspection.runner,
			state_version: record.state_version + 1,
		});
	});
}

type PayloadWriteStatus = "written" | "failed" | "timed-out" | "cancelled" | "unavailable";

function writeRunnerPayload(
	input: Writable,
	payload: string,
	deadline: number,
	signal?: AbortSignal,
): Promise<Exclude<PayloadWriteStatus, "unavailable">> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: Exclude<PayloadWriteStatus, "unavailable">) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolve(result);
		};
		const abort = () => finish("cancelled");
		const error = () => finish("failed");
		const timer = setTimeout(() => finish("timed-out"), Math.max(0, deadline - Date.now()));
		input.once("error", error);
		input.once("close", () => input.removeListener("error", error));
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) return abort();
		try {
			input.end(payload, () => finish("written"));
		} catch {
			finish("failed");
		}
	});
}

async function spawnRunner(plan: LaunchPlan): Promise<SpawnedRunner | null> {
	await createOutput(plan.root, plan.record.request_id);
	const output = await open(outputPath(plan.root, plan.record.request_id), fsConstants.O_WRONLY | fsConstants.O_APPEND);
	let failed = false;
	try {
		const child = spawn(plan.nodeCommand, [plan.runnerPath, plan.root, plan.record.request_id, plan.token], {
			cwd: plan.cwd,
			detached: true,
			env: maestriCliEnvironment(plan.env),
			shell: false,
			stdio: ["ignore", output.fd, output.fd, "pipe"],
			windowsHide: true,
		});
		child.once("error", () => { failed = true; });
		return { child, spawnFailed: () => failed };
	} catch {
		return null;
	} finally {
		await output.close();
	}
}

function serializedRunnerPayload(plan: LaunchPlan): string {
	const payload: RunnerPayload = {
		token: plan.token,
		command: plan.command,
		cwd: plan.cwd,
		agent: plan.record.agent,
		prompt: plan.prompt,
		askTimeoutMs: plan.askTimeoutMs,
		killGraceMs: plan.killGraceMs,
	};
	return JSON.stringify(payload);
}

async function sendRunnerPayload(
	spawned: SpawnedRunner,
	plan: LaunchPlan,
	deadline: number,
): Promise<PayloadWriteStatus> {
	const input = spawned.child.stdio[3];
	if (!(input instanceof Writable)) return "unavailable";
	return writeRunnerPayload(input, serializedRunnerPayload(plan), deadline, plan.signal);
}

async function waitForRunnerHandshake(
	spawned: SpawnedRunner,
	plan: LaunchPlan,
	deadline: number,
): Promise<AskRequestRecord | null> {
	while (Date.now() < deadline && !spawned.spawnFailed()) {
		if (plan.signal?.aborted) return cancelDuringHandshake(plan, spawned.child.pid);
		const current = await readRequest(plan.root, plan.record.request_id);
		if (current.phase !== "accepted") {
			if (plan.signal?.aborted) return cancelDuringHandshake(plan, spawned.child.pid);
			return current;
		}
		if (spawned.child.exitCode !== null || spawned.child.signalCode !== null) break;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return null;
}

async function runnerStartupFailure(
	root: string,
	requestId: string,
	child: ChildProcess,
): Promise<Pick<NonNullable<AskRequestRecord["terminal"]>, "reason" | "termination" | "exit_code">> {
	if (child.exitCode === null && child.signalCode === null) {
		return { reason: "runner-handshake-timeout", termination: "launch-unknown", exit_code: null };
	}
	const output = await readOutput(root, requestId).then((bytes) => bytes.toString("utf8"), () => "");
	const code = ["ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING", "ERR_MODULE_NOT_FOUND", "ERR_UNKNOWN_FILE_EXTENSION", "ERR_REQUIRE_ESM", "MODULE_NOT_FOUND"]
		.find((candidate) => output.includes(candidate));
	return {
		reason: code ? `runner-startup:${code}` : "runner-startup-failed",
		termination: "process-error",
		exit_code: child.exitCode,
	};
}

function payloadFailureReason(status: PayloadWriteStatus): string {
	if (status === "timed-out") return "runner-payload-timeout";
	if (status === "unavailable") return "runner-input-unavailable";
	return "runner-input-failed";
}

async function prepareLaunchFailure(
	plan: LaunchPlan,
	childPid: number | undefined,
	failure: Pick<NonNullable<AskRequestRecord["terminal"]>, "reason" | "termination" | "exit_code">,
): Promise<{ record: AskRequestRecord; runner?: AsyncRunner }> {
	return withRequestLock(plan.root, plan.record.request_id, async () => {
		const current = await readRequest(plan.root, plan.record.request_id);
		if (current.phase !== "accepted") return { record: current };
		const inspection = await inspectLaunchedRunner(childPid, plan.readIdentity);
		if (inspection.runner || inspection.identityStatus === "unreadable" || inspection.groupStatus !== "gone") {
			const orphan = transitionOrphan(
				current,
				failure.reason,
				inspection.runner,
				Date.now() + plan.killGraceMs + 5_000,
			);
			await atomicWriteRecord(plan.root, orphan);
			return { record: orphan, runner: inspection.runner };
		}
		const failed = terminalRecord(
			current,
			"unknown",
			"unknown",
			failure.reason,
			failure.termination,
			failure.exit_code,
			0,
			true,
		);
		await discardOutput(plan.root, current.request_id);
		await atomicWriteRecord(plan.root, failed);
		return { record: failed };
	});
}

async function terminalAfterLaunchCleanup(
	plan: LaunchPlan,
	failure: Pick<NonNullable<AskRequestRecord["terminal"]>, "reason" | "termination" | "exit_code">,
): Promise<AskRequestRecord> {
	return withRequestLock(plan.root, plan.record.request_id, async () => {
		const current = await readRequest(plan.root, plan.record.request_id);
		if (current.phase === "terminal") return current;
		const failed = terminalRecord(
			current,
			"unknown",
			"unknown",
			failure.reason,
			failure.termination,
			failure.exit_code,
			0,
			true,
		);
		await discardOutput(plan.root, current.request_id);
		await atomicWriteRecord(plan.root, failed);
		return failed;
	});
}

async function finalizeLaunchFailure(
	spawned: SpawnedRunner,
	plan: LaunchPlan,
	written: PayloadWriteStatus,
): Promise<AskRequestRecord> {
	const failure = await runnerStartupFailure(plan.root, plan.record.request_id, spawned.child);
	if (failure.reason === "runner-handshake-timeout" && written !== "written") {
		failure.reason = payloadFailureReason(written);
	}
	const prepared = await prepareLaunchFailure(plan, spawned.child.pid, failure);
	if (!prepared.runner) return prepared.record;
	const cleaned = await plan.cancelProcessGroup(prepared.runner, plan.killGraceMs).catch(() => false);
	if (!cleaned) return prepared.record;
	return terminalAfterLaunchCleanup(plan, failure);
}

async function launchRunner(plan: LaunchPlan): Promise<AskRequestRecord> {
	if (plan.signal?.aborted) return cancelAccepted(plan.root, plan.record.request_id);
	const spawned = await spawnRunner(plan);
	if (!spawned) return markLaunchFailure(plan.root, plan.record.request_id, "runner-spawn-failed");
	await rememberLaunchedChild(plan, spawned.child.pid);
	const deadline = Date.now() + plan.handshakeTimeoutMs;
	const written = await sendRunnerPayload(spawned, plan, deadline);
	if (written === "cancelled") return cancelDuringHandshake(plan, spawned.child.pid);
	spawned.child.unref();
	const handshaken = await waitForRunnerHandshake(spawned, plan, deadline);
	if (handshaken) return handshaken;
	return finalizeLaunchFailure(spawned, plan, written);
}

async function replayBeforePreflight(
	root: string,
	digest: string,
	agent: string,
	bodyDigest: string,
	env: Environment,
): Promise<AskRequestRecord | null> {
	return withFileLock(lockPath(root, "create"), async () => {
		await pruneTerminalRequests(root);
		await assertRequestInScope(env, { clientKeyDigest: digest });
		const existing = await mappedRequest(root, digest);
		if (existing) assertReplayMatches(existing, agent, bodyDigest);
		return existing;
	});
}

async function assertAgentHasNoActiveRequest(
	root: string,
	agent: string,
	readIdentity: typeof readProcessIdentity,
): Promise<void> {
	for (const candidate of await listRequests(root)) {
		if (candidate.agent !== agent || candidate.phase === "terminal") continue;
		const current = await reconcileRequest(root, candidate.request_id, readIdentity);
		if (current.phase !== "terminal") {
			throw new Error(`Agent ${agent} already has active async request ${current.request_id}`);
		}
	}
}

function acceptedRecord(
	submission: AsyncSubmission,
	requestId: string,
	scopeKey: string,
	bodyDigest: string,
	token: string,
): AskRequestRecord {
	return {
		schema: 1,
		scope_key: scopeKey,
		runner_token_digest: promptDigest(token),
		request_id: requestId,
		client_request_id: submission.clientRequestId,
		agent: submission.agent,
		prompt_digest: bodyDigest,
		prompt_bytes: Buffer.byteLength(submission.prompt, "utf8"),
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

async function acceptAfterPreflight(
	submission: AsyncSubmission,
	runtime: AsyncRuntime,
	root: string,
	digest: string,
	bodyDigest: string,
	requestId: string,
): Promise<AcceptanceSelection> {
	return withFileLock(lockPath(root, "create"), async () => {
		await assertRequestInScope(runtime.env, { clientKeyDigest: digest });
		const existing = await mappedRequest(root, digest);
		if (existing) {
			assertReplayMatches(existing, submission.agent, bodyDigest);
			return { kind: "replay", record: await reconcileRequest(root, existing.request_id, runtime.readIdentity) };
		}
		await assertAgentHasNoActiveRequest(root, submission.agent, runtime.readIdentity);
		if (submission.signal?.aborted) {
			throw new Error("maestri_ask_async was cancelled before request acceptance");
		}
		const token = randomUUID();
		const candidate = acceptedRecord(submission, requestId, askScopeKey(runtime.env), bodyDigest, token);
		const created = await createAcceptedRequest(root, candidate, digest);
		if (!created.created) {
			assertReplayMatches(created.record, submission.agent, bodyDigest);
			return { kind: "replay", record: await reconcileRequest(root, created.record.request_id, runtime.readIdentity) };
		}
		return { kind: "created", record: created.record, token };
	});
}

async function acceptAsyncRequest(submission: AsyncSubmission, runtime: AsyncRuntime): Promise<AskRequestRecord> {
	assertConnected(runtime.env, runtime.platform);
	assertAgent(submission.agent);
	assertPrompt(submission.prompt);
	assertClientRequestId(submission.clientRequestId);
	const root = await ensureAskStateRoot(runtime.env);
	const digest = clientDigest(submission.clientRequestId);
	const bodyDigest = promptDigest(submission.prompt);
	const replay = await replayBeforePreflight(root, digest, submission.agent, bodyDigest, runtime.env);
	if (replay) return reconcileRequest(root, replay.request_id, runtime.readIdentity);
	const requestId = randomUUID();
	const runnerPrompt = envelopedPrompt(submission.prompt, requestId);
	assertAskPrompt(runnerPrompt);
	const command = await resolveMaestriCli(runtime.env, runtime.platform);
	const nodeCommand = await resolveNodeExecutable(runtime.env);
	await preflightReady(
		runtime.execute,
		command,
		submission.agent,
		submission.cwd,
		runtime.env,
		runtime.platform,
		submission.signal,
		runtime.preflightTimeoutMs,
	);
	if (submission.signal?.aborted) throw new Error("maestri_ask_async was cancelled before request acceptance");
	const selection = await acceptAfterPreflight(submission, runtime, root, digest, bodyDigest, requestId);
	if (selection.kind === "replay") return selection.record;
	if (submission.signal?.aborted) return cancelAccepted(root, selection.record.request_id);
	return launchRunner({
		root,
		record: selection.record,
		command,
		nodeCommand,
		runnerPath: runtime.runnerPath,
		token: selection.token,
		cwd: submission.cwd,
		env: runtime.env,
		prompt: runnerPrompt,
		askTimeoutMs: runtime.askTimeoutMs,
		handshakeTimeoutMs: runtime.handshakeTimeoutMs,
		killGraceMs: runtime.killGraceMs,
		readIdentity: runtime.readIdentity,
		signal: submission.signal,
		cancelProcessGroup: runtime.cancelProcessGroup,
	});
}

async function terminalCancellation(
	root: string,
	record: AskRequestRecord,
	requestId: string,
): Promise<CancelResult> {
	if (record.reply === "cancelled") await discardOutput(root, requestId);
	return { record };
}

async function acceptedCancellation(root: string, record: AskRequestRecord): Promise<CancelResult> {
	const terminal = terminalRecord(record, "not-attempted", "cancelled", "cancelled-before-handshake", "abort", null, 0, true);
	await discardOutput(root, record.request_id);
	await atomicWriteRecord(root, terminal);
	return { record: terminal };
}

async function refusedRunningCancellation(
	root: string,
	record: AskRequestRecord,
	identityStatus: string,
	groupGone: boolean,
): Promise<CancelResult> {
	if (!groupGone) {
		const reason = identityStatus === "unreadable"
			? "cancellation-process-identity-uncertain"
			: "cancellation-process-identity-mismatch";
		const orphan = transitionOrphan(record, reason);
		await atomicWriteRecord(root, orphan);
		return { record: orphan, refusal: "Process identity was uncertain; no signal was sent" };
	}
	const rawBytes = await outputSize(root, record.request_id);
	const terminal = terminalRecord(record, "unknown", "unknown", "cancellation-refused-process-identity", "process-error", null, rawBytes, true);
	await discardOutput(root, record.request_id);
	await atomicWriteRecord(root, terminal);
	return { record: terminal, refusal: "Process identity did not match; no signal was sent" };
}

async function prepareCancellation(
	root: string,
	requestId: string,
	killGraceMs: number,
	readIdentity: typeof readProcessIdentity,
	signal?: AbortSignal,
): Promise<{ result: CancelResult; runner?: AsyncRunner }> {
	signal?.throwIfAborted();
	return withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase === "terminal") return { result: await terminalCancellation(root, record, requestId) };
		if (record.custody === "orphan") {
			return { result: { record, refusal: "Request custody is orphaned; no signal was sent" } };
		}
		if (record.phase === "accepted") return { result: await acceptedCancellation(root, record) };
		if (!record.runner) throw new Error("Running async request has no process identity");
		const inspection = await inspectRecordedRunner(record.runner, readIdentity);
		if (inspection.identityStatus !== "verified") {
			return {
				result: await refusedRunningCancellation(
					root,
					record,
					inspection.identityStatus,
					inspection.groupStatus === "gone",
				),
			};
		}
		signal?.throwIfAborted();
		const cancelling = transitionCancelling(record, Date.now() + killGraceMs + 5_000);
		await atomicWriteRecord(root, cancelling);
		return { result: { record: cancelling }, runner: record.runner };
	});
}

async function orphanAfterCancellationFailure(root: string, requestId: string): Promise<CancelResult> {
	return withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase === "terminal") return { record };
		const orphan = transitionOrphan(record, "cancellation-cleanup-unconfirmed", record.runner, record.cleanup_deadline_ms);
		await atomicWriteRecord(root, orphan);
		return { record: orphan, refusal: "Process identity or cleanup was uncertain; cancellation was not reported" };
	});
}

async function terminalAfterCancellation(root: string, requestId: string): Promise<CancelResult> {
	return withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase === "terminal") return terminalCancellation(root, record, requestId);
		const rawBytes = await outputSize(root, requestId);
		const terminal = terminalRecord(record, "unknown", "cancelled", "cancelled", "abort", null, rawBytes, true);
		await discardOutput(root, requestId);
		await atomicWriteRecord(root, terminal);
		return { record: terminal };
	});
}

async function cancelRequest(
	root: string,
	requestId: string,
	killGraceMs: number,
	cancelProcessGroup: CancelProcessGroup,
	readIdentity: typeof readProcessIdentity,
	signal?: AbortSignal,
): Promise<CancelResult> {
	const prepared = await prepareCancellation(root, requestId, killGraceMs, readIdentity, signal);
	if (!prepared.runner) return prepared.result;
	const cleaned = await cancelProcessGroup(prepared.runner, killGraceMs).catch(() => false);
	if (!cleaned) return orphanAfterCancellationFailure(root, requestId);
	return terminalAfterCancellation(root, requestId);
}

async function readResultOutput(root: string, record: AskRequestRecord): Promise<string> {
	try {
		return (await readOutput(root, record.request_id)).toString("utf8");
	} catch (caught) {
		if (caught instanceof Error && caughtErrno(caught, "ENOENT")) return "";
		throw caught;
	}
}

async function acknowledgeTerminalNotification(root: string, requestId: string): Promise<void> {
	await transactRequest(root, requestId, (record) => {
		if (record.phase !== "terminal" || record.notification.state === "acked") return null;
		return {
			...record,
			notification: {
				...record.notification,
				state: "acked",
				digest: record.notification.digest ?? terminalEnvelope(record).digest,
				claim: null,
			},
		};
	});
}

function visibleState(record: AskRequestRecord, env: Environment): AsyncVisibleState {
	const state: AsyncVisibleState = requestState(record);
	if (record.phase !== "terminal" || !record.terminal) return state;
	state.reason = redactSensitiveText(record.terminal.reason, env).slice(0, 160);
	state.termination = record.terminal.termination;
	state.exit_code = record.terminal.exit_code;
	return state;
}

function stateResult(action: string, state: AsyncVisibleState, refusal?: string): AsyncToolResult {
	const value: AsyncVisibleState & { refusal?: string } = { ...state };
	if (refusal) value.refusal = refusal;
	return {
		content: [{ type: "text", text: JSON.stringify(value) }],
		details: { action, ...value },
	};
}

async function cancellationAction(
	requestId: string,
	env: Environment,
	root: string,
	killGraceMs: number,
	cancelProcessGroup: CancelProcessGroup,
	readIdentity: typeof readProcessIdentity,
	signal?: AbortSignal,
): Promise<AsyncToolResult> {
	signal?.throwIfAborted();
	const cancelled = await cancelRequest(root, requestId, killGraceMs, cancelProcessGroup, readIdentity, signal);
	return stateResult("cancel", visibleState(cancelled.record, env), cancelled.refusal);
}

function resultProcess(
	record: AskRequestRecord,
	output: string,
	extractedContent: string,
	extracted: boolean,
): MaestriExecResult {
	return {
		stdout: extracted ? extractedContent : output,
		stderr: "",
		code: record.terminal?.exit_code ?? 1,
		killed: record.terminal?.termination !== null,
		termination: record.terminal?.termination === "launch-unknown"
			? "process-error"
			: record.terminal?.termination ?? null,
		totalOutputBytes: record.output.raw_bytes,
	};
}

async function terminalResult(
	root: string,
	record: AskRequestRecord,
	env: Environment,
): Promise<AsyncToolResult> {
	const output = await readResultOutput(root, record);
	const capture = extractReplyEnvelope(output, record.request_id);
	const extracted = record.reply === "received" && capture.reply === "received";
	const state = visibleState(record, env);
	if (record.reply === "received" && !extracted) state.reply = "unknown";
	const outputKind: OutputKind = extracted
		? "extracted-reply"
		: record.terminal?.termination !== null ? "discarded" : "full-capture-evidence";
	const formatted = formatMaestriOutput(
		resultProcess(record, output, capture.content ?? "", extracted),
		env,
		JSON.stringify({ ...state, output: outputKind }),
	);
	await acknowledgeTerminalNotification(root, record.request_id);
	return {
		content: [{ type: "text", text: formatted.text }],
		details: { action: "result", ...state, outputKind, ...formatted.details },
	};
}

async function requestAction(
	action: RequestAction,
	requestId: string,
	env: Environment,
	killGraceMs: number,
	cancelProcessGroup: CancelProcessGroup,
	readIdentity: typeof readProcessIdentity,
	signal?: AbortSignal,
): Promise<AsyncToolResult> {
	assertRequestId(requestId);
	const root = await ensureAskStateRoot(env);
	await assertRequestInScope(env, { requestId });
	if (action === "cancel") {
		return cancellationAction(requestId, env, root, killGraceMs, cancelProcessGroup, readIdentity, signal);
	}
	const record = await reconcileRequest(root, requestId, readIdentity);
	if (action !== "result" || record.phase !== "terminal") {
		return stateResult(action, visibleState(record, env));
	}
	return terminalResult(root, record, env);
}

function positiveInteger(name: string, value: number): number {
	if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
	return value;
}

function cancellationAdapter(
	options: MaestriAsyncRuntimeOptions,
	readIdentity: typeof readProcessIdentity,
): CancelProcessGroup {
	return options.asyncCancelProcessGroup ??
		((runner, grace) => terminateVerifiedRunner(runner, grace, readIdentity));
}

function createAsyncRuntime(options: MaestriAsyncRuntimeOptions): AsyncRuntime {
	const readIdentity = options.asyncReadProcessIdentity ?? readProcessIdentity;
	return {
		env: options.env ?? process.env,
		platform: options.platform ?? process.platform,
		execute: options.execute ?? runBoundedProcess,
		askTimeoutMs: positiveInteger("askTimeoutMs", options.asyncAskTimeoutMs ?? 10 * 60_000),
		handshakeTimeoutMs: positiveInteger(
			"handshakeTimeoutMs",
			options.asyncHandshakeTimeoutMs ?? MAESTRI_ASYNC_HANDSHAKE_TIMEOUT_MS,
		),
		killGraceMs: positiveInteger("killGraceMs", options.asyncKillGraceMs ?? MAESTRI_ASYNC_KILL_GRACE_MS),
		preflightTimeoutMs: positiveInteger(
			"preflightTimeoutMs",
			options.asyncPreflightTimeoutMs ?? MAESTRI_ASYNC_PREFLIGHT_TIMEOUT_MS,
		),
		runnerPath: options.asyncRunnerPath ?? RUNNER_PATH,
		readIdentity,
		cancelProcessGroup: cancellationAdapter(options, readIdentity),
	};
}

function registerAskAsyncTool(pi: PiToolRegistrar, runtime: AsyncRuntime): void {
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
			const record = await acceptAsyncRequest({
				agent: params.agent,
				prompt: params.prompt,
				clientRequestId: params.client_request_id,
				cwd: ctx.cwd,
				signal,
			}, runtime);
			return stateResult("ask_async", visibleState(record, runtime.env));
		},
	});
}

function registerAskRequestTool(pi: PiToolRegistrar, runtime: AsyncRuntime): void {
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
		async execute(_toolCallId, params, signal) {
			if (!isRequestAction(params.action)) throw new Error("action must be status, result, or cancel");
			return requestAction(
				params.action,
				params.request_id,
				runtime.env,
				runtime.killGraceMs,
				runtime.cancelProcessGroup,
				runtime.readIdentity,
				signal,
			);
		},
	});
}

export function registerMaestriAsyncTools(
	pi: PiToolRegistrar,
	options: MaestriAsyncRuntimeOptions = {},
): void {
	const runtime = createAsyncRuntime(options);
	registerAskAsyncTool(pi, runtime);
	registerAskRequestTool(pi, runtime);
}
