import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPiReadiness, type ReadinessSnapshot } from "../src/readiness.ts";
import { replyEnvelope } from "../src/reply-envelope.ts";
import { assertReadyPiScreen, PreflightError } from "../src/ask-async.ts";

function snapshot(overrides: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot {
	return {
		terminal_type: "pi",
		screen: "~/repo\n0.0%/1.0M  GPT-5.6 Sol • high",
		truncated: false,
		encoding_valid: true,
		captured_at_ms: 1_000,
		now_ms: 1_010,
		max_age_ms: 1_000,
		...overrides,
	};
}

test("accepts only current idle Pi footers including off and minimal thinking", () => {
	assert.deepEqual(classifyPiReadiness(snapshot({ screen: "\u001b[2m~/repo GPT-5.6 Luna • off\u001b[0m" })), {
		verdict: "ready",
		footer: "full",
		model: "Luna",
		thinking: "off",
		evidence: "~/repo GPT-5.6 Luna • off",
	});
	assert.deepEqual(classifyPiReadiness(snapshot({ screen: "GPT-5.6 Terra • minimal" })), {
		verdict: "ready",
		footer: "minimal",
		model: "Terra",
		thinking: "minimal",
		evidence: "GPT-5.6 Terra • minimal",
	});
	assert.deepEqual(classifyPiReadiness(snapshot({ screen: "GPT-5.6 Sol • thinking off" })), {
		verdict: "ready",
		footer: "thinking-off",
		model: "Sol",
		thinking: "off",
		evidence: "GPT-5.6 Sol • thinking off",
	});
	assert.equal(classifyPiReadiness(snapshot({ screen: "GPT-5.6 Sol • thinking high" })).verdict, "unsupported");
	const astraFooter = "0.0%/1.1M (auto)  gpt-6-astra • low";
	assert.deepEqual(classifyPiReadiness(snapshot({ screen: astraFooter })), {
		verdict: "ready",
		footer: "full",
		model: "Astra",
		thinking: "low",
		evidence: astraFooter,
	});
	assert.deepEqual(classifyPiReadiness(snapshot({ screen: "GPT-6 Astra • high" })), {
		verdict: "ready",
		footer: "minimal",
		model: "Astra",
		thinking: "high",
		evidence: "GPT-6 Astra • high",
	});
	assert.deepEqual(classifyPiReadiness(snapshot({ screen: "0.0%/1.1M (auto) claude-opus-5 • high" })), {
		verdict: "ready", footer: "full", model: "Opus", thinking: "high", evidence: "0.0%/1.1M (auto) claude-opus-5 • high",
	});
});

test("does not broaden the model allowlist beyond the captured Opus identity", () => {
	for (const model of ["claude-opus-5.1", "claude-sonnet-4", "gpt-7-astra"]) {
		assert.deepEqual(classifyPiReadiness(snapshot({ screen: `${model} • high` })), { verdict: "unsupported", reason: "unknown-surface" });
	}
});

test("preflight keeps the legacy refusal text and exposes sanitized structured diagnostics", () => {
	assert.throws(() => assertReadyPiScreen("⠴ Working\nclaude-opus-5 • high"), (error: unknown) => {
		assert.ok(error instanceof PreflightError);
		assert.equal(error.message, "The target Pi is busy; no async request was launched");
		assert.deepEqual(error.preflight, { stage: "readiness", reason: "busy", request_created: false });
		return true;
	});
	assert.throws(() => assertReadyPiScreen("claude-opus-5.1 • high"), (error: unknown) => {
		assert.ok(error instanceof PreflightError);
		assert.equal(error.message, "The target is missing, ambiguous, or not a ready Pi; no async request was launched");
		assert.deepEqual(error.preflight, { stage: "readiness", reason: "unknown-surface", request_created: false });
		return true;
	});
});

test("accepts provider model IDs rendered by explicit Pi model arguments", () => {
	for (const [id, model] of [["gpt-5.6-luna", "Luna"], ["gpt-5.6-terra", "Terra"], ["gpt-5.6-sol", "Sol"]] as const) {
		const footer = `0.0%/1.1M (auto) ${id} • low`;
		const result = classifyPiReadiness(snapshot({ screen: evalScreen("Codex adapter V: low", "", "~", footer) }));
		assert.equal(result.verdict, "ready", id);
		if (result.verdict === "ready") assert.deepEqual([result.model, result.thinking], [model, "low"]);
	}
});

// Captured in the canvas eval before observer.ts's setStatus was removed.
const evalFooter = "0.0%/1.1M (auto)                                                     gpt-6-astra • low";
const evalBorder = "─".repeat(86);
function evalScreen(status: string, draft = "", cwd = "~/maestri-pi-operator (feat/ask-async)", footer = evalFooter): string {
	return `${evalBorder}\n${draft}\n${evalBorder}\n${cwd}\n${footer}\n${status}`;
}

test("accepts one status line based on the empty composer layout, not its text", () => {
	for (const status of ["", "Workspace indexed", "Review mode · enabled", "arbitrary text", "native · native", "cli-a · skill-cli", "cli-b · skill-cli"]) {
		const result = classifyPiReadiness(snapshot({ screen: evalScreen(status) }));
		assert.equal(result.verdict, "ready", status);
		if (result.verdict === "ready") assert.equal(result.evidence, evalFooter);
	}
});

test("status support cannot hide drafts, busy, shells, truncation, or multiple trailing lines", () => {
	for (const screen of [
		evalScreen("native · native", "unsent prompt"),
		evalScreen("", "unsent prompt"),
		evalScreen("native · native", "first line\nsecond line"),
		evalScreen("native · native\nunknown extension status"),
		evalScreen("native · native\nnative · native"),
		`${evalFooter}\nnative · native`,
		evalScreen("native · native").replace(evalFooter, `${evalFooter} garbage`),
		evalScreen("native · native").replace(evalFooter, "gpt-6-astra garbage"),
		evalScreen("native · native").replace(evalFooter, `${evalFooter}\nGPT-6 Astra • high`),
		evalScreen("native · native\nuser@host:~/repo $"),
		evalScreen("native · native\nPS C:\\repo>"),
		evalScreen("native · native\n⠴ Working"),
		`⠴ Working\n${evalScreen("native · native")}`,
	]) assert.notEqual(classifyPiReadiness(snapshot({ screen })).verdict, "ready", screen);
	assert.equal(classifyPiReadiness(snapshot({ screen: evalScreen("native · native"), truncated: true })).verdict, "unsupported");
	assert.equal(classifyPiReadiness(snapshot({ screen: evalScreen("native · native"), terminal_type: "shell" })).verdict, "unsupported");
});

test("does not mistake a draft separator for the structural composer border", () => {
	for (const status of ["", "Workspace indexed"]) {
		for (const draft of ["unsent task\n───\n", ` unsent task\n ${evalBorder}\n `]) {
			assert.notEqual(classifyPiReadiness(snapshot({ screen: evalScreen(status, draft) })).verdict, "ready");
		}
	}
});

test("accepts the Pi footer when the working directory is HOME", () => {
	for (const cwd of ["~", "~ (main)", "~ • named session", "~ (main) • named session"]) {
		for (const status of ["", "Workspace indexed"]) {
			assert.equal(classifyPiReadiness(snapshot({ screen: evalScreen(status, "", cwd) })).verdict, "ready", `${cwd} / ${status}`);
		}
	}
});

test("rejects a status tail without a complete empty composer and directory layout", () => {
	for (const status of ["Workspace indexed", "Review mode · enabled"]) {
		for (const screen of [
			`${evalFooter}\n${status}`,
			`${evalBorder}\n\n~/repo\n${evalFooter}\n${status}`,
			`${evalBorder}\n${evalBorder}\n~/repo\n${evalFooter}\n${status}`,
			`${evalBorder}\n\n${evalBorder}\n${evalFooter}\n${status}`,
			`${evalBorder}\n\n${evalBorder}\nnot a directory\n${evalFooter}\n${status}`,
			`${evalBorder}\n\n${evalBorder}\n~/repo\nextra line\n${evalFooter}\n${status}`,
			evalScreen(`${status}\nadditional status`),
			evalScreen(status, "unsent draft"),
			evalScreen("⠴ Working"),
			evalScreen("user@host:~/repo $"),
			evalScreen("GPT-6 Astra • high"),
		]) assert.notEqual(classifyPiReadiness(snapshot({ screen })).verdict, "ready", screen);
	}
});

test("rejects unsupported, incomplete, blank, and stale captures before content claims", () => {
	assert.deepEqual(classifyPiReadiness(snapshot({ terminal_type: "shell" })), {
		verdict: "unsupported",
		reason: "unsupported-terminal-type",
	});
	assert.deepEqual(classifyPiReadiness(snapshot({ screen: null })), {
		verdict: "unsupported",
		reason: "no-capture",
	});
	assert.deepEqual(classifyPiReadiness(snapshot({ truncated: true })), {
		verdict: "unsupported",
		reason: "truncated",
	});
	assert.deepEqual(classifyPiReadiness(snapshot({ encoding_valid: false })), {
		verdict: "unsupported",
		reason: "non-utf8",
	});
	assert.deepEqual(classifyPiReadiness(snapshot({ screen: "\u001b[0m \n\r" })), { verdict: "blank" });
	assert.deepEqual(classifyPiReadiness(snapshot({ captured_at_ms: 1_000, now_ms: 2_001 })), {
		verdict: "stale",
		age_ms: 1_001,
	});
	assert.equal(classifyPiReadiness(snapshot({ captured_at_ms: 2_000, now_ms: 1_000 })).verdict, "stale");
});

test("completed async envelopes do not turn an idle Pi into a shell or hide real shell and busy signals", () => {
	const { begin, end } = replyEnvelope("26cf35dd-810f-4390-b7f0-8ec1d6d8f196");
	const reply = `${begin}\nACK:live-transport\n${end}`;
	const footer = "↑970 ↓101 $0.015 0.1%/1.1M (auto) gpt-6-astra • low";
	assert.equal(classifyPiReadiness(snapshot({ screen: `${reply}\n${footer}` })).verdict, "ready");
	assert.equal(classifyPiReadiness(snapshot({ screen: `${reply}\n⠴ Working\n${footer}` })).verdict, "busy");
	assert.equal(classifyPiReadiness(snapshot({ screen: `${reply}\nuser@host:~/repo $\n${footer}` })).verdict, "ambiguous");
	assert.equal(classifyPiReadiness(snapshot({ screen: `${reply}\nPS C:\\repo>\n${footer}` })).verdict, "ambiguous");
	for (const malformed of ["<<<MAESTRI_REPLY_END:not-an-id>>>", `${end} >`, "<html>"]) {
		assert.equal(classifyPiReadiness(snapshot({ screen: `${malformed}\n${footer}` })).verdict, "ambiguous");
	}
});

test("rejects busy, ambiguous, shell, stale-looking, and unknown Pi surfaces", () => {
	assert.deepEqual(classifyPiReadiness(snapshot({
		screen: "⠴ Working\nGPT-5.6 Sol • high",
	})), { verdict: "busy", evidence: "⠴ Working" });
	assert.equal(classifyPiReadiness(snapshot({
		screen: "Retrying request\nGPT-5.6 Sol • high",
	})).verdict, "busy");
	assert.equal(classifyPiReadiness(snapshot({
		screen: "Press Esc\nGPT-5.6 Sol • high",
	})).verdict, "busy");
	assert.equal(classifyPiReadiness(snapshot({
		screen: "GPT-5.6 Sol • low\nGPT-5.6 Sol • high",
	})).verdict, "ambiguous");
	assert.equal(classifyPiReadiness(snapshot({
		screen: "GPT-5.6 Sol • high\nuser@host:~/repo $",
	})).verdict, "ambiguous");
	assert.deepEqual(classifyPiReadiness(snapshot({ screen: "user@host:~/repo$" })), {
		verdict: "shell",
		evidence: "user@host:~/repo$",
	});
	assert.deepEqual(classifyPiReadiness(snapshot({
		screen: "GPT-5.6 Sol • high\nold transcript after footer",
	})), { verdict: "unsupported", reason: "unknown-surface" });
	assert.deepEqual(classifyPiReadiness(snapshot({ screen: "connected terminal" })), {
		verdict: "unsupported",
		reason: "unknown-surface",
	});
	assert.equal(classifyPiReadiness(snapshot({ screen: "⠴ Working\ngpt-6-astra • low" })).verdict, "busy");
	assert.equal(classifyPiReadiness(snapshot({ screen: "gpt-6-astra • low\nuser@host:~/repo $" })).verdict, "ambiguous");
	assert.equal(classifyPiReadiness(snapshot({ screen: "GPT-5.6 Sol • low\ngpt-6-astra • low" })).verdict, "ambiguous");
	for (const label of ["GPT-5.6 Astra", "GPT-6 Sol", "Astra"]) {
		assert.equal(classifyPiReadiness(snapshot({ screen: label + " • low" })).verdict, "unsupported");
	}
});
