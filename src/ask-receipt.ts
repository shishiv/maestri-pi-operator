import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const PhaseSchema = Type.Union([Type.Literal("accepted"), Type.Literal("running"), Type.Literal("terminal")]);
const DeliverySchema = Type.Union([Type.Literal("not-attempted"), Type.Literal("unknown"), Type.Literal("confirmed")]);
const ReplySchema = Type.Union([
	Type.Literal("none"),
	Type.Literal("pending"),
	Type.Literal("received"),
	Type.Literal("cancelled"),
	Type.Literal("unknown"),
]);
const CustodySchema = Type.Union([Type.Literal("none"), Type.Literal("held"), Type.Literal("orphan"), Type.Literal("released")]);
const NotificationStateSchema = Type.Union([
	Type.Literal("none"),
	Type.Literal("pending"),
	Type.Literal("dispatching"),
	Type.Literal("sent"),
	Type.Literal("acked"),
]);
const TerminationSchema = Type.Union([
	Type.Literal("abort"),
	Type.Literal("timeout"),
	Type.Literal("output-limit"),
	Type.Literal("process-error"),
	Type.Literal("launch-unknown"),
	Type.Null(),
]);
const IdentitySchema = Type.Object({
	start_time: Type.String({ minLength: 1 }),
	cmdline_hex: Type.String({ pattern: "^[0-9a-f]*$" }),
}, { additionalProperties: false });
const RunnerSchema = Type.Object({
	pid: Type.Integer({ minimum: 2 }),
	pgid: Type.Integer({ minimum: 1 }),
	identity: IdentitySchema,
}, { additionalProperties: false });
const LegacyRunnerSchema = Type.Object({
	pid: Type.Integer({ minimum: 2 }),
	pgid: Type.Integer({ minimum: 1 }),
	identity: IdentitySchema,
	started_at: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
const TerminalSchema = Type.Object({
	reason: Type.String({ minLength: 1 }),
	exit_code: Type.Union([Type.Integer(), Type.Null()]),
	termination: TerminationSchema,
	completed_at: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
const OutputSchema = Type.Object({
	raw_bytes: Type.Integer({ minimum: 0 }),
	truncated: Type.Boolean(),
}, { additionalProperties: false });
const NotificationSchema = Type.Object({
	state: NotificationStateSchema,
	digest: Type.Union([Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }), Type.Null()]),
	sent_at: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
	attempts: Type.Integer({ minimum: 0 }),
	claim: Type.Union([
		Type.Object({ pid: Type.Integer({ minimum: 2 }), identity: IdentitySchema }, { additionalProperties: false }),
		Type.Null(),
	]),
}, { additionalProperties: false });

const SharedProperties = {
	schema: Type.Literal(1),
	scope_key: Type.String({ pattern: "^[0-9a-f]{64}$" }),
	runner_token_digest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
	request_id: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }),
	client_request_id: Type.String({ minLength: 1 }),
	agent: Type.String({ minLength: 1 }),
	prompt_digest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
	prompt_bytes: Type.Integer({ minimum: 0 }),
	created_at: Type.String({ minLength: 1 }),
	phase: PhaseSchema,
	delivery: DeliverySchema,
	reply: ReplySchema,
	cancel_requested_at: Type.Optional(Type.String({ minLength: 1 })),
	runner: Type.Optional(RunnerSchema),
	terminal: Type.Optional(TerminalSchema),
	output: OutputSchema,
	state_version: Type.Integer({ minimum: 1 }),
};

const CurrentRecordSchema = Type.Object({
	...SharedProperties,
	custody: CustodySchema,
	cleanup_deadline_ms: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
	custody_reason: Type.Optional(Type.String({ minLength: 1 })),
	notification: NotificationSchema,
}, { additionalProperties: false });

const LegacySharedProperties = {
	...SharedProperties,
	runner: Type.Optional(LegacyRunnerSchema),
};
const LegacyCustodyProperties = {
	...LegacySharedProperties,
	custody: CustodySchema,
	cleanup_deadline_ms: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
	custody_reason: Type.Optional(Type.String({ minLength: 1 })),
};
const LegacyRecordSchema = Type.Object(LegacySharedProperties, { additionalProperties: false });
const LegacyCustodyRecordSchema = Type.Object(LegacyCustodyProperties, { additionalProperties: false });
const LegacyNotificationRecordSchema = Type.Object({
	...LegacyCustodyProperties,
	notification: NotificationSchema,
}, { additionalProperties: false });

export type AskRequestRecord = Static<typeof CurrentRecordSchema>;
type LegacyRecord = Static<typeof LegacyRecordSchema>;
type LegacyCustodyRecord = Static<typeof LegacyCustodyRecordSchema>;
type LegacyNotificationRecord = Static<typeof LegacyNotificationRecordSchema>;

const TERMINAL_PAIRS = new Set([
	"confirmed/received",
	"confirmed/unknown",
	"unknown/unknown",
	"not-attempted/none",
	"not-attempted/cancelled",
	"unknown/cancelled",
]);

