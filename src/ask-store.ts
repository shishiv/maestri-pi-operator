import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	link,
	lstat,
	mkdir,
	open,
	readdir,
	rename,
	rm,
	unlink,
} from "node:fs/promises";
import path from "node:path";
import { terminalEnvelope } from "./ask-terminal.ts";

export const ASK_RAW_OUTPUT_MAX_BYTES = 1024 * 1024;
export const ASK_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const ASK_TERMINAL_RETENTION_COUNT = 200;

export type AskPhase = "accepted" | "running" | "terminal";
export type AskDelivery = "not-attempted" | "unknown" | "confirmed";
export type AskReply = "none" | "pending" | "received" | "cancelled" | "unknown";
export type AskCustody = "none" | "held" | "orphan" | "released";
export type AskNotificationState = "none" | "pending" | "dispatching" | "sent" | "acked";

export interface ProcessIdentity {
	start_time: string;
	cmdline_hex: string;
}

export interface AskRequestRecord {
	schema: 1;
	scope_key: string;
	runner_token_digest: string;
	request_id: string;
	client_request_id: string;
	agent: string;
	prompt_digest: string;
	prompt_bytes: number;
	created_at: string;
	phase: AskPhase;
	delivery: AskDelivery;
	reply: AskReply;
	custody: AskCustody;
	cleanup_deadline_ms: number | null;
	custody_reason?: string;
	notification: {
		state: AskNotificationState;
		digest: string | null;
		sent_at: string | null;
		attempts: number;
		claim: {
			pid: number;
			identity: ProcessIdentity;
		} | null;
	};
	cancel_requested_at?: string;
	runner?: {
		pid: number;
		pgid: number;
		identity: ProcessIdentity;
	};
	terminal?: {
		reason: string;
		exit_code: number | null;
		termination: "abort" | "timeout" | "output-limit" | "process-error" | "launch-unknown" | null;
		completed_at: string;
	};
	output: {
		raw_bytes: number;
		truncated: boolean;
	};
	state_version: number;
}

export interface AskRequestState {
	request_id: string;
	phase: AskPhase;
	delivery: AskDelivery;
	reply: AskReply;
	state_version: number;
}

export type AskTerminal = NonNullable<AskRequestRecord["terminal"]>;

export interface AskTerminalTransition {
	delivery: AskDelivery;
	reply: AskReply;
	reason: string;
	termination: AskTerminal["termination"];
	exitCode: number | null;
	rawBytes: number;
	truncated: boolean;
	completedAt?: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

export class AskRequestNotFoundError extends Error {}
export class AskRequestRefusalError extends Error {}

function errno(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException).code === code;
}

function assertPrivateInfo(info: Awaited<ReturnType<typeof lstat>>, target: string, directory: boolean): void {
	if ((directory && !info.isDirectory()) || (!directory && !info.isFile()) || info.isSymbolicLink()) {
		throw new Error(`Unsafe async request path: ${target}`);
	}
	if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
		throw new Error(`Async request path is not owned by the current user: ${target}`);
	}
	if ((Number(info.mode) & 0o077) !== 0) {
		throw new Error(`Async request path must not be group/world accessible: ${target}`);
	}
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	try {
		const info = await lstat(directory);
		assertPrivateInfo(info, directory, true);
		return;
	} catch (error) {
		if (!errno(error, "ENOENT")) throw error;
	}
	await mkdir(directory, { recursive: true, mode: 0o700 });
	assertPrivateInfo(await lstat(directory), directory, true);
}

export function askStateRoot(env: Environment): string {
	return path.join(askStateBase(env), "scopes", askScopeKey(env));
}

export function askStateBase(env: Environment): string {
	const base = env.XDG_STATE_HOME ?? (env.HOME ? path.join(env.HOME, ".local", "state") : undefined);
	if (!base || !path.isAbsolute(base)) {
		throw new Error("A private async request store requires an absolute XDG_STATE_HOME or HOME");
	}
	return path.join(base, "maestri-pi-operator", "ask");
}

export function askScopeKey(env: Environment): string {
	if (!env.MAESTRI_WORKSPACE_ID || !env.MAESTRI_TERMINAL_ID) {
		throw new Error("Async requests require MAESTRI_WORKSPACE_ID and MAESTRI_TERMINAL_ID");
	}
	return createHash("sha256")
		.update(env.MAESTRI_WORKSPACE_ID, "utf8")
		.update("\0")
		.update(env.MAESTRI_TERMINAL_ID, "utf8")
		.digest("hex");
}

