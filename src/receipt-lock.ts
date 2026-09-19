import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { isNativeError } from "node:util/types";
// OMP remaps bare "typebox" to its tool facade; internal schemas must match typebox/value.
import * as Type from "typebox/type";
import type { Static } from "typebox/type";
import { Check } from "typebox/value";

export interface ProcessIdentity {
	start_time: string;
	cmdline_hex: string;
}

export class LegacyLockProtocolError extends Error {}

const LockOwnerSchema = Type.Object({
	pid: Type.Integer({ minimum: 2 }),
	start_time: Type.String({ minLength: 1 }),
	cmdline_digest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
	token: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }),
}, { additionalProperties: false });

const TableColumnsSchema = Type.Array(Type.Object({
	cid: Type.Integer({ minimum: 0 }),
	name: Type.String(),
	type: Type.String(),
	notnull: Type.Integer({ minimum: 0, maximum: 1 }),
	dflt_value: Type.Union([Type.String(), Type.Null()]),
	pk: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false }));
const TableDescriptorsSchema = Type.Array(Type.Object({
	name: Type.String(),
	type: Type.String(),
	ncol: Type.Integer({ minimum: 0 }),
	wr: Type.Integer({ minimum: 0, maximum: 1 }),
	strict: Type.Integer({ minimum: 0, maximum: 1 }),
}, { additionalProperties: false }));
const LegacyRowsSchema = Type.Array(Type.Object({
	resource: Type.String(),
	pid: Type.Integer({ minimum: 2 }),
	start_time: Type.String({ minLength: 1 }),
	cmdline_hex: Type.String({ pattern: "^[0-9a-f]*$" }),
	token: Type.String(),
}, { additionalProperties: false }));

type LockOwner = Static<typeof LockOwnerSchema>;
type TableColumn = Static<typeof TableColumnsSchema>[number];

