import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isNativeError } from "node:util/types";

const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));

async function validationFixture(t: TestContext, directory: "src" | "dist") {
	const home = await mkdtemp(path.join(tmpdir(), "mpo-validation-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const extension = directory === "src" ? "ts" : "js";
	// Relative static imports keep every validator in the real OMP loader's extension graph.
	const modules = `./${path.relative(home, path.join(repository, directory))}`;
	const fixture = path.join(home, "validate.mjs");
	await writeFile(fixture, `
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseAskRequestRecord, validateAskRequestRecord } from ${JSON.stringify(`${modules}/ask-receipt.${extension}`)};
import { withFileLock } from ${JSON.stringify(`${modules}/receipt-lock.${extension}`)};
import { registerMaestriOperatorCommand } from ${JSON.stringify(`${modules}/operator-command.${extension}`)};

const record = {
	schema: 1,
	scope_key: "a".repeat(64),
	runner_token_digest: "b".repeat(64),
	request_id: "2cab27c7-c836-4d2d-8de3-69886d5cfa83",
	client_request_id: "review",
	agent: "Review",
	prompt_digest: "c".repeat(64),
	prompt_bytes: 10,
	created_at: "2026-09-18T00:00:00.000Z",
	phase: "accepted",
	delivery: "not-attempted",
	reply: "none",
	output: { raw_bytes: 0, truncated: false },
	state_version: 1,
	custody: "none",
	cleanup_deadline_ms: null,
	notification: { state: "none", digest: null, sent_at: null, attempts: 0, claim: null },
};
assert.deepEqual(validateAskRequestRecord(record), record);
assert.deepEqual(parseAskRequestRecord(JSON.stringify(record)), record);
for (const [name, invalid] of [
	["invalid scope", { ...record, scope_key: "INVALID" }],
	["invalid agent", { ...record, agent: 42 }],
	["invalid nested output", { ...record, output: { raw_bytes: -1, truncated: false } }],
	["unknown property", { ...record, extra: true }],
]) {
	assert.throws(() => validateAskRequestRecord(invalid), /Invalid async request record/, name);
	assert.throws(() => parseAskRequestRecord(JSON.stringify(invalid)), /Invalid async request record/, name);
}

const lockFile = path.join(process.cwd(), "request.lock");
let protectedOperations = 0;
async function protectedOperation() {
	protectedOperations++;
	return "protected";
}
assert.equal(await withFileLock(lockFile, protectedOperation), "protected");
const database = new DatabaseSync(path.join(process.cwd(), ".receipt-locks.sqlite"));
try {
	const insert = database.prepare("INSERT INTO receipt_locks(resource, pid, start_time, cmdline_digest, token) VALUES (?, ?, ?, ?, ?)");
	const token = "b169b04c-44c0-4d4a-847a-d72b3fc8c01e";
	insert.run("request.lock", 2147483647, "stale", "d".repeat(64), token);
	assert.equal(await withFileLock(lockFile, protectedOperation), "protected");
	assert.equal(database.prepare("SELECT count(*) AS count FROM receipt_locks").get().count, 0);
	insert.run("request.lock", 2147483647, "stale", "INVALID", token);
	await assert.rejects(withFileLock(lockFile, protectedOperation), /Corrupt async request lock owner/);
	assert.equal(protectedOperations, 2, "a corrupt owner must not enter the protected operation");
	const retained = database.prepare("SELECT cmdline_digest, token FROM receipt_locks WHERE resource = ?").get("request.lock");
	assert.equal(retained.cmdline_digest, "INVALID", "a corrupt owner must not be replaced or deleted");
	assert.equal(retained.token, token);
} finally {
	database.close();
}

const entries = [
	{ type: "custom_message", customType: "mpo.maestri-operator", details: null },
	{ type: "custom_message", customType: "mpo.maestri-operator" },
	{ type: "custom_message", customType: "mpo.maestri-operator", details: { digest: 42 } },
];
const commands = new Map();
const messages = [];
const notices = [];
registerMaestriOperatorCommand({
	registerCommand(name, command) { commands.set(name, command); },
	sendMessage(message, options) {
		messages.push({ message, options });
		entries.push({ type: "custom_message", ...message });
	},
});
const context = {
	sessionManager: { getEntries: () => entries },
	ui: { notify(message, level) { notices.push({ message, level }); } },
};
const command = commands.get("maestri-operator");
await command.handler("Inspect isolated transport", context);
assert.equal(messages.length, 1, "malformed invocation details must not block new guidance");
assert.match(messages[0].message.content, /Task: Inspect isolated transport$/);
assert.deepEqual(messages[0].options, { deliverAs: "followUp", triggerTurn: true });
await command.handler("  Inspect isolated transport  ", context);
assert.equal(messages.length, 1, "valid invocation details must prevent duplicate guidance");
assert.equal(notices.length, 1);
assert.equal(notices[0].level, "info");
await command.handler("Inspect a different request", context);
assert.equal(messages.length, 2);
assert.match(messages[1].message.content, /Task: Inspect a different request$/);
console.log("receipt, lock and invocation validation passed");
`);
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		XDG_CONFIG_HOME: path.join(home, "config"),
		XDG_CACHE_HOME: path.join(home, "cache"),
		XDG_DATA_HOME: path.join(home, "data"),
		XDG_STATE_HOME: path.join(home, "state"),
		PI_CODING_AGENT_DIR: path.join(home, "omp"),
		BUN_INSTALL_CACHE_DIR: path.join(home, "bun-cache"),
	};
	return { home, fixture, env };
}

test("Node validates receipt, lock and invocation boundaries in source and built artifacts", { timeout: 30_000 }, async (t) => {
	for (const directory of ["src", "dist"] as const) {
		await t.test(directory, async (subtest) => {
			const { home, fixture, env } = await validationFixture(subtest, directory);
			const result = await exec(process.execPath, [fixture], { cwd: home, env, timeout: 10_000 });
			assert.equal(result.stdout.trim(), "receipt, lock and invocation validation passed");
		});
	}
});

test("OMP's real loader validates the same receipt, lock and invocation boundaries", { timeout: 60_000 }, async (t) => {
	const packageRoot = process.env.MPO_OMP_PACKAGE_ROOT;
	if (!packageRoot) {
		t.skip("Set MPO_OMP_PACKAGE_ROOT to an installed OMP package; the real-loader regression also requires Bun");
		return;
	}
	try {
		await exec("bun", ["--version"], { timeout: 5_000 });
	} catch (error) {
		if (isNativeError(error) && "code" in error && error.code === "ENOENT") {
			t.skip("Bun is not available on PATH; the real OMP loader cannot run");
			return;
		}
		throw error;
	}
	const loader = path.join(path.resolve(packageRoot), "src/extensibility/plugins/legacy-pi-compat.ts");
	await access(loader);
	for (const directory of ["src", "dist"] as const) {
		await t.test(directory, async (subtest) => {
			const { home, fixture, env } = await validationFixture(subtest, directory);
			const driver = path.join(home, "omp-driver.mjs");
			await writeFile(driver, `
import { loadLegacyPiModule } from ${JSON.stringify(pathToFileURL(loader).href)};
await loadLegacyPiModule(${JSON.stringify(fixture)});
process.exit(0);
`);
			const result = await exec("bun", [driver], { cwd: home, env, timeout: 25_000 });
			assert.equal(result.stdout.trim(), "receipt, lock and invocation validation passed");
		});
	}
});