export async function ensureAskStateRoot(env: Environment): Promise<string> {
	const base = askStateBase(env);
	const root = askStateRoot(env);
	await ensurePrivateDirectory(base);
	await ensurePrivateDirectory(path.join(base, "scopes"));
	await ensurePrivateDirectory(root);
	await ensurePrivateDirectory(path.join(root, "by-client"));
	return root;
}

export async function locateRequest(
	env: Environment,
	requestId: string,
): Promise<{ root: string; record: AskRequestRecord }> {
	const base = askStateBase(env);
	try {
		assertPrivateInfo(await lstat(base), base, true);
	} catch (error) {
		if (errno(error, "ENOENT")) throw new AskRequestNotFoundError("Async request store does not exist");
		throw new AskRequestRefusalError("Async request store is unsafe");
	}
	if (await exists(path.join(base, `${requestId}.json`))) {
		throw new AskRequestRefusalError("Refusing an unscoped legacy async request");
	}
	const scopes = path.join(base, "scopes");
	let names: string[];
	try {
		assertPrivateInfo(await lstat(scopes), scopes, true);
		names = await readdir(scopes);
	} catch (error) {
		if (errno(error, "ENOENT")) throw new AskRequestNotFoundError("Async request does not exist");
		throw new AskRequestRefusalError("Async request scope registry is unsafe");
	}
	const matches: Array<{ root: string; record: AskRequestRecord }> = [];
	for (const name of names) {
		const root = path.join(scopes, name);
		if (!(await exists(requestPath(root, requestId)))) continue;
		try {
			assertPrivateInfo(await lstat(root), root, true);
			matches.push({ root, record: await readRequest(root, requestId) });
		} catch {
			throw new AskRequestRefusalError("Async request scope or record is unsafe");
		}
	}
	if (matches.length === 0) throw new AskRequestNotFoundError("Async request does not exist");
	if (matches.length !== 1) throw new AskRequestRefusalError("Async request identity is ambiguous across scopes");
	return matches[0];
}

export function promptDigest(prompt: string): string {
	return createHash("sha256").update(prompt, "utf8").digest("hex");
}

export function clientDigest(clientRequestId: string): string {
	return createHash("sha256").update(clientRequestId, "utf8").digest("hex");
}

export function requestPath(root: string, requestId: string): string {
	return path.join(root, `${requestId}.json`);
}

export function outputPath(root: string, requestId: string): string {
	return path.join(root, `${requestId}.out`);
}

export function lockPath(root: string, requestId: string): string {
	return path.join(root, `${requestId}.lock`);
}

