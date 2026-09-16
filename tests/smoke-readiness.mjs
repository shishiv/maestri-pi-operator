import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const checkEvents = process.argv[3];
if (!root || !checkEvents) throw new Error("usage: smoke-readiness.mjs <root> <check-events>");

const { classifyPiReadiness } = await import(pathToFileURL(`${root}/dist/readiness.js`).href);
const result = JSON.parse(readFileSync(checkEvents, "utf8"));
const now = Date.now();
const readiness = classifyPiReadiness({
	terminal_type: "pi",
	screen: result.content[0].text,
	truncated: result.details.truncated !== false,
	encoding_valid: true,
	captured_at_ms: now,
	now_ms: now,
	max_age_ms: 0,
});
if (readiness.verdict !== "ready") throw new Error(`target Pi is ${readiness.verdict}; ask was not sent`);
