import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { createReadStream, readFileSync, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import {
	ASK_RAW_OUTPUT_MAX_BYTES,
	atomicWriteRecord,
	outputPath,
	readProcessIdentity,
	readRequest,
	sameIdentity,
	transitionOrphan,
	transitionRunning,
	transitionTerminal,
	withRequestLock,
} from "./ask-store.ts";
import { redactSensitiveText } from "./output.ts";
import { extractReplyEnvelope } from "./reply-envelope.ts";
import { encodeAskPrompt } from "./cli-text.ts";

const root = process.argv[2] ?? "";
const requestId = process.argv[3] ?? "";
const token = process.argv[4] ?? "";

const RunnerPayloadSchema = Type.Object({
	token: Type.String(),
	command: Type.String(),
	cwd: Type.String(),
	agent: Type.String(),
	prompt: Type.String(),
	askTimeoutMs: Type.Integer({ minimum: 1 }),
	killGraceMs: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

/** @typedef {import("typebox").Static<typeof RunnerPayloadSchema>} RunnerPayload */
/** @typedef {import("./ask-store.ts").AskDelivery} AskDelivery */
/** @typedef {import("./ask-store.ts").AskReply} AskReply */
/** @typedef {import("./ask-store.ts").AskTerminal["termination"]} AskTermination */
/** @typedef {Exclude<AskTermination, null>} RunnerTermination */
/** @typedef {{ code: number, error: boolean, signal: NodeJS.Signals | null, spawned: boolean }} ChildOutcome */
/** @typedef {{ stdout: Buffer[], stderr: Buffer[], totalBytes: number, capturedBytes: number }} OutputCapture */

/** @returns {Promise<Buffer>} */
async function readPayloadBytes() {
	/** @type {Buffer[]} */
	const chunks = [];
	let bytes = 0;
	for await (const chunk of createReadStream("", { fd: 3, autoClose: true })) {
		const value = Buffer.from(chunk);
		bytes += value.length;
		if (bytes > 512 * 1024) throw new Error("Runner payload exceeds its limit");
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

/** @returns {Promise<RunnerPayload>} */
async function readPayload() {
	const payload = Parse(RunnerPayloadSchema, JSON.parse((await readPayloadBytes()).toString("utf8")));
	if (payload.token !== token || !path.isAbsolute(payload.command) || !path.isAbsolute(payload.cwd)) {
		throw new Error("Invalid runner payload");
	}
	return payload;
}

/** @returns {number[]} */
function processGroupMembers() {
	/** @type {number[]} */
	const members = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		const pid = Number(name);
		if (pid === process.pid) continue;
		try {
			const value = readFileSync(`/proc/${pid}/stat`, "utf8");
			const close = value.lastIndexOf(")");
			if (close < 0) continue;
			const fields = value.slice(close + 2).trim().split(/\s+/);
			if (Number(fields[2]) === process.pid) members.push(pid);
		} catch {}
	}
	return members;
}

/** @param {NodeJS.Signals} signal */
function signalProcessGroupMembers(signal) {
	for (const pid of processGroupMembers()) {
		try {
			process.kill(pid, signal);
		} catch {}
	}
}

/** @returns {Promise<boolean>} */
async function handshake() {
	const currentProcess = await readProcessIdentity(process.pid);
	if (!currentProcess || currentProcess.pgid !== process.pid) {
		throw new Error("Runner is not its process-group leader");
	}
	return withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase === "terminal" || record.custody === "orphan") return false;
		if (record.phase === "running") {
			return Boolean(
				record.runner &&
				record.runner.pid === process.pid &&
				record.runner.pgid === currentProcess.pgid &&
				sameIdentity(record.runner.identity, currentProcess.identity),
			);
		}
		const running = transitionRunning(record, {
			pid: process.pid,
			pgid: currentProcess.pgid,
			identity: currentProcess.identity,
		}, token);
		await atomicWriteRecord(root, running);
		return true;
	});
}

/** @param {Buffer} stdout @param {Buffer} stderr @returns {Buffer} */
function combinedOutput(stdout, stderr) {
	if (stdout.length === 0 && stderr.length === 0) return Buffer.alloc(0);
	if (stderr.length === 0) return stdout;
	const labelledError = Buffer.concat([Buffer.from("[stderr]\n"), stderr]);
	if (stdout.length === 0) return labelledError;
	const separator = stdout.at(-1) === 10 ? Buffer.alloc(0) : Buffer.from("\n");
	return Buffer.concat([stdout, separator, labelledError]);
}

/** @param {Buffer} stdout @param {Buffer} stderr @returns {Promise<string>} */
async function persistOutput(stdout, stderr) {
	const raw = combinedOutput(stdout, stderr);
	const content = Buffer.from(redactSensitiveText(raw.toString("utf8"), process.env));
	const handle = await open(
		outputPath(root, requestId),
		fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
	);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
	return content.toString("utf8");
}

/**
 * @param {AskDelivery} delivery
 * @param {AskReply} reply
 * @param {string} reason
 * @param {AskTermination} termination
 * @param {number | null} exitCode
 * @param {number} rawBytes
 * @param {boolean} truncated
 */
async function finish(delivery, reply, reason, termination, exitCode, rawBytes, truncated) {
	await withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase === "terminal") return;
		const cancelled = Boolean(record.cancel_requested_at);
		if (cancelled) await persistOutput(Buffer.alloc(0), Buffer.alloc(0));
		await atomicWriteRecord(
			root,
			transitionTerminal(record, {
				delivery: cancelled ? "unknown" : delivery,
				reply: cancelled ? "cancelled" : reply,
				reason: cancelled ? "cancelled" : reason,
				termination: cancelled ? "abort" : termination,
				exitCode,
				rawBytes,
				truncated: cancelled || truncated,
			}),
		);
	});
}