const CURRENT_COLUMNS: TableColumn[] = [
	{ cid: 0, name: "resource", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
	{ cid: 1, name: "pid", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
	{ cid: 2, name: "start_time", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
	{ cid: 3, name: "cmdline_digest", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
	{ cid: 4, name: "token", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
];
const LEGACY_COLUMNS: TableColumn[] = CURRENT_COLUMNS.map((column) => column.cid === 3
	? { ...column, name: "cmdline_hex" }
	: column);

interface LockDatabase {
	database: DatabaseSync;
	read: StatementSync;
	insert: StatementSync;
	replace: StatementSync;
	release: StatementSync;
}

const CREATE_LOCK_TABLE = `
	CREATE TABLE receipt_locks (
		resource TEXT PRIMARY KEY NOT NULL,
		pid INTEGER NOT NULL,
		start_time TEXT NOT NULL,
		cmdline_digest TEXT NOT NULL,
		token TEXT NOT NULL
	) STRICT
`;

function hasCode(error: Error, code: string): boolean {
	return "code" in error && error.code === code;
}

function isBusy(error: Error): boolean {
	return "errcode" in error && error.errcode === 5;
}

function cmdlineDigest(cmdlineHex: string): string {
	return createHash("sha256").update(cmdlineHex, "hex").digest("hex");
}

function columnsMatch(actual: TableColumn[], expected: TableColumn[]): boolean {
	return actual.length === expected.length && actual.every((column, index) => {
		const target = expected[index];
		return column.cid === target.cid && column.name === target.name && column.type === target.type &&
			column.notnull === target.notnull && column.dflt_value === target.dflt_value && column.pk === target.pk;
	});
}

function descriptorMatches(descriptors: Static<typeof TableDescriptorsSchema>): boolean {
	const descriptor = descriptors[0];
	return descriptors.length === 1 && descriptor.name === "receipt_locks" && descriptor.type === "table" &&
		descriptor.ncol === 5 && descriptor.wr === 0 && descriptor.strict === 1;
}

function assertPrivateFile(info: Awaited<ReturnType<typeof lstat>>, target: string): void {
	if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe async request lock database: ${target}`);
	if (process.getuid && info.uid !== process.getuid()) {
		throw new Error(`Async request lock database is not owned by the current user: ${target}`);
	}
	if ((Number(info.mode) & 0o077) !== 0) {
		throw new Error(`Async request lock database must not be group/world accessible: ${target}`);
	}
}

async function ensureDatabaseFile(file: string): Promise<void> {
	try {
		const handle = await open(
			file,
			fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
			0o600,
		);
		await handle.close();
	} catch (error) {
		if (!isNativeError(error) || !hasCode(error, "EEXIST")) throw error;
	}
	assertPrivateFile(await lstat(file), file);
}

async function refuseLegacyMarker(file: string): Promise<void> {
	try {
		await lstat(file);
	} catch (error) {
		if (isNativeError(error) && hasCode(error, "ENOENT")) return;
		throw new LegacyLockProtocolError(
			"Cannot verify legacy lock-marker absence; stop and drain all legacy Pi producers and runners before enabling SQLite locks",
			{ cause: error },
		);
	}
	throw new LegacyLockProtocolError(
		"Legacy lock marker detected; stop and drain all legacy Pi producers and runners before enabling SQLite locks",
	);
}

function tableKind(database: DatabaseSync): "missing" | "current" | "legacy" | "invalid" {
	const columns: unknown = database.prepare("PRAGMA table_info(receipt_locks)").all();
	const descriptors: unknown = database.prepare(
		"SELECT name, type, ncol, wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = 'receipt_locks'",
	).all();
	if (!Check(TableColumnsSchema, columns)) return "invalid";
	if (!Check(TableDescriptorsSchema, descriptors)) return "invalid";
	if (columns.length === 0 && descriptors.length === 0) return "missing";
	if (!descriptorMatches(descriptors)) return "invalid";
	if (columnsMatch(columns, CURRENT_COLUMNS)) return "current";
	if (columnsMatch(columns, LEGACY_COLUMNS)) return "legacy";
	return "invalid";
}

function migrateLegacyTable(database: DatabaseSync): void {
	const value: unknown = database.prepare("SELECT resource, pid, start_time, cmdline_hex, token FROM receipt_locks").all();
	if (!Check(LegacyRowsSchema, value)) throw new Error("Corrupt legacy async request lock table");
	database.exec("ALTER TABLE receipt_locks RENAME TO receipt_locks_legacy");
	database.exec(CREATE_LOCK_TABLE);
	const insert = database.prepare("INSERT INTO receipt_locks(resource, pid, start_time, cmdline_digest, token) VALUES (?, ?, ?, ?, ?)");
	for (const row of value) insert.run(row.resource, row.pid, row.start_time, cmdlineDigest(row.cmdline_hex), row.token);
	database.exec("DROP TABLE receipt_locks_legacy");
}

function initializeCurrentSchema(database: DatabaseSync): boolean {
	const kind = tableKind(database);
	if (kind === "invalid") throw new Error("Unsupported async request lock table schema");
	if (kind === "missing") database.exec(CREATE_LOCK_TABLE);
	if (kind === "legacy") migrateLegacyTable(database);
	if (tableKind(database) !== "current") throw new Error("Async request lock table failed schema validation");
	return kind === "legacy";
}

function initializeLockTable(database: DatabaseSync): void {
	let vacuum = false;
	database.exec("BEGIN EXCLUSIVE");
	try {
		vacuum = initializeCurrentSchema(database);
		database.exec("COMMIT");
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], "Async request lock schema initialization and rollback failed", { cause: error });
		}
		throw error;
	}
	if (vacuum) database.exec("VACUUM");
}

function openLockDatabase(file: string, timeoutMs: number): LockDatabase {
	const database = new DatabaseSync(file);
	try {
		database.exec(`PRAGMA busy_timeout = ${Math.min(timeoutMs, 250)}; PRAGMA journal_mode = DELETE; PRAGMA secure_delete = ON;`);
		initializeLockTable(database);
		return {
			database,
			read: database.prepare("SELECT pid, start_time, cmdline_digest, token FROM receipt_locks WHERE resource = ?"),
			insert: database.prepare("INSERT OR IGNORE INTO receipt_locks(resource, pid, start_time, cmdline_digest, token) VALUES (?, ?, ?, ?, ?)"),
			replace: database.prepare("UPDATE receipt_locks SET pid = ?, start_time = ?, cmdline_digest = ?, token = ? WHERE resource = ? AND token = ?"),
			release: database.prepare("DELETE FROM receipt_locks WHERE resource = ? AND token = ?"),
		};
	} catch (error) {
		database.close();
		throw error;
	}
}

async function prepareLockDatabase(file: string, deadline: number): Promise<LockDatabase> {
	while (true) {
		try {
			return openLockDatabase(file, Math.max(0, deadline - Date.now()));
		} catch (error) {
			if (!isNativeError(error) || !isBusy(error)) throw error;
			if (Date.now() >= deadline) throw new Error(`Timed out preparing async request lock database: ${file}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}

function readOwner(lock: LockDatabase, resource: string): LockOwner | null {
	const value: unknown = lock.read.get(resource);
	if (value === undefined) return null;
	if (!Check(LockOwnerSchema, value)) throw new Error("Corrupt async request lock owner");
	return value;
}

function inserted(lock: LockDatabase, resource: string, owner: LockOwner): boolean {
	return lock.insert.run(resource, owner.pid, owner.start_time, owner.cmdline_digest, owner.token).changes === 1;
}

function replaced(lock: LockDatabase, resource: string, previous: LockOwner, owner: LockOwner): boolean {
	return lock.replace.run(
		owner.pid,
		owner.start_time,
		owner.cmdline_digest,
		owner.token,
		resource,
		previous.token,
	).changes === 1;
}

export async function readProcessIdentity(
	pid: number,
): Promise<{ identity: ProcessIdentity; pgid: number } | null> {
	try {
		const statHandle = await open(`/proc/${pid}/stat`, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		const statText = await statHandle.readFile("utf8").finally(() => statHandle.close());
		const close = statText.lastIndexOf(")");
		if (close < 0) throw new Error(`Cannot parse process identity for pid ${pid}`);
		const fields = statText.slice(close + 2).trim().split(/\s+/);
		if (fields.length < 20) throw new Error(`Cannot parse process identity for pid ${pid}`);
		const commandHandle = await open(`/proc/${pid}/cmdline`, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		const command = await commandHandle.readFile().finally(() => commandHandle.close());
		return {
			identity: { start_time: fields[19], cmdline_hex: command.toString("hex") },
			pgid: Number(fields[2]),
		};
	} catch (error) {
		if (isNativeError(error) && (hasCode(error, "ENOENT") || hasCode(error, "ESRCH"))) return null;
		throw error;
	}
}

export function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
	return left.start_time === right.start_time && left.cmdline_hex === right.cmdline_hex;
}

async function ownerAlive(owner: LockOwner): Promise<boolean> {
	const current = await readProcessIdentity(owner.pid);
	return Boolean(
		current && current.identity.start_time === owner.start_time && cmdlineDigest(current.identity.cmdline_hex) === owner.cmdline_digest,
	);
}

async function tryAcquire(lock: LockDatabase, resource: string, owner: LockOwner): Promise<boolean> {
	try {
		const previous = readOwner(lock, resource);
		if (!previous) return inserted(lock, resource, owner);
		return !(await ownerAlive(previous)) && replaced(lock, resource, previous, owner);
	} catch (error) {
		if (isNativeError(error) && isBusy(error)) return false;
		throw error;
	}
}

async function acquire(lock: LockDatabase, resource: string, owner: LockOwner, deadline: number, file: string): Promise<void> {
	while (!(await tryAcquire(lock, resource, owner))) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for async request lock: ${file}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function closeDatabase(lock: LockDatabase): void {
	lock.database.close();
}

async function releaseOwner(lock: LockDatabase, resource: string, token: string, deadline: number): Promise<void> {
	while (true) {
		try {
			lock.release.run(resource, token);
			return;
		} catch (error) {
			if (!isNativeError(error) || !isBusy(error) || Date.now() >= deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}

export async function withFileLock<T>(file: string, operation: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error("Async request lock timeout must be a non-negative integer");
	await refuseLegacyMarker(file);
	const deadline = Date.now() + timeoutMs;
	const current = await readProcessIdentity(process.pid);
	if (!current) throw new Error("Cannot establish the current process identity");
	const databaseFile = path.join(path.dirname(file), ".receipt-locks.sqlite");
	await ensureDatabaseFile(databaseFile);
	const lock = await prepareLockDatabase(databaseFile, deadline);
	const resource = path.basename(file);
	const owner: LockOwner = {
		pid: process.pid,
		start_time: current.identity.start_time,
		cmdline_digest: cmdlineDigest(current.identity.cmdline_hex),
		token: randomUUID(),
	};
	try {
		await acquire(lock, resource, owner, deadline, file);
	} catch (error) {
		closeDatabase(lock);
		throw error;
	}
	const [operationOutcome] = await Promise.allSettled([
		Promise.resolve().then(() => refuseLegacyMarker(file)).then(operation),
	]);
	const [releaseOutcome] = await Promise.allSettled([
		releaseOwner(lock, resource, owner.token, Date.now() + Math.max(timeoutMs, 250)),
	]);
	const [closeOutcome] = await Promise.allSettled([Promise.resolve().then(() => closeDatabase(lock))]);
	const failures = [operationOutcome, releaseOutcome, closeOutcome]
		.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
	if (operationOutcome.status === "rejected") {
		if (failures.length > 1) {
			throw new AggregateError(failures, "Async request lock operation and cleanup failed", { cause: operationOutcome.reason });
		}
		throw operationOutcome.reason;
	}
	if (failures.length > 0) throw new AggregateError(failures, "Async request lock cleanup failed");
	return operationOutcome.value;
}