function validTimestamp(value: string): boolean {
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function assertTimestamps(record: AskRequestRecord): void {
	if (!validTimestamp(record.created_at)) throw new Error("Invalid async request creation timestamp");
	if (record.cancel_requested_at && !validTimestamp(record.cancel_requested_at)) {
		throw new Error("Invalid async request cancellation timestamp");
	}
	if (record.notification.sent_at && !validTimestamp(record.notification.sent_at)) {
		throw new Error("Invalid async request notification timestamp");
	}
	if (record.terminal && !validTimestamp(record.terminal.completed_at)) {
		throw new Error("Invalid async request completion timestamp");
	}
}

function assertTerminalReceipt(record: AskRequestRecord): void {
	if (record.phase === "terminal" && (!record.terminal || record.custody !== "released")) {
		throw new Error("Invalid terminal async request receipt");
	}
	if (record.phase !== "terminal" && record.terminal) throw new Error("Non-terminal async request contains a terminal result");
}

function assertActiveReceipt(record: AskRequestRecord): void {
	if (record.phase === "running" && (!record.runner || !["held", "orphan"].includes(record.custody))) {
		throw new Error("Invalid running async request receipt");
	}
	if (record.phase === "accepted" && (record.terminal || !["none", "orphan"].includes(record.custody))) {
		throw new Error("Invalid accepted async request receipt");
	}
}

function assertCustodyReason(record: AskRequestRecord): void {
	if (record.custody === "orphan" && !record.custody_reason) throw new Error("Orphan async request lacks a custody reason");
	if (record.custody !== "orphan" && record.custody_reason) throw new Error("Non-orphan async request contains a custody reason");
}

function assertStatePairs(record: AskRequestRecord): void {
	const acceptedPair = record.custody === "orphan" ? "unknown/unknown" : "not-attempted/none";
	if (record.phase === "accepted" && `${record.delivery}/${record.reply}` !== acceptedPair) {
		throw new Error("Invalid accepted async request state pair");
	}
	if (record.phase === "running" && (record.delivery === "not-attempted" || !["pending", "unknown", "cancelled"].includes(record.reply))) {
		throw new Error("Invalid running async request state pair");
	}
	if (record.phase === "terminal" && !TERMINAL_PAIRS.has(`${record.delivery}/${record.reply}`)) {
		throw new Error("Invalid terminal async request state pair");
	}
}

function assertNotification(record: AskRequestRecord): void {
	if (record.phase === "terminal" && record.notification.state === "none") {
		throw new Error("Terminal async request lacks notification state");
	}
	if (record.phase !== "terminal" && record.notification.state !== "none") {
		throw new Error("Only terminal async requests can carry notification state");
	}
	if (record.notification.state === "none" && hasNotificationMetadata(record)) {
		throw new Error("Empty async notification state contains delivery metadata");
	}
}

function assertDeliveredNotification(record: AskRequestRecord): void {
	if (record.notification.state === "sent" && (!record.notification.digest || !record.notification.sent_at)) {
		throw new Error("Delivered async notification lacks delivery metadata");
	}
	if (record.notification.state === "acked" && !record.notification.digest) {
		throw new Error("Acknowledged async notification lacks its digest");
	}
}

function hasNotificationMetadata(record: AskRequestRecord): boolean {
	return Boolean(
		record.notification.digest || record.notification.sent_at || record.notification.claim || record.notification.attempts !== 0,
	);
}

export function validateAskRequestRecord(record: AskRequestRecord): AskRequestRecord {
	if (!Check(CurrentRecordSchema, record)) throw new Error("Invalid async request record");
	assertTimestamps(record);
	assertTerminalReceipt(record);
	assertActiveReceipt(record);
	assertCustodyReason(record);
	assertStatePairs(record);
	assertNotification(record);
	assertDeliveredNotification(record);
	return record;
}

function currentRunner(runner: LegacyRecord["runner"]): AskRequestRecord["runner"] {
	if (!runner) return undefined;
	return { pid: runner.pid, pgid: runner.pgid, identity: runner.identity };
}

function defaultNotification(phase: AskRequestRecord["phase"]): AskRequestRecord["notification"] {
	return {
		state: phase === "terminal" ? "pending" : "none",
		digest: null,
		sent_at: null,
		attempts: 0,
		claim: null,
	};
}

function normalizeLegacy(record: LegacyRecord): AskRequestRecord {
	return {
		...record,
		runner: currentRunner(record.runner),
		custody: record.phase === "terminal" ? "released" : record.phase === "running" ? "held" : "none",
		cleanup_deadline_ms: null,
		notification: defaultNotification(record.phase),
	};
}

function normalizeLegacyCustody(record: LegacyCustodyRecord): AskRequestRecord {
	return { ...record, runner: currentRunner(record.runner), notification: defaultNotification(record.phase) };
}

function normalizeLegacyRunner(record: LegacyNotificationRecord): AskRequestRecord {
	return { ...record, runner: currentRunner(record.runner) };
}

export function parseAskRequestRecord(text: string): AskRequestRecord {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Corrupt async request record JSON");
	}
	if (Check(CurrentRecordSchema, value)) return validateAskRequestRecord(value);
	if (Check(LegacyNotificationRecordSchema, value)) return validateAskRequestRecord(normalizeLegacyRunner(value));
	if (Check(LegacyCustodyRecordSchema, value)) return validateAskRequestRecord(normalizeLegacyCustody(value));
	if (Check(LegacyRecordSchema, value)) return validateAskRequestRecord(normalizeLegacy(value));
	throw new Error("Invalid async request record");
}