/** @param {Error} error */
async function fail(error) {
	try {
		await withRequestLock(root, requestId, async () => {
			const record = await readRequest(root, requestId);
			if (record.phase === "terminal") return;
			const attempted = record.phase === "running";
			const cancelled = Boolean(record.cancel_requested_at);
			await persistOutput(Buffer.alloc(0), Buffer.alloc(0));
			await atomicWriteRecord(
				root,
				transitionTerminal(record, {
					delivery: cancelled ? "unknown" : attempted ? "unknown" : "not-attempted",
					reply: cancelled ? "cancelled" : attempted ? "unknown" : "none",
					reason: cancelled ? "cancelled" : error.name,
					termination: cancelled ? "abort" : "process-error",
					exitCode: null,
					rawBytes: 0,
					truncated: true,
				}),
			);
		});
	} catch {}
}

/** @param {string} reason @param {number} cleanupDeadlineMs */
async function preserveOrphan(reason, cleanupDeadlineMs) {
	await withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase === "terminal") return;
		await persistOutput(Buffer.alloc(0), Buffer.alloc(0));
		await atomicWriteRecord(root, transitionOrphan(record, reason, record.runner, cleanupDeadlineMs));
	});
}

/** @param {number} killGraceMs */
function createStopController(killGraceMs) {
	/** @type {RunnerTermination | null} */
	let termination = null;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let killTimer;
	/** @param {RunnerTermination} reason */
	const stop = (reason) => {
		if (termination === null) termination = reason;
		signalProcessGroupMembers("SIGTERM");
		killTimer ??= setTimeout(() => signalProcessGroupMembers("SIGKILL"), killGraceMs);
	};
	return {
		stop,
		termination: () => termination,
		clear() {
			if (killTimer) clearTimeout(killTimer);
		},
	};
}

/**
 * @param {Buffer[]} target
 * @param {Buffer | string} chunk
 * @param {OutputCapture} capture
 * @param {(reason: RunnerTermination) => void} stop
 */
function captureChunk(target, chunk, capture, stop) {
	const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
	capture.totalBytes += value.length;
	const remaining = Math.max(0, ASK_RAW_OUTPUT_MAX_BYTES - capture.capturedBytes);
	if (remaining > 0) {
		const retained = value.subarray(0, remaining);
		target.push(retained);
		capture.capturedBytes += retained.length;
	}
	if (capture.totalBytes > ASK_RAW_OUTPUT_MAX_BYTES) stop("output-limit");
}

