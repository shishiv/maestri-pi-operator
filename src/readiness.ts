import { normalizeUntrustedText } from "./output.ts";
import { isReplyEnvelopeMarker } from "./reply-envelope.ts";

export type TerminalType = "pi" | "shell" | "other" | "unknown";
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ReadyFooter = "full" | "minimal" | "thinking-off";
export type UnsupportedReason =
	| "no-capture"
	| "truncated"
	| "non-utf8"
	| "unsupported-terminal-type"
	| "unsupported-model"
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
		model: "Luna" | "Terra" | "Sol" | "Astra" | "Opus";
		thinking: PiThinkingLevel;
		evidence: string;
	}
	| { verdict: "busy"; evidence: string }
	| { verdict: "shell"; evidence: string }
	| { verdict: "ambiguous"; evidence: string }
	| { verdict: "blank" }
	| { verdict: "stale"; age_ms: number }
	| { verdict: "unsupported"; reason: UnsupportedReason };

const PI_FOOTER = /(?:^|\s)(gpt-5\.6(?:\s+|-)(?:luna|terra|sol)|gpt-6(?:\s+|-)astra|claude-opus-5)\s+•\s+(?:(thinking)\s+(off)|(off|minimal|low|medium|high|xhigh|max))\s*$/i;
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
const COMPOSER_BORDER = /^─{3,}\s*$/;
const WORKING_DIRECTORY = /^(?:~(?:$|\/|\s+(?:\(|•))|\/)/;

interface PiFooter {
	line: string;
	model: Extract<Readiness, { verdict: "ready" }>["model"];
	thinking: PiThinkingLevel;
	format: ReadyFooter;
}

interface ScreenAnalysis {
	rawLines: string[];
	screenLines: string[];
	lines: string[];
	footers: PiFooter[];
	shellLines: string[];
}

type SnapshotCheck = { screen: string } | { outcome: Readiness };

function thinkingLevel(value: string | undefined): PiThinkingLevel | null {
	switch (value?.toLowerCase()) {
		case "off":
			return "off";
		case "minimal":
			return "minimal";
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return "xhigh";
		case "max":
			return "max";
		default:
			return null;
	}
}

function modelName(modelId: string): PiFooter["model"] {
	if (modelId.endsWith("luna")) return "Luna";
	if (modelId.endsWith("terra")) return "Terra";
	if (modelId.endsWith("sol")) return "Sol";
	if (modelId === "claude-opus-5") return "Opus";
	return "Astra";
}

function parseFooter(line: string): PiFooter | null {
	const match = PI_FOOTER.exec(line);
	if (!match) return null;
	const modelId = match[1];
	const thinking = thinkingLevel(match[3] ?? match[4]);
	if (!modelId || !thinking) return null;
	return {
		line,
		model: modelName(modelId.toLowerCase()),
		thinking,
		format: match[2] ? "thinking-off" : match.index === 0 ? "minimal" : "full",
	};
}

function staleAge(snapshot: ReadinessSnapshot): number | null {
	const values = [snapshot.captured_at_ms, snapshot.now_ms, snapshot.max_age_ms];
	const age = snapshot.now_ms - snapshot.captured_at_ms;
	if (values.some((value) => !Number.isFinite(value)) || snapshot.captured_at_ms < 0 || snapshot.now_ms < 0 || snapshot.max_age_ms < 0) {
		return Number.isFinite(age) ? age : -1;
	}
	return age < 0 || age > snapshot.max_age_ms ? age : null;
}

function checkSnapshot(snapshot: ReadinessSnapshot): SnapshotCheck {
	if (snapshot.screen === null) return { outcome: { verdict: "unsupported", reason: "no-capture" } };
	if (snapshot.truncated) return { outcome: { verdict: "unsupported", reason: "truncated" } };
	if (!snapshot.encoding_valid) return { outcome: { verdict: "unsupported", reason: "non-utf8" } };
	if (snapshot.terminal_type !== "pi") {
		return { outcome: { verdict: "unsupported", reason: "unsupported-terminal-type" } };
	}
	const age = staleAge(snapshot);
	return age === null ? { screen: snapshot.screen } : { outcome: { verdict: "stale", age_ms: age } };
}

function analyzeScreen(screen: string): ScreenAnalysis {
	const rawLines = normalizeUntrustedText(screen).split("\n");
	const screenLines = rawLines.map((line) => line.trim());
	const lines = screenLines.filter(Boolean);
	const footers = lines.flatMap((line) => {
		const footer = parseFooter(line);
		return footer ? [footer] : [];
	});
	const footer = footers[0];
	const footerIndex = footer ? screenLines.indexOf(footer.line) : -1;
	const trailing = screenLines.slice(footerIndex + 1).filter(Boolean);
	const beforeFooter = screenLines.slice(0, footerIndex);
	const borders = composerBorderIndices(rawLines, footerIndex);
	const composerStart = footer && trailing.length <= 1 && hasEmptyComposer(rawLines, beforeFooter, borders)
		? borders.at(-2)
		: undefined;
	// Only a complete empty composer can exclude shell-like transcript history.
	const activeLines = composerStart === undefined ? lines : screenLines.slice(composerStart).filter(Boolean);
	// Our reply delimiters end in '>' but are transcript content, not shell prompts.
	const shellLines = activeLines.filter((line) => !isReplyEnvelopeMarker(line) && SHELL_PROMPT.test(line));
	return { rawLines, screenLines, lines, footers, shellLines };
}

function activityOutcome(analysis: ScreenAnalysis): Readiness | null {
	if (analysis.footers.length > 1 || (analysis.footers.length > 0 && analysis.shellLines.length > 0)) {
		return {
			verdict: "ambiguous",
			evidence: [...analysis.footers.map(({ line }) => line), ...analysis.shellLines].join("\n"),
		};
	}
	const busy = analysis.lines.slice(-12).find((line) => BUSY.some((pattern) => pattern.test(line)));
	if (busy) return { verdict: "busy", evidence: busy };
	const last = analysis.lines.at(-1);
	return last && SHELL_PROMPT.test(last) ? { verdict: "shell", evidence: last } : null;
}

function composerBorderIndices(rawLines: string[], footerIndex: number): number[] {
	return rawLines.slice(0, footerIndex).flatMap((line, index) => COMPOSER_BORDER.test(line) ? [index] : []);
}

function hasEmptyComposer(
	rawLines: string[],
	beforeFooter: string[],
	borderIndices: number[],
): boolean {
	const bottom = borderIndices.at(-1);
	const top = borderIndices.at(-2);
	if (top === undefined || bottom === undefined || bottom <= top + 1) return false;
	const topBorder = rawLines[top];
	const bottomBorder = rawLines[bottom];
	if (topBorder === undefined || bottomBorder === undefined || topBorder.trimEnd() !== bottomBorder.trimEnd()) return false;
	if (beforeFooter.slice(top + 1, bottom).some(Boolean)) return false;
	const belowComposer = beforeFooter.slice(bottom + 1).filter(Boolean);
	return belowComposer.length === 1 && WORKING_DIRECTORY.test(belowComposer[0] ?? "");
}

function supportsFooterLayout(analysis: ScreenAnalysis, footer: PiFooter): boolean {
	const footerIndex = analysis.screenLines.indexOf(footer.line);
	if (footerIndex < 0) return false;
	const trailing = analysis.screenLines.slice(footerIndex + 1).filter(Boolean);
	if (trailing.length > 1) return false;
	const beforeFooter = analysis.screenLines.slice(0, footerIndex);
	const borderIndices = composerBorderIndices(analysis.rawLines, footerIndex);
	const requiresComposer = beforeFooter.some((line) => COMPOSER_BORDER.test(line)) || trailing.length > 0;
	return !requiresComposer || hasEmptyComposer(analysis.rawLines, beforeFooter, borderIndices);
}

export function classifyPiReadiness(snapshot: ReadinessSnapshot): Readiness {
	const checked = checkSnapshot(snapshot);
	if ("outcome" in checked) return checked.outcome;

	const analysis = analyzeScreen(checked.screen);
	if (analysis.lines.length === 0) return { verdict: "blank" };
	const activity = activityOutcome(analysis);
	if (activity) return activity;
	const footer = analysis.footers[0];
	if (!footer) return { verdict: "unsupported", reason: "unknown-surface" };
	// A status tail is accepted only when the empty composer and directory are structurally present.
	if (!supportsFooterLayout(analysis, footer)) return { verdict: "unsupported", reason: "unknown-surface" };
	return {
		verdict: "ready",
		footer: footer.format,
		model: footer.model,
		thinking: footer.thinking,
		evidence: footer.line,
	};
}
