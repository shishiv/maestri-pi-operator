import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { isNativeError } from "node:util/types";
import {
	link,
	lstat,
	mkdir,
	open,
	readdir,
	rename,
	rm,
} from "node:fs/promises";
import path from "node:path";
import {
	parseAskRequestRecord,
	validateAskRequestRecord,
	type AskRequestRecord,
} from "./ask-receipt.ts";
import { terminalEnvelope } from "./ask-terminal.ts";
import {
	sameIdentity,
	withFileLock,
} from "./receipt-lock.ts";

export {
	LegacyLockProtocolError,
	readProcessIdentity,
	sameIdentity,
	withFileLock,
	type ProcessIdentity,
} from "./receipt-lock.ts";
export type { AskRequestRecord } from "./ask-receipt.ts";

export const ASK_RAW_OUTPUT_MAX_BYTES = 1024 * 1024;
export const ASK_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const ASK_TERMINAL_RETENTION_COUNT = 200;

export type AskPhase = AskRequestRecord["phase"];
export type AskDelivery = AskRequestRecord["delivery"];
export type AskReply = AskRequestRecord["reply"];
export type AskCustody = AskRequestRecord["custody"];
export type AskNotificationState = AskRequestRecord["notification"]["state"];

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

interface RequestPaths {
	base: string;
	root: string;
}

export class AskRequestNotFoundError extends Error {}
export class AskRequestRefusalError extends Error {}

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errno(error: Error, code: string): boolean {
	return "code" in error && error.code === code;
}

