import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSensitiveText } from "../src/output.ts";

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
