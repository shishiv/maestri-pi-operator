import { createHash } from "node:crypto";
import type { AskRequestRecord } from "./ask-store.ts";
import { redactSensitiveText } from "./output.ts";

export const ASK_TERMINAL_ENVELOPE_SCHEMA = "mpo.ask-terminal.v1";
export const ASK_TERMINAL_ENVELOPE_MAX_BYTES = 4 * 1024;

export type CanonicalJsonPrimitive = string | number | boolean | null;

export interface CanonicalJsonObject {
	readonly [key: string]: CanonicalJsonValue;
}

export type CanonicalJsonValue = CanonicalJsonPrimitive | readonly CanonicalJsonValue[] | CanonicalJsonObject;

export interface AskTerminalOutput extends CanonicalJsonObject {
	raw_bytes: number;
	truncated: boolean;
	extracted: boolean;
}

export interface AskTerminalUnsignedEnvelope extends CanonicalJsonObject {
	schema: typeof ASK_TERMINAL_ENVELOPE_SCHEMA;
	request_id: string;
	workspace_scope: string;
	agent: string;
	phase: "terminal";
	delivery: AskRequestRecord["delivery"];
	reply: AskRequestRecord["reply"];
	reason: string;
	exit_code: number | null;
	termination: NonNullable<AskRequestRecord["terminal"]>["termination"];
	completed_at: string;
	state_version: number;
	output: AskTerminalOutput;
}

export interface AskTerminalEnvelope extends AskTerminalUnsignedEnvelope {
	digest: string;
}

export interface AskTerminalFollowup extends CanonicalJsonObject {
	schema: "mpo.ask-terminal-followup.v1";
	request_id: string;
	digest: string;
	next_action: string;
}

function isJsonObject(value: CanonicalJsonValue): value is CanonicalJsonObject {
	return value !== null && !Array.isArray(value) && Object(value) === value;
}

function canonicalValue(value: CanonicalJsonValue): CanonicalJsonValue {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!isJsonObject(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
			.map(([key, child]) => [key, canonicalValue(child)]),
	);
}

export function canonicalJson(value: CanonicalJsonValue): string {
	return JSON.stringify(canonicalValue(value));
}

export function sanitizeTerminalReason(reason: string): string {
	const normalized = redactSensitiveText(reason, {});
	const sanitized = Array.from(normalized).slice(0, 160).join("").trim();
	return sanitized || "unknown";
}

export function terminalEnvelope(record: AskRequestRecord): AskTerminalEnvelope {
	if (record.phase !== "terminal" || !record.terminal) throw new Error("Async request is not terminal");
	if (!Number.isSafeInteger(record.state_version) || !Number.isSafeInteger(record.output.raw_bytes)) {
		throw new Error("Async terminal envelope requires integer state and output counters");
	}
	const unsigned: AskTerminalUnsignedEnvelope = {
		schema: ASK_TERMINAL_ENVELOPE_SCHEMA,
		request_id: record.request_id,
		workspace_scope: record.scope_key,
		agent: record.agent,
		phase: "terminal",
		delivery: record.delivery,
		reply: record.reply,
		reason: sanitizeTerminalReason(record.terminal.reason),
		exit_code: record.terminal.exit_code,
		termination: record.terminal.termination,
		completed_at: record.terminal.completed_at,
		state_version: record.state_version,
		output: {
			raw_bytes: record.output.raw_bytes,
			truncated: record.output.truncated,
			extracted: record.reply === "received",
		},
	} satisfies AskTerminalUnsignedEnvelope;
	const envelope: AskTerminalEnvelope = {
		...unsigned,
		digest: `sha256:${createHash("sha256").update(canonicalJson(unsigned), "utf8").digest("hex")}`,
	};
	if (Buffer.byteLength(canonicalJson(envelope), "utf8") > ASK_TERMINAL_ENVELOPE_MAX_BYTES) {
		throw new Error("Async terminal envelope exceeds its output limit");
	}
	return envelope;
}
