import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeUntrustedText, redactSensitiveText } from "../src/output.ts";

test("normalizes line separators and removes unsafe controls without damaging UTF-8 text", () => {
	const controls = [0x00, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0x7f, 0x80, 0x9f]
		.map((code) => String.fromCharCode(code))
		.join("");
	assert.equal(
		normalizeUntrustedText(`á😀\t\r\n${controls}\u0085\u2028\u2029\u202eok`),
		"á😀\t\n\n\n\nok",
	);
});

test("preserves shell working-directory paths in references without exposing password variables", () => {
	const env = {
		PWD: "/project/current", OLDPWD: "/project/previous",
		MYSQL_PWD: "private-mysql-password", PWD_SECRET: "private-pwd-secret",
		MAESTRI_TOKEN: "private-maestri-token",
	};
	const text = "[Source](file:///project/current/guide.md)\nPWD=/project/current\nOLDPWD=/project/previous\n" +
		"MYSQL_PWD=private-mysql-password\nPWD_SECRET=private-pwd-secret\nMAESTRI_TOKEN=private-maestri-token";
	assert.equal(redactSensitiveText(text, env),
		"[Source](file:///project/current/guide.md)\nPWD=/project/current\nOLDPWD=/project/previous\n" +
		"MYSQL_PWD=[REDACTED]\nPWD_SECRET=[REDACTED]\nMAESTRI_TOKEN=[REDACTED]");
	assert.equal(redactSensitiveText("/project/current", { ...env, API_KEY: env.PWD }), "[REDACTED]");
});
