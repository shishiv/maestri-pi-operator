import { stripVTControlCharacters } from "node:util";
import { isReplyEnvelopeMarker } from "./reply-envelope.ts";

export type TerminalType = "pi" | "shell" | "other" | "unknown";
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ReadyFooter = "full" | "minimal" | "thinking-off";
export type UnsupportedReason =
	| "no-capture"
	| "truncated"
	| "non-utf8"
	| "unsupported-terminal-type"
	| "unknown-surface";

export interface ReadinessSnapshot {
	terminal_type: TerminalType;
	screen: string | null;
	truncated: boolean;
	encoding_valid: boolean;
	captured_at_ms: number;
	now_ms: number;
	max_age_ms: number;
}

export type Readiness =
	| {
		verdict: "ready";
		footer: ReadyFooter;
		model: "Luna" | "Terra" | "Sol" | "Astra";
		thinking: PiThinkingLevel;
		evidence: string;
	}
	| { verdict: "busy"; evidence: string }
	| { verdict: "shell"; evidence: string }
	| { verdict: "ambiguous"; evidence: string }
	| { verdict: "blank" }
	| { verdict: "stale"; age_ms: number }
	| { verdict: "unsupported"; reason: UnsupportedReason };

const PI_FOOTER = /(?:^|\s)(GPT-5\.6\s+(?:Luna|Terra|Sol)|GPT-6\s+Astra|gpt-6-astra)\s+•\s+(?:(thinking)\s+(off)|(off|minimal|low|medium|high|xhigh|max))\s*$/;
const BUSY = [
	/^\s*[\u2800-\u28ff]?\s*Working(?:\.\.\.)?(?:\s*\([^)]*\))?\s*$/i,
	/\b(?:esc|escape|ctrl-c)\s+to\s+(?:interrupt|cancel)\b/i,
	/\bpress\s+esc\b/i,
	/^\s*(?:Auto-)?compacting(?: context)?\.\.\./i,
	/^\s*Retrying\b/i,
	/^\s*Summarizing branch\.\.\./i,
	/\bRunning tool\b/i,
	/^\s*Running\.\.\.\s*\(/i,
];
const SHELL_PROMPT = /^(?:PS\s+)?[^\r\n]*(?:[#$%>]|❯|➜)\s*$/;

function normalizeScreen(screen: string): string {
	return stripVTControlCharacters(screen)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "")
		.replace(/[\u0085\u2028\u2029]/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
		.replace(/\p{Cf}/gu, "");
}

function staleAge(snapshot: ReadinessSnapshot): number | null {
	const values = [snapshot.captured_at_ms, snapshot.now_ms, snapshot.max_age_ms];
	const age = snapshot.now_ms - snapshot.captured_at_ms;
	if (values.some((value) => !Number.isFinite(value)) || snapshot.captured_at_ms < 0 || snapshot.now_ms < 0 || snapshot.max_age_ms < 0) {
		return Number.isFinite(age) ? age : -1;
	}
	return age < 0 || age > snapshot.max_age_ms ? age : null;
}

export function classifyPiReadiness(snapshot: ReadinessSnapshot): Readiness {
	if (snapshot.screen === null) return { verdict: "unsupported", reason: "no-capture" };
	if (snapshot.truncated) return { verdict: "unsupported", reason: "truncated" };
	if (!snapshot.encoding_valid) return { verdict: "unsupported", reason: "non-utf8" };
	if (snapshot.terminal_type !== "pi") return { verdict: "unsupported", reason: "unsupported-terminal-type" };

	const age = staleAge(snapshot);
	if (age !== null) return { verdict: "stale", age_ms: age };

	const lines = normalizeScreen(snapshot.screen)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return { verdict: "blank" };

	const footers = lines.flatMap((line) => {
		const match = line.match(PI_FOOTER);
		return match ? [{ line, match }] : [];
	});
	// Our reply delimiters end in '>' but are transcript content, not shell prompts.
	const shellLines = lines.filter((line) => !isReplyEnvelopeMarker(line) && SHELL_PROMPT.test(line));
	if (footers.length > 1 || (footers.length > 0 && shellLines.length > 0)) {
		return { verdict: "ambiguous", evidence: [...footers.map(({ line }) => line), ...shellLines].join("\n") };
	}

	const busy = lines.slice(-12).find((line) => BUSY.some((pattern) => pattern.test(line)));
	if (busy) return { verdict: "busy", evidence: busy };

	const last = lines.at(-1) as string;
	if (SHELL_PROMPT.test(last)) return { verdict: "shell", evidence: last };
	const footer = footers[0];
	if (!footer || footer.line !== last) return { verdict: "unsupported", reason: "unknown-surface" };

	const model = (footer.match[1] === "gpt-6-astra"
		? "Astra"
		: footer.match[1].split(/\s+/).at(-1)) as Extract<Readiness, { verdict: "ready" }>["model"];
	const thinking = (footer.match[3] ?? footer.match[4]) as PiThinkingLevel;
	const format: ReadyFooter = footer.match[2] ? "thinking-off" : footer.match.index === 0 ? "minimal" : "full";
	return { verdict: "ready", footer: format, model, thinking, evidence: footer.line };
}
