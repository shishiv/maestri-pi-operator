import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPiReadiness, type ReadinessSnapshot } from "../src/readiness.ts";
import { replyEnvelope } from "../src/reply-envelope.ts";

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