/** @param {RunnerPayload} payload @param {string} cliPrompt */
function spawnAsk(payload, cliPrompt) {
	return spawn(payload.command, ["ask", payload.agent, cliPrompt], {
		cwd: payload.cwd,
		detached: false,
		env: { ...process.env },
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
}

/**
 * @param {ReturnType<typeof spawnAsk>} child
 * @param {RunnerPayload} payload
 * @param {ReturnType<typeof createStopController>} controller
 * @returns {Promise<ChildOutcome>}
 */
async function waitForChild(child, payload, controller) {
	let spawned = false;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let timeout;
	const outcome = await new Promise((resolve) => {
		child.once("spawn", () => { spawned = true; });
		child.once("exit", () => {
			if (controller.termination() === null && processGroupMembers().length > 0) {
				controller.stop("process-error");
			}
		});
		child.once("error", () => resolve({ code: 1, error: true, signal: null, spawned }));
		child.once("close", (code, signal) => {
			resolve({ code: code ?? (signal ? 128 : 1), error: false, signal, spawned });
		});
		timeout = setTimeout(() => controller.stop("timeout"), payload.askTimeoutMs);
	});
	if (timeout) clearTimeout(timeout);
	return outcome;
}

/** @param {ReturnType<typeof createStopController>} controller */
function listenForRunnerSignals(controller) {
	process.once("SIGTERM", () => controller.stop("abort"));
	process.once("SIGINT", () => controller.stop("abort"));
	process.once("SIGHUP", () => controller.stop("abort"));
}

/**
 * @param {ReturnType<typeof createStopController>} controller
 * @param {number} killGraceMs
 * @returns {Promise<{ clean: boolean, deadline: number }>}
 */
async function cleanRunnerDescendants(controller, killGraceMs) {
	const deadline = Date.now() + killGraceMs + 5_000;
	if (processGroupMembers().length === 0) return { clean: true, deadline };
	if (controller.termination() === null) controller.stop("process-error");
	else signalProcessGroupMembers("SIGTERM");
	while (processGroupMembers().length > 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return { clean: processGroupMembers().length === 0, deadline };
}

/**
 * @param {ChildOutcome} outcome
 * @param {OutputCapture} capture
 * @param {ReturnType<typeof createStopController>} controller
 * @param {number} killGraceMs
 */
async function settleExecution(outcome, capture, controller, killGraceMs) {
	if (controller.termination() === null && outcome.signal) controller.stop("process-error");
	const cleanup = await cleanRunnerDescendants(controller, killGraceMs);
	if (!cleanup.clean) {
		controller.clear();
		await preserveOrphan("runner-descendant-cleanup-unconfirmed", cleanup.deadline);
		return;
	}
	controller.clear();
	const termination = controller.termination();
	if (termination !== null) {
		await persistOutput(Buffer.alloc(0), Buffer.alloc(0));
		await finish("unknown", "unknown", termination, termination, outcome.code, capture.totalBytes, true);
		return;
	}
	if (outcome.error || !outcome.spawned) {
		await persistOutput(Buffer.alloc(0), Buffer.alloc(0));
		await finish("not-attempted", "none", "cli-spawn-failed", "process-error", outcome.code, capture.totalBytes, true);
		return;
	}
	const captureText = await persistOutput(Buffer.concat(capture.stdout), Buffer.concat(capture.stderr));
	if (outcome.code !== 0) {
		await finish("unknown", "unknown", "cli-exit", null, outcome.code, capture.totalBytes, false);
		return;
	}
	const reply = extractReplyEnvelope(captureText, requestId);
	await finish("confirmed", reply.reply, reply.reason, null, 0, capture.totalBytes, false);
}

/** @param {RunnerPayload} payload @param {string} cliPrompt */
async function executeAsk(payload, cliPrompt) {
	const controller = createStopController(payload.killGraceMs);
	/** @type {OutputCapture} */
	const capture = { stdout: [], stderr: [], totalBytes: 0, capturedBytes: 0 };
	const child = spawnAsk(payload, cliPrompt);
	listenForRunnerSignals(controller);
	child.stdout.on("data", (chunk) => captureChunk(capture.stdout, chunk, capture, controller.stop));
	child.stderr.on("data", (chunk) => captureChunk(capture.stderr, chunk, capture, controller.stop));
	const outcome = await waitForChild(child, payload, controller);
	await settleExecution(outcome, capture, controller, payload.killGraceMs);
}

async function run() {
	if (!root || !requestId || !token) throw new Error("Missing runner identity");
	const payload = await readPayload();
	const cliPrompt = encodeAskPrompt(payload.prompt);
	if (!(await handshake())) return;
	await executeAsk(payload, cliPrompt);
}

try {
	await run();
} catch (caught) {
	await fail(caught instanceof Error ? caught : new Error("runner-error"));
}