function assertPrivateInfo(info: Awaited<ReturnType<typeof lstat>>, target: string, directory: boolean): void {
	if ((directory && !info.isDirectory()) || (!directory && !info.isFile()) || info.isSymbolicLink()) {
		throw new Error(`Unsafe async request path: ${target}`);
	}
	const uid = process.getuid?.();
	if (uid !== undefined && info.uid !== uid) {
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
		if (!isNativeError(error) || !errno(error, "ENOENT")) throw error;
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

function lookupPaths(env: Environment): RequestPaths {
	try {
		return { base: askStateBase(env), root: askStateRoot(env) };
	} catch {
		throw new AskRequestRefusalError("Async request lookup requires a valid workspace and terminal context");
	}
}

async function assertLookupBase(base: string): Promise<void> {
	try {
		assertPrivateInfo(await lstat(base), base, true);
	} catch (error) {
		if (isNativeError(error) && errno(error, "ENOENT")) throw new AskRequestNotFoundError("Async request store does not exist");
		throw new AskRequestRefusalError("Async request store is unsafe");
	}
}

async function assertLookupRegistry(base: string): Promise<string> {
	const scopes = path.join(base, "scopes");
	try {
		assertPrivateInfo(await lstat(scopes), scopes, true);
		return scopes;
	} catch (error) {
		if (isNativeError(error) && errno(error, "ENOENT")) throw new AskRequestNotFoundError("Async request scope registry does not exist");
		throw new AskRequestRefusalError("Async request scope registry is unsafe");
	}
}

async function assertNoLegacyRequest(base: string, requestId: string): Promise<void> {
	try {
		if (await exists(path.join(base, `${requestId}.json`))) {
			throw new AskRequestRefusalError("Refusing an unscoped legacy async request");
		}
	} catch (error) {
		if (error instanceof AskRequestRefusalError) throw error;
		throw new AskRequestRefusalError("Async request legacy store is unsafe");
	}
}

export async function locateRequest(
	env: Environment,
	requestId: string,
): Promise<{ root: string; record: AskRequestRecord }> {
	const { base, root } = lookupPaths(env);
	if (!REQUEST_ID_PATTERN.test(requestId)) throw new AskRequestRefusalError("Async request lookup requires a valid request UUID");
	await assertLookupBase(base);
	const scopes = await assertLookupRegistry(base);
	await assertNoLegacyRequest(base, requestId);
	try {
		assertPrivateInfo(await lstat(root), root, true);
		return { root, record: await readRequest(root, requestId) };
	} catch (error) {
		if (isNativeError(error) && errno(error, "ENOENT")) {
			if (await foreignRequestExists(scopes, root, requestId)) {
				throw new AskRequestRefusalError("Refusing an async request from a foreign Maestri scope");
			}
			throw new AskRequestNotFoundError("Async request does not exist in this Maestri scope");
		}
		throw new AskRequestRefusalError("Async request scope or record is unsafe");
	}
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

function prunePath(root: string, requestId: string): string {
	return path.join(root, `${requestId}.prune`);
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, fsConstants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeTempRecord(target: string, record: AskRequestRecord): Promise<string> {
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(
		temporary,
		fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
		0o600,
	);
	try {
		await handle.writeFile(`${JSON.stringify(validateAskRequestRecord(record))}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	return temporary;
}

export async function atomicWriteRecord(root: string, record: AskRequestRecord): Promise<void> {
	if (record.scope_key !== path.basename(root)) throw new Error("Async request belongs to a foreign scope");
	const target = requestPath(root, record.request_id);
	const temporary = await writeTempRecord(target, record);
	try {
		await rename(temporary, target);
		await syncDirectory(root);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

async function readPrivateRecord(file: string): Promise<AskRequestRecord> {
	const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		assertPrivateInfo(info, file, false);
		if (info.size > 64 * 1024) throw new Error(`Async request record is too large: ${file}`);
		return parseAskRequestRecord(await handle.readFile("utf8"));
	} finally {
		await handle.close();
	}
}

export async function readRequest(root: string, requestId: string): Promise<AskRequestRecord> {
	const record = await readPrivateRecord(requestPath(root, requestId));
	if (record.request_id !== requestId) throw new Error("Async request identity mismatch");
	if (record.scope_key !== path.basename(root)) throw new Error("Async request belongs to a foreign scope");
	return record;
}

export async function readClientRequest(root: string, digest: string): Promise<AskRequestRecord | null> {
	try {
		const record = await readPrivateRecord(clientPath(root, digest));
		if (record.scope_key !== path.basename(root)) throw new Error("Async request belongs to a foreign scope");
		if (clientDigest(record.client_request_id) !== digest) throw new Error("Async request client index identity mismatch");
		return record;
	} catch (error) {
		if (isNativeError(error) && errno(error, "ENOENT")) return null;
		throw error;
	}
}

async function exists(target: string): Promise<boolean> {
	try {
		await lstat(target);
		return true;
	} catch (error) {
		if (isNativeError(error) && errno(error, "ENOENT")) return false;
		throw error;
	}
}

async function foreignRequestExists(scopes: string, localRoot: string, requestId: string): Promise<boolean> {
	try {
		for (const name of await readdir(scopes)) {
			if (name === path.basename(localRoot)) continue;
			if (!/^[0-9a-f]{64}$/.test(name)) throw new AskRequestRefusalError("Async request scope registry contains an invalid entry");
			const foreignRoot = path.join(scopes, name);
			assertPrivateInfo(await lstat(foreignRoot), foreignRoot, true);
			if (await exists(path.join(foreignRoot, `${requestId}.json`))) return true;
		}
		return false;
	} catch (error) {
		if (isNativeError(error) && errno(error, "ENOENT")) return false;
		throw new AskRequestRefusalError("Async request scope registry is unsafe");
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
	if (identity.requestId && await foreignRequestExists(await assertLookupRegistry(base), root, identity.requestId)) {
		throw new Error("Refusing an async request from a foreign Maestri scope");
	}
}

export async function createAcceptedRequest(
	root: string,
	record: AskRequestRecord,
	clientKeyDigest: string,
): Promise<{ record: AskRequestRecord; created: boolean }> {
	validateAskRequestRecord(record);
	if (record.scope_key !== path.basename(root)) throw new Error("Async request belongs to a foreign scope");
	if (clientKeyDigest !== clientDigest(record.client_request_id)) throw new Error("Async request client index digest mismatch");
	const target = requestPath(root, record.request_id);
	const temporary = await writeTempRecord(target, record);
	try {
		await link(temporary, clientPath(root, clientKeyDigest));
	} catch (error) {
		await rm(temporary, { force: true });
		if (!isNativeError(error) || !errno(error, "EEXIST")) throw error;
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

export async function withRequestLock<T>(
	root: string,
	requestId: string,
	operation: () => Promise<T>,
): Promise<T> {
	return withFileLock(lockPath(root, requestId), operation);
}

export type AskRequestTransition = (
	current: Readonly<AskRequestRecord>,
) => AskRequestRecord | Promise<AskRequestRecord>;

export type AskRequestTransaction = (
	current: Readonly<AskRequestRecord>,
) => AskRequestRecord | null | Promise<AskRequestRecord | null>;

function immutableReceiptHeader(record: AskRequestRecord): readonly (number | string)[] {
	return [
		record.schema,
		record.scope_key,
		record.request_id,
		record.client_request_id,
		record.runner_token_digest,
		record.agent,
		record.prompt_digest,
		record.prompt_bytes,
		record.created_at,
	];
}

function terminalFacts(record: AskRequestRecord) {
	const { notification: _notification, ...facts } = record;
	return facts;
}

function notificationStateCanAdvance(current: AskRequestRecord, next: AskRequestRecord): boolean {
	if (current.notification.state === "acked") return next.notification.state === "acked";
	return ["pending", "dispatching", "sent", "acked"].includes(next.notification.state);
}

function validNotificationUpdate(current: AskRequestRecord, next: AskRequestRecord): boolean {
	const attempts = next.notification.attempts - current.notification.attempts;
	if (attempts < 0 || attempts > 1) return false;
	if (next.notification.state === "acked" && next.notification.claim) return false;
	return notificationStateCanAdvance(current, next);
}

function validNotificationDigest(current: AskRequestRecord, next: AskRequestRecord): boolean {
	if (next.notification.digest === current.notification.digest) return true;
	return next.notification.digest === terminalEnvelope(current).digest;
}

function isNotificationTransaction(current: AskRequestRecord, next: AskRequestRecord): boolean {
	if (current.phase !== "terminal" || next.state_version !== current.state_version) return false;
	if (!validNotificationDigest(current, next)) return false;
	return validNotificationUpdate(current, next) && isDeepStrictEqual(terminalFacts(current), terminalFacts(next));
}

export function transactRequest(
	root: string,
	requestId: string,
	transition: AskRequestTransition,
): Promise<AskRequestRecord>;
export function transactRequest(
	root: string,
	requestId: string,
	transition: AskRequestTransaction,
): Promise<AskRequestRecord | null>;
export async function transactRequest(
	root: string,
	requestId: string,
	transition: AskRequestTransaction,
): Promise<AskRequestRecord | null> {
	return withRequestLock(root, requestId, async () => {
		const current = await readRequest(root, requestId);
		const proposal = await transition(structuredClone(current));
		if (proposal === null) return null;
		const next = validateAskRequestRecord(structuredClone(proposal));
		if (immutableReceiptHeader(next).some((value, index) => value !== immutableReceiptHeader(current)[index])) {
			throw new Error("Async request transaction cannot change the immutable receipt header");
		}
		if (isNotificationTransaction(current, next)) {
			await atomicWriteRecord(root, next);
			return next;
		}
		if (current.phase === "terminal") throw new Error("Terminal async request facts are immutable");
		if (next.state_version !== current.state_version + 1) {
			throw new Error("Async request transaction must increment state_version exactly once");
		}
		await atomicWriteRecord(root, next);
		return next;
	});
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
		if (!isNativeError(error) || !errno(error, "ENOENT")) throw error;
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
		if (isNativeError(error) && errno(error, "ENOENT")) return 0;
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
		if (isNativeError(error) && errno(error, "ENOENT")) return Buffer.alloc(0);
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

async function removePrunedReceipt(root: string, requestId: string): Promise<void> {
	const tombstone = prunePath(root, requestId);
	const record = await readPrivateRecord(tombstone);
	if (record.request_id !== requestId || record.scope_key !== path.basename(root)) {
		throw new Error("Invalid pruned async request identity");
	}
	const digest = clientDigest(record.client_request_id);
	const indexed = await readClientRequest(root, digest);
	if (indexed?.request_id === requestId) await rm(clientPath(root, digest), { force: true });
	await rm(outputPath(root, requestId), { force: true });
	await syncDirectory(path.join(root, "by-client"));
	await syncDirectory(root);
	await rm(tombstone, { force: true });
	await syncDirectory(root);
}

async function recoverPrunedReceipts(root: string): Promise<void> {
	for (const name of await readdir(root)) {
		if (!/^[0-9a-f-]{36}\.prune$/i.test(name)) continue;
		const requestId = name.slice(0, -6);
		await withRequestLock(root, requestId, () => removePrunedReceipt(root, requestId));
	}
}

function completedAt(record: AskRequestRecord): number {
	return Date.parse(record.terminal?.completed_at ?? record.created_at);
}

async function pruneReceipt(root: string, requestId: string): Promise<void> {
	return withRequestLock(root, requestId, async () => {
		let current: AskRequestRecord;
		try {
			current = await readRequest(root, requestId);
		} catch (error) {
			if (isNativeError(error) && errno(error, "ENOENT")) return;
			throw error;
		}
		if (current.phase !== "terminal") return;
		await rename(requestPath(root, requestId), prunePath(root, requestId));
		await syncDirectory(root);
		await removePrunedReceipt(root, requestId);
	});
}

export async function pruneTerminalRequests(root: string, now = Date.now()): Promise<void> {
	await recoverPrunedReceipts(root);
	const terminal = (await listRequests(root))
		.filter((record) => record.phase === "terminal")
		.sort((left, right) => completedAt(right) - completedAt(left));
	for (let index = 0; index < terminal.length; index += 1) {
		const record = terminal[index];
		const completed = completedAt(record);
		if (index < ASK_TERMINAL_RETENTION_COUNT && now - completed <= ASK_TERMINAL_RETENTION_MS) continue;
		await pruneReceipt(root, record.request_id);
	}
}
