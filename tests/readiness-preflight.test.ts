import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertReadyPiScreen } from "../src/ask-async.ts";

test("async preflight accepts the real idle capture but rejects an active shell after it", () => {
	const capture = readFileSync(new URL("./fixtures/readiness/nexo-idle.txt", import.meta.url), "utf8");
	assert.doesNotThrow(() => assertReadyPiScreen(capture));
	for (const prompt of ["user@host:~/repo $", "PS C:\\repo>"]) {
		assert.throws(() => assertReadyPiScreen(`${capture}\n${prompt}`),
			/The target is missing, ambiguous, or not a ready Pi; no async request was launched/);
	}
});
