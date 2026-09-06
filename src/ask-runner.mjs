import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { createReadStream, readFileSync, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
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

const [root, requestId, token] = process.argv.slice(2);

async function readPayload() {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of createReadStream(null, { fd: 3, autoClose: true })) {
		bytes += chunk.length;
		// JSON may expand accepted control characters to six bytes each.
		if (bytes > 512 * 1024) throw new Error("Runner payload exceeds its limit");
		chunks.push(chunk);
	}
	const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (
		!payload || payload.token !== token || typeof payload.command !== "string" || !path.isAbsolute(payload.command) ||
		typeof payload.cwd !== "string" || !path.isAbsolute(payload.cwd) || typeof payload.agent !== "string" ||
		typeof payload.prompt !== "string" || !Number.isInteger(payload.askTimeoutMs) || payload.askTimeoutMs < 1 ||
		!Number.isInteger(payload.killGraceMs) || payload.killGraceMs < 1
	) {
		throw new Error("Invalid runner payload");
	}
	return payload;
}


function processGroupMembers() {
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

function signalProcessGroupMembers(signal) {
	for (const pid of processGroupMembers()) {
		try {
			process.kill(pid, signal);
		} catch {}
	}
}

async function handshake() {
	const currentProcess = await readProcessIdentity(process.pid);
	if (!currentProcess || currentProcess.pgid !== process.pid) throw new Error("Runner is not its process-group leader");
	return withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase === "terminal") return false;
		if (record.custody === "orphan") return false;
		if (record.phase === "running") {
			return Boolean(
				record.runner && record.runner.pid === process.pid && record.runner.pgid === currentProcess.pgid &&
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

async function persistOutput(stdout, stderr) {
	const sections = [];
	if (stdout.length) sections.push(stdout);
	if (stderr.length) sections.push(Buffer.concat([Buffer.from("[stderr]\n"), stderr]));
	const raw = sections.length === 0
		? Buffer.alloc(0)
		: sections.length === 1
			? sections[0]
			: Buffer.concat([sections[0], sections[0].at(-1) === 10 ? Buffer.alloc(0) : Buffer.from("\n"), sections[1]]);
	const content = Buffer.from(redactSensitiveText(raw.toString("utf8"), process.env));
	const handle = await open(outputPath(root, requestId), fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
	return content.toString("utf8");
}

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
					reason: cancelled ? "cancelled" : error instanceof Error ? error.name : "runner-error",
					termination: cancelled ? "abort" : "process-error",
					exitCode: null,
					rawBytes: 0,
					truncated: true,
				}),
			);
		});
	} catch {}
}

async function preserveOrphan(reason, cleanupDeadlineMs) {
	await withRequestLock(root, requestId, async () => {
		const record = await readRequest(root, requestId);
		if (record.phase === "terminal") return;
		await persistOutput(Buffer.alloc(0), Buffer.alloc(0));
		await atomicWriteRecord(root, transitionOrphan(record, reason, record.runner, cleanupDeadlineMs));
	});
}

async function run() {
	if (!root || !requestId || !token) throw new Error("Missing runner identity");
	const payload = await readPayload();
	const cliPrompt = encodeAskPrompt(payload.prompt);
	if (!(await handshake())) return;
	const stdout = [];
	const stderr = [];
	let totalBytes = 0;
	let capturedBytes = 0;
	let termination = null;
	let killTimer;
	let timeout;
	let settled = false;
	let spawned = false;
	const child = spawn(payload.command, ["ask", payload.agent, cliPrompt], {
		cwd: payload.cwd,
		detached: false,
		env: { ...process.env },
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const stop = (reason) => {
		if (termination === null) termination = reason;
		signalProcessGroupMembers("SIGTERM");
		killTimer ??= setTimeout(() => {
			signalProcessGroupMembers("SIGKILL");
		}, payload.killGraceMs);
	};
	const capture = (target, chunk) => {
		const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += value.length;
		const remaining = Math.max(0, ASK_RAW_OUTPUT_MAX_BYTES - capturedBytes);
		if (remaining > 0) {
			const retained = value.subarray(0, remaining);
			target.push(retained);
			capturedBytes += retained.length;
		}
		if (totalBytes > ASK_RAW_OUTPUT_MAX_BYTES) stop("output-limit");
	};
	process.once("SIGTERM", () => stop("abort"));
	process.once("SIGINT", () => stop("abort"));
	process.once("SIGHUP", () => stop("abort"));
	child.stdout.on("data", (chunk) => capture(stdout, chunk));
	child.stderr.on("data", (chunk) => capture(stderr, chunk));
	const outcome = await new Promise((resolve) => {
		child.once("spawn", () => {
			spawned = true;
		});
		child.once("exit", () => {
			if (termination === null && processGroupMembers().length > 0) stop("process-error");
		});
		child.once("error", () => resolve({ code: 1, error: true }));
		child.once("close", (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), error: false, signal }));
		timeout = setTimeout(() => stop("timeout"), payload.askTimeoutMs);
	});
	if (settled) return;
	settled = true;
	clearTimeout(timeout);
	if (termination === null && outcome.signal) termination = "process-error";
	if (processGroupMembers().length > 0) {
		if (termination === null) termination = "process-error";
		signalProcessGroupMembers("SIGTERM");
		killTimer ??= setTimeout(() => signalProcessGroupMembers("SIGKILL"), payload.killGraceMs);
		const cleanupDeadline = Date.now() + payload.killGraceMs + 5_000;
		while (processGroupMembers().length > 0 && Date.now() < cleanupDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		if (processGroupMembers().length > 0) {
			if (killTimer) clearTimeout(killTimer);
			await preserveOrphan("runner-descendant-cleanup-unconfirmed", cleanupDeadline);
			return;
		}
	}
	if (killTimer) clearTimeout(killTimer);
	if (termination !== null) {
		await persistOutput(Buffer.alloc(0), Buffer.alloc(0));
		await finish("unknown", "unknown", termination, termination, outcome.code, totalBytes, true);
		return;
	}
	if (outcome.error || !spawned) {
		await persistOutput(Buffer.alloc(0), Buffer.alloc(0));
		await finish("not-attempted", "none", "cli-spawn-failed", "process-error", outcome.code, totalBytes, true);
		return;
	}
	const captureText = await persistOutput(Buffer.concat(stdout), Buffer.concat(stderr));
	if (outcome.code === 0) {
		const envelope = extractReplyEnvelope(captureText, requestId);
		await finish("confirmed", envelope.reply, envelope.reason, null, 0, totalBytes, false);
	} else {
		await finish("unknown", "unknown", "cli-exit", null, outcome.code, totalBytes, false);
	}
}

try {
	await run();
} catch (error) {
	await fail(error);
}
