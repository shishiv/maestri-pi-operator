import { createHash } from "node:crypto";
import type { AskRequestRecord } from "./ask-store.ts";

export const ASK_TERMINAL_ENVELOPE_SCHEMA = "mpo.ask-terminal.v1";
export const ASK_TERMINAL_ENVELOPE_MAX_BYTES = 4 * 1024;

export interface AskTerminalEnvelope {
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
	output: {
		raw_bytes: number;
		truncated: boolean;
		extracted: boolean;
	};
	digest: string;
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
			.map(([key, child]) => [key, canonicalValue(child)]),
	);
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalValue(value));
}

export function terminalEnvelope(record: AskRequestRecord): AskTerminalEnvelope {
	if (record.phase !== "terminal" || !record.terminal) throw new Error("Async request is not terminal");
	if (!Number.isSafeInteger(record.state_version) || !Number.isSafeInteger(record.output.raw_bytes)) {
		throw new Error("Async terminal envelope requires integer state and output counters");
	}
	const unsigned = {
		schema: ASK_TERMINAL_ENVELOPE_SCHEMA,
		request_id: record.request_id,
		workspace_scope: record.scope_key,
		agent: record.agent,
		phase: "terminal" as const,
		delivery: record.delivery,
		reply: record.reply,
		reason: record.terminal.reason,
		exit_code: record.terminal.exit_code,
		termination: record.terminal.termination,
		completed_at: record.terminal.completed_at,
		state_version: record.state_version,
		output: {
			raw_bytes: record.output.raw_bytes,
			truncated: record.output.truncated,
			extracted: record.reply === "received",
		},
	} satisfies Omit<AskTerminalEnvelope, "digest">;
	const envelope: AskTerminalEnvelope = {
		...unsigned,
		digest: `sha256:${createHash("sha256").update(canonicalJson(unsigned), "utf8").digest("hex")}`,
	};
	if (Buffer.byteLength(canonicalJson(envelope), "utf8") > ASK_TERMINAL_ENVELOPE_MAX_BYTES) {
		throw new Error("Async terminal envelope exceeds its output limit");
	}
	return envelope;
}