export function clientPath(root: string, digest: string): string {
	return path.join(root, "by-client", digest);
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, fsConstants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeTempJson(target: string, value: unknown): Promise<string> {
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(
		temporary,
		fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
		0o600,
	);
	try {
		await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	return temporary;
}

export async function atomicWriteRecord(root: string, record: AskRequestRecord): Promise<void> {
	const target = requestPath(root, record.request_id);
	const temporary = await writeTempJson(target, record);
	try {
		await rename(temporary, target);
		await syncDirectory(root);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function parseRecord(value: unknown): AskRequestRecord {
	if (!value || typeof value !== "object") throw new Error("Invalid async request record");
	const source = value as Partial<AskRequestRecord>;
	const record = {
		...source,
		custody: source.custody ?? (source.phase === "terminal" ? "released" : source.phase === "running" ? "held" : "none"),
		cleanup_deadline_ms: source.cleanup_deadline_ms ?? null,
		notification: source.notification ?? {
			state: source.phase === "terminal" ? "pending" : "none",
			digest: null,
			sent_at: null,
			attempts: 0,
			claim: null,
		},
	} as Partial<AskRequestRecord>;
	if (
		record.schema !== 1 || !isString(record.scope_key) || !isString(record.runner_token_digest) ||
		!isString(record.request_id) || !isString(record.client_request_id) ||
		!isString(record.agent) || !isString(record.prompt_digest) || typeof record.prompt_bytes !== "number" ||
		!isString(record.created_at) || !["accepted", "running", "terminal"].includes(record.phase ?? "") ||
		!["not-attempted", "unknown", "confirmed"].includes(record.delivery ?? "") ||
		!["none", "pending", "received", "cancelled", "unknown"].includes(record.reply ?? "") ||
		!["none", "held", "orphan", "released"].includes(record.custody ?? "") ||
		(record.cleanup_deadline_ms !== null && typeof record.cleanup_deadline_ms !== "number") ||
		(record.custody_reason !== undefined && !isString(record.custody_reason)) ||
		!record.notification || !["none", "pending", "dispatching", "sent", "acked"].includes(record.notification.state) ||
		(record.notification.digest !== null && !/^sha256:[0-9a-f]{64}$/.test(record.notification.digest)) ||
		(record.notification.sent_at !== null && !isString(record.notification.sent_at)) ||
		!Number.isSafeInteger(record.notification.attempts) || record.notification.attempts < 0 ||
		(record.cancel_requested_at !== undefined && !isString(record.cancel_requested_at)) ||
		!record.output || typeof record.output.raw_bytes !== "number" || typeof record.output.truncated !== "boolean" ||
		typeof record.state_version !== "number"
	) {
		throw new Error("Invalid async request record");
	}
	if (
		(record.phase === "terminal" && record.custody !== "released") ||
		(record.phase === "running" && !["held", "orphan"].includes(record.custody!)) ||
		(record.phase === "accepted" && !["none", "orphan"].includes(record.custody!))
	) {
		throw new Error("Invalid async request custody state");
	}
	if (record.notification.claim && (
		!Number.isSafeInteger(record.notification.claim.pid) || record.notification.claim.pid < 2 ||
		!isString(record.notification.claim.identity?.start_time) ||
		!isString(record.notification.claim.identity?.cmdline_hex)
	)) {
		throw new Error("Invalid async notification claim");
	}
	return record as AskRequestRecord;
}

async function readPrivateJson(file: string): Promise<unknown> {
	const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		assertPrivateInfo(info, file, false);
		if (info.size > 64 * 1024) throw new Error(`Async request record is too large: ${file}`);
		return JSON.parse(await handle.readFile("utf8"));
	} finally {
		await handle.close();
	}
}

export async function readRequest(root: string, requestId: string): Promise<AskRequestRecord> {
	const record = parseRecord(await readPrivateJson(requestPath(root, requestId)));
	if (record.request_id !== requestId) throw new Error("Async request identity mismatch");
	if (record.scope_key !== path.basename(root)) throw new Error("Async request belongs to a foreign scope");
	return record;
}

export async function readClientRequest(root: string, digest: string): Promise<AskRequestRecord | null> {
	try {
		const record = parseRecord(await readPrivateJson(clientPath(root, digest)));
		if (record.scope_key !== path.basename(root)) throw new Error("Async request belongs to a foreign scope");
		return record;
	} catch (error) {
		if (errno(error, "ENOENT")) return null;
		throw error;
	}
}

async function exists(target: string): Promise<boolean> {
	try {
		await lstat(target);
		return true;
	} catch (error) {
		if (errno(error, "ENOENT")) return false;
		throw error;
	}
}

export async function assertRequestInScope(
	env: Environment,
	identity: { requestId?: string; clientKeyDigest?: string },
): Promise<void> {
	const base = askStateBase(env);
	const root = askStateRoot(env);
	const local = identity.requestId ? requestPath(root, identity.requestId) : clientPath(root, identity.clientKeyDigest!);
	if (await exists(local)) return;
	const legacy = identity.requestId
		? path.join(base, `${identity.requestId}.json`)
		: path.join(base, "by-client", identity.clientKeyDigest!);
	if (await exists(legacy)) throw new Error("Refusing an unscoped legacy async request");
	if (!identity.requestId) return;
	const scopes = path.join(base, "scopes");
	let names: string[] = [];
	try {
		names = await readdir(scopes);
	} catch (error) {
		if (!errno(error, "ENOENT")) throw error;
	}
	for (const name of names) {
		if (name === path.basename(root)) continue;
		const foreign = path.join(scopes, name, `${identity.requestId}.json`);
		if (await exists(foreign)) throw new Error("Refusing an async request from a foreign Maestri scope");
	}
}

export async function createAcceptedRequest(
	root: string,
	record: AskRequestRecord,
	clientKeyDigest: string,
): Promise<{ record: AskRequestRecord; created: boolean }> {
	const target = requestPath(root, record.request_id);
	const temporary = await writeTempJson(target, record);
	try {
		await link(temporary, clientPath(root, clientKeyDigest));
	} catch (error) {
		await rm(temporary, { force: true });
		if (!errno(error, "EEXIST")) throw error;
		const existing = await readClientRequest(root, clientKeyDigest);
		if (!existing) throw new Error("Async request client index disappeared");
		return { record: existing, created: false };
	}
	try {
		await rename(temporary, target);
		await syncDirectory(path.join(root, "by-client"));
		await syncDirectory(root);
		return { record, created: true };
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export async function readProcessIdentity(
	pid: number,
): Promise<{ identity: ProcessIdentity; pgid: number } | null> {
	try {
		const statText = await open(`/proc/${pid}/stat`, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
			.then(async (handle) => {
				try {
					return await handle.readFile("utf8");
				} finally {
					await handle.close();
				}
			});
		const close = statText.lastIndexOf(")");
		if (close < 0) throw new Error(`Cannot parse process identity for pid ${pid}`);
		const fields = statText.slice(close + 2).trim().split(/\s+/);
		if (fields.length < 20) throw new Error(`Cannot parse process identity for pid ${pid}`);
		const cmdline = await open(`/proc/${pid}/cmdline`, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
			.then(async (handle) => {
				try {
					return await handle.readFile();
				} finally {
					await handle.close();
				}
			});
		return {
			identity: { start_time: fields[19], cmdline_hex: cmdline.toString("hex") },
			pgid: Number(fields[2]),
		};
	} catch (error) {
		if (errno(error, "ENOENT") || errno(error, "ESRCH")) return null;
		throw error;
	}
}

export function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
	return left.start_time === right.start_time && left.cmdline_hex === right.cmdline_hex;
}

async function lockOwnerAlive(file: string): Promise<boolean> {
	try {
		const owner = await readPrivateJson(file) as { pid?: unknown; identity?: unknown };
		if (typeof owner.pid !== "number" || !owner.identity || typeof owner.identity !== "object") return true;
		const current = await readProcessIdentity(owner.pid);
		return Boolean(current && sameIdentity(current.identity, owner.identity as ProcessIdentity));
	} catch (error) {
		if (errno(error, "ENOENT")) return false;
		return true;
	}
}

export async function withFileLock<T>(file: string, operation: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
	const identity = await readProcessIdentity(process.pid);
	if (!identity) throw new Error("Cannot establish the current process identity");
	const token = randomUUID();
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const temporary = await writeTempJson(file, { pid: process.pid, identity: identity.identity, token });
		try {
			await link(temporary, file);
			await rm(temporary, { force: true });
			break;
		} catch (error) {
			await rm(temporary, { force: true });
			if (!errno(error, "EEXIST")) throw error;
			if (!(await lockOwnerAlive(file))) {
				await rm(file, { force: true });
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for async request lock: ${file}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	try {
		return await operation();
	} finally {
		try {
			const owner = await readPrivateJson(file) as { token?: unknown };
			if (owner.token === token) await unlink(file);
		} catch (error) {
			if (!errno(error, "ENOENT")) throw error;
		}
	}
}

export async function withRequestLock<T>(
	root: string,
	requestId: string,
	operation: () => Promise<T>,
): Promise<T> {
	return withFileLock(lockPath(root, requestId), operation);
}

export function requestState(record: AskRequestRecord): AskRequestState {
	return {
		request_id: record.request_id,
		phase: record.phase,
		delivery: record.delivery,
		reply: record.reply,
		state_version: record.state_version,
	};
}

export function transitionRunning(
	record: AskRequestRecord,
	runner: NonNullable<AskRequestRecord["runner"]>,
	token: string,
): AskRequestRecord {
	if (record.phase !== "accepted") throw new Error("Only an accepted async request can start running");
	if (promptDigest(token) !== record.runner_token_digest) throw new Error("Runner token does not match the accepted request");
	if (record.runner && (
		record.runner.pid !== runner.pid || record.runner.pgid !== runner.pgid ||
		!sameIdentity(record.runner.identity, runner.identity)
	)) {
		throw new Error("Runner identity does not match the launched child");
	}
	return {
		...record,
		phase: "running",
		delivery: "unknown",
		reply: "pending",
		custody: "held",
		runner,
		state_version: record.state_version + 1,
	};
}

export function transitionCancelling(record: AskRequestRecord, cleanupDeadlineMs: number): AskRequestRecord {
	if (record.phase !== "running" || record.custody !== "held") {
		throw new Error("Only a running request with held custody can begin cancellation");
	}
	return {
		...record,
		cancel_requested_at: record.cancel_requested_at ?? new Date().toISOString(),
		cleanup_deadline_ms: cleanupDeadlineMs,
		state_version: record.state_version + 1,
	};
}

export function transitionOrphan(
	record: AskRequestRecord,
	reason: string,
	runner: AskRequestRecord["runner"] = record.runner,
	cleanupDeadlineMs: number | null = record.cleanup_deadline_ms,
): AskRequestRecord {
	if (record.phase === "terminal") throw new Error("A terminal async request cannot become orphaned");
	return {
		...record,
		delivery: "unknown",
		reply: "unknown",
		custody: "orphan",
		cleanup_deadline_ms: cleanupDeadlineMs,
		custody_reason: reason,
		runner,
		state_version: record.state_version + 1,
	};
}

export function transitionTerminal(
	record: AskRequestRecord,
	transition: AskTerminalTransition,
): AskRequestRecord {
	if (record.phase === "terminal") throw new Error("A terminal async request cannot transition again");
	const pair = `${transition.delivery}/${transition.reply}`;
	if (!["confirmed/received", "confirmed/unknown", "unknown/unknown", "not-attempted/none", "not-attempted/cancelled", "unknown/cancelled"].includes(pair)) {
		throw new Error(`Invalid terminal async request state pair: ${pair}`);
	}
	const { custody_reason: _custodyReason, ...retained } = record;
	const terminalRecord: AskRequestRecord = {
		...retained,
		phase: "terminal",
		delivery: transition.delivery,
		reply: transition.reply,
		custody: "released",
		cleanup_deadline_ms: null,
		terminal: {
			reason: transition.reason,
			exit_code: transition.exitCode,
			termination: transition.termination,
			completed_at: transition.completedAt ?? new Date().toISOString(),
		},
		output: { raw_bytes: transition.rawBytes, truncated: transition.truncated },
		notification: {
			state: "pending",
			digest: null,
			sent_at: null,
			attempts: 0,
			claim: null,
		},
		state_version: record.state_version + 1,
	};
	return {
		...terminalRecord,
		notification: {
			...terminalRecord.notification,
			digest: terminalEnvelope(terminalRecord).digest,
		},
	};
}

export async function createOutput(root: string, requestId: string): Promise<void> {
	const handle = await open(
		outputPath(root, requestId),
		fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
		0o600,
	);
	await handle.close();
}

export async function discardOutput(root: string, requestId: string): Promise<void> {
	try {
		const handle = await open(outputPath(root, requestId), fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
		try {
			assertPrivateInfo(await handle.stat(), outputPath(root, requestId), false);
			await handle.truncate(0);
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (!errno(error, "ENOENT")) throw error;
	}
}

export async function outputSize(root: string, requestId: string): Promise<number> {
	try {
		const handle = await open(outputPath(root, requestId), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		try {
			const info = await handle.stat();
			assertPrivateInfo(info, outputPath(root, requestId), false);
			return Number(info.size);
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (errno(error, "ENOENT")) return 0;
		throw error;
	}
}

export async function readOutput(root: string, requestId: string): Promise<Buffer> {
	try {
		const handle = await open(outputPath(root, requestId), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		try {
			const info = await handle.stat();
			assertPrivateInfo(info, outputPath(root, requestId), false);
			if (Number(info.size) > ASK_RAW_OUTPUT_MAX_BYTES) {
				throw new Error("Persisted async output exceeds the raw output limit");
			}
			return await handle.readFile();
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (errno(error, "ENOENT")) return Buffer.alloc(0);
		throw error;
	}
}

export async function listRequests(root: string): Promise<AskRequestRecord[]> {
	const records: AskRequestRecord[] = [];
	for (const name of await readdir(root)) {
		if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
		records.push(await readRequest(root, name.slice(0, -5)));
	}
	return records;
}

export async function pruneTerminalRequests(root: string, now = Date.now()): Promise<void> {
	const terminal = (await listRequests(root))
		.filter((record) => record.phase === "terminal")
		.sort((left, right) => Date.parse(right.terminal?.completed_at ?? right.created_at) - Date.parse(left.terminal?.completed_at ?? left.created_at));
	for (let index = 0; index < terminal.length; index += 1) {
		const record = terminal[index];
		const completed = Date.parse(record.terminal?.completed_at ?? record.created_at);
		if (index < ASK_TERMINAL_RETENTION_COUNT && now - completed <= ASK_TERMINAL_RETENTION_MS) continue;
		await withRequestLock(root, record.request_id, async () => {
			const current = await readRequest(root, record.request_id);
			if (current.phase !== "terminal") return;
			await rm(clientPath(root, clientDigest(current.client_request_id)), { force: true });
			await rm(outputPath(root, current.request_id), { force: true });
			await rm(requestPath(root, current.request_id), { force: true });
		});
	}
}
