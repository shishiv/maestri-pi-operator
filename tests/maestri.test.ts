import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
	MAESTRI_ASK_TIMEOUT_MS,
	MAESTRI_CHECK_TIMEOUT_MS,
	MAESTRI_LIST_TIMEOUT_MS,
	type MaestriExecOptions,
	type MaestriExecResult,
	formatMaestriOutput,
	invokeMaestriOutcome,
	maestriCliEnvironment,
	registerMaestriTools,
	resolveMaestriCli,
	runBoundedProcess,
} from "../src/maestri.ts";
import { createPiToolHarness } from "./support/pi-tools.ts";

type ExecCall = { command: string; args: string[]; options: MaestriExecOptions };

async function fixture(t: TestContext) {
	const dir = await mkdtemp(path.join(tmpdir(), "maestri-pi-v01-"));
	const cli = path.join(dir, "maestri");
	await writeFile(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	await chmod(cli, 0o700);
	t.after(async () => rm(dir, { recursive: true, force: true }));
	return { dir, cli };
}

async function rejection(operation: Promise<object>): Promise<Error> {
	try {
		await operation;
	} catch (error) {
		assert.ok(error instanceof Error);
		return error;
	}
	throw new Error("expected operation to reject");
}

function makeHarness(
	cli: string,
	result: MaestriExecResult = {
		stdout: "ok\n",
		stderr: "",
		code: 0,
		killed: false,
		termination: null,
		totalOutputBytes: 3,
	},
) {
	const calls: ExecCall[] = [];
	const harness = createPiToolHarness("/tmp/project");
	registerMaestriTools(harness.registrar, {
		env: {
			PATH: path.dirname(cli),
			MAESTRI_CLI: cli,
			MAESTRI_WORKSPACE_ID: "workspace-for-test",
			MAESTRI_SOCKET: "/tmp/private-maestri-test.sock",
		},
		platform: "linux",
		execute: async (command, args, options) => {
			calls.push({ command, args, options });
			return result;
		},
	});
	return { calls, invoke: harness.invoke };
}

test("resolves an executable absolute MAESTRI_CLI and falls back to PATH", async (t) => {
	const { dir, cli } = await fixture(t);
	assert.equal(await resolveMaestriCli({ MAESTRI_CLI: cli, PATH: "" }, "linux"), cli);
	assert.equal(
		await resolveMaestriCli({ MAESTRI_CLI: "relative/maestri", PATH: dir }, "linux"),
		cli,
	);
	await assert.rejects(resolveMaestriCli({ PATH: "" }, "linux"), /CLI is unavailable/);
});

test("registers exactly the three synchronous transport tools", async (t) => {
	const { cli } = await fixture(t);
	const harness = createPiToolHarness("/tmp/project");
	registerMaestriTools(harness.registrar, {
		env: {
			MAESTRI_CLI: cli,
			MAESTRI_WORKSPACE_ID: "workspace",
			MAESTRI_SOCKET: "/tmp/socket",
		},
		platform: "linux",
	});
	assert.deepEqual(harness.registeredNames(), ["maestri_list", "maestri_check", "maestri_ask"]);
});

test("fails closed on unsupported platforms before resolving or spawning", async (t) => {
	const { cli } = await fixture(t);
	await assert.rejects(resolveMaestriCli({ MAESTRI_CLI: cli }, "win32"), /Linux only/);
	await assert.rejects(
		runBoundedProcess(cli, [], {
			cwd: "/tmp",
			env: { PATH: process.env.PATH },
			platform: "win32",
			timeoutMs: 100,
		}),
		/Linux only/,
	);
});

test("uses fixed argv, cwd, timeout, and the caller AbortSignal", async (t) => {
	const { cli } = await fixture(t);
	const calls: ExecCall[] = [];
	const harness = createPiToolHarness("/tmp/project");
	registerMaestriTools(harness.registrar, {
		env: {
			PATH: path.dirname(cli),
			MAESTRI_CLI: cli,
			MAESTRI_WORKSPACE_ID: "workspace-for-test",
			MAESTRI_SOCKET: "/tmp/private-maestri-test.sock",
			GITHUB_TOKEN: "must-not-reach-cli",
		},
		platform: "linux",
		execute: async (command, args, options) => {
			calls.push({ command, args, options });
			return { stdout: "ok\n", stderr: "", code: 0, killed: false, termination: null, totalOutputBytes: 3 };
		},
	});
	const controller = new AbortController();
	const agent = "Agent ; $(touch /tmp/never-executed)";
	const prompt = "literal $HOME && echo no\nsecond line";

	await harness.invoke("maestri_list", {}, controller.signal);
	await harness.invoke("maestri_check", { agent }, controller.signal);
	await harness.invoke("maestri_ask", { agent, prompt }, controller.signal);

	assert.deepEqual(calls.map(({ command }) => command), [cli, cli, cli]);
	assert.deepEqual(calls.map(({ args }) => args), [
		["list"],
		["check", agent],
		["ask", agent, prompt],
	]);
	assert.deepEqual(calls.map(({ options }) => options.timeoutMs), [
		MAESTRI_LIST_TIMEOUT_MS,
		MAESTRI_CHECK_TIMEOUT_MS,
		MAESTRI_ASK_TIMEOUT_MS,
	]);
	for (const call of calls) {
		assert.equal(call.options.cwd, "/tmp/project");
		assert.equal(call.options.signal, controller.signal);
		assert.equal(call.options.env.GITHUB_TOKEN, undefined);
		assert.equal(call.options.env.MAESTRI_SOCKET, "/tmp/private-maestri-test.sock");
	}
});

test("prompt fidelity after controlled CLI escape decoding", async (t) => {
	const { cli } = await fixture(t);
	const { calls, invoke } = makeHarness(cli);
	const prompt = String.raw`C:\tmp\notes literal \n \t \\ \\\\ "quotes" 'single' ` + "`$HOME é 😀\nreal\ttab";
	await invoke("maestri_ask", { agent: "Peer", prompt });
	// Controlled decoder: n, t and doubled backslash verified against installed CLI /ask HTTP body.
	const received = calls[0].args[2].replace(/\\([\\nt])/g, (_, escape: string) =>
		escape === "n" ? "\n" : escape === "t" ? "\t" : "\\");
	assert.equal(received, prompt);
});

test("prompt fidelity enforces encoded UTF-8 byte boundary before execution", async (t) => {
	const { cli } = await fixture(t);
	const { calls, invoke } = makeHarness(cli);
	await assert.rejects(invoke("maestri_ask", { agent: "Peer", prompt: "\\".repeat(32_769) }), /UTF-8 bytes/);
	assert.equal(calls.length, 0);
	await invoke("maestri_ask", { agent: "Peer", prompt: "\\".repeat(32_768) });
	assert.equal(Buffer.byteLength(calls[0].args[2]), 65_536);
});

test("passes an option-looking prompt in the CLI's post-agent prompt position", async (t) => {
	const { cli } = await fixture(t);
	const { calls, invoke } = makeHarness(cli);
	await invoke("maestri_ask", { agent: "Peer", prompt: "--raw" });
	assert.deepEqual(calls[0].args, ["ask", "Peer", "--raw"]);
});

test("test adapter validates registered TypeBox schemas before tool execution", async (t) => {
	const { cli } = await fixture(t);
	const { calls, invoke } = makeHarness(cli);
	await assert.rejects(invoke("maestri_list", { unexpected: "value" }));
	await assert.rejects(invoke("maestri_check", {}));
	assert.equal(calls.length, 0);
});

test("passes only the minimal environment needed by the native CLI", () => {
	assert.deepEqual(
		maestriCliEnvironment({
			PATH: "/bin",
			HOME: "/home/test",
			LC_TIME: "C",
			MAESTRI_SOCKET: "/tmp/socket",
			MAESTRI_TOKEN: "token",
			GITHUB_TOKEN: "secret",
			HTTPS_PROXY: "https://user:password@example.invalid",
			NODE_OPTIONS: "--require attacker.js",
		}),
		{
			PATH: "/bin",
			HOME: "/home/test",
			LC_TIME: "C",
			MAESTRI_SOCKET: "/tmp/socket",
			MAESTRI_TOKEN: "token",
		},
	);
});

test("passes metacharacters to a fake CLI as literal argv without shell execution", async (t) => {
	const { dir, cli } = await fixture(t);
	const argvFile = path.join(dir, "argv.json");
	const sentinel = path.join(dir, "must-not-exist");
	await writeFile(
		cli,
		`#!/usr/bin/env node\nconst fs=require("node:fs");const path=require("node:path");fs.writeFileSync(path.join(path.dirname(process.argv[1]),"argv.json"),JSON.stringify(process.argv.slice(2)));console.log("fake peer response");\n`,
		{ mode: 0o700 },
	);
	const harness = createPiToolHarness(dir);
	registerMaestriTools(harness.registrar, {
		env: {
			MAESTRI_CLI: cli,
			PATH: process.env.PATH,
			MAESTRI_WORKSPACE_ID: "workspace",
			MAESTRI_SOCKET: "/tmp/socket",
		},
		platform: "linux",
	});
	const agent = `Agent; touch ${sentinel}`;
	const prompt = `literal $(touch ${sentinel}) && echo nope`;
	const result = await harness.invoke("maestri_ask", { agent, prompt });

	assert.deepEqual(JSON.parse(await readFile(argvFile, "utf8")), [
		"ask",
		agent,
		prompt,
	]);
	await assert.rejects(access(sentinel));
	const first = result.content[0];
	assert.equal(first?.type, "text");
	if (!first || first.type !== "text") throw new Error("expected text result");
	assert.match(first.text, /^UNTRUSTED PEER OUTPUT/);
});

test("rejects option-like names, NUL, and oversized UTF-8 prompts before exec", async (t) => {
	const { cli } = await fixture(t);
	const { calls, invoke } = makeHarness(cli);
	await assert.rejects(invoke("maestri_check", { agent: "--help" }), /must not start/);
	await assert.rejects(invoke("maestri_check", { agent: "bad\0name" }), /no NUL/);
	await assert.rejects(
		invoke("maestri_ask", { agent: "Peer", prompt: "é".repeat(32_769) }),
		/UTF-8 bytes/,
	);
	assert.equal(calls.length, 0);
});

test("refuses execution without the Linux Maestri context", async (t) => {
	const { cli } = await fixture(t);
	const calls: ExecCall[] = [];
	const harness = createPiToolHarness("/tmp/project");
	registerMaestriTools(harness.registrar, {
		env: { MAESTRI_CLI: cli },
		platform: "linux",
		execute: async (command, args, options) => {
			calls.push({ command, args, options });
			return { stdout: "", stderr: "", code: 0, killed: false, termination: null, totalOutputBytes: 0 };
		},
	});
	await assert.rejects(harness.invoke("maestri_list", {}), /context is unavailable/);
	assert.equal(calls.length, 0);
});

test("labels, redacts, and tail-truncates output without retaining the full response", () => {
	const token = "secret-token-value";
	const socket = "/tmp/private-maestri.sock";
	const detachedToken = "github_pat_ZZ99YY88XX77WW66VV55UU44";
	const obfuscated = "control-hidden-secret";
	const multilineSecret = "line-one\r\nline-two";
	const raw = Array.from({ length: 2_100 }, (_, index) => `line-${index}`).join("\n") +
		`\nMAESTRI_TOKEN=${token}\nMAESTRI_SOCKET=${socket}\n` +
		"workspace=private-workspace-id\ndb=postgres://private-database\n" +
		"google=/tmp/private-google-credentials.json\nnpm=private-npm-auth\n" +
		"db-pass=private-db-pass\nmysql=private-mysql-pwd\n" +
		`azure=private-azure-pat\npostgres=private-postgres-password\npeer=${detachedToken}\n` +
		`obfuscated=${obfuscated.slice(0, 7)}\u001b[31m${obfuscated.slice(7)}\n` +
		`multiline=${multilineSecret}\n` +
		`carriage=${obfuscated.slice(0, 10)}\r${obfuscated.slice(10)}\n` +
		"\u202eDB_PASS=unknown-bidi-secret\n" +
		"proxy=https://alice:proxy-password@example.invalid\n" +
		"Authorization: Bearer other-secret\u001b[31m";
	const formatted = formatMaestriOutput(
		{ stdout: raw, stderr: "", code: 0, killed: false, termination: null, totalOutputBytes: Buffer.byteLength(raw) },
		{
			MAESTRI_TOKEN: token,
			MAESTRI_SOCKET: socket,
			MAESTRI_WORKSPACE_ID: "private-workspace-id",
			DATABASE_URL: "postgres://private-database",
			GOOGLE_APPLICATION_CREDENTIALS: "/tmp/private-google-credentials.json",
			NPM_CONFIG__AUTH: "private-npm-auth",
			AZURE_DEVOPS_EXT_PAT: "private-azure-pat",
			PGPASSWORD: "private-postgres-password",
			DB_PASS: "private-db-pass",
			MYSQL_PWD: "private-mysql-pwd",
			GITHUB_PAT: "github_pat_11AA22BB33CC44DD55EE66FF77",
			MAESTRI_OBFUSCATED: obfuscated,
			PRIVATE_KEY: multilineSecret,
		},
	);

	assert.match(formatted.text, /^UNTRUSTED PEER OUTPUT/);
	assert.match(formatted.text, /\[TRUNCATED:/);
	assert.doesNotMatch(
		formatted.text,
		/secret-token-value|private-maestri\.sock|private-workspace-id|private-database|private-google|private-npm|private-azure|private-postgres|private-db|private-mysql|github_pat_|control-hidden|line-one|line-two|unknown-bidi|proxy-password|other-secret/,
	);
	assert.equal(formatted.text.includes("\u001b"), false);
	assert.equal(formatted.text.includes("\u202e"), false);
	assert.ok(Buffer.byteLength(formatted.text, "utf8") <= 50 * 1024);
	assert.ok(formatted.text.split("\n").length <= 2_000);
	assert.equal(formatted.details.truncated, true);
	assert.equal("stdout" in formatted.details, false);
});

test("normalizes Unicode line separators before enforcing the line cap", () => {
	const raw = Array.from({ length: 2_100 }, (_, index) => `line-${index}`).join("\u2028");
	const formatted = formatMaestriOutput({
		stdout: raw,
		stderr: "",
		code: 0,
		killed: false,
		termination: null,
		totalOutputBytes: Buffer.byteLength(raw),
	});
	assert.equal(formatted.details.truncated, true);
	assert.equal(formatted.details.truncatedBy, "lines");
	assert.ok(formatted.text.split("\n").length <= 2_000);
});

test("returns a sanitized bounded body separately from public presentation", async (t) => {
	const { cli } = await fixture(t);
	const secret = "private-outcome-token";
	const raw = `${"discarded\n".repeat(2_100)}result-line\nMAESTRI_TOKEN=${secret}\n`;
	const outcome = await invokeMaestriOutcome("portal", ["portal", "text", "Web"], {
		cwd: "/tmp/project",
		env: {
			MAESTRI_CLI: cli,
			MAESTRI_WORKSPACE_ID: "workspace",
			MAESTRI_SOCKET: "/tmp/socket",
			MAESTRI_TOKEN: secret,
		},
		platform: "linux",
		execute: async () => ({
			stdout: raw,
			stderr: "",
			code: 0,
			killed: false,
			termination: null,
			totalOutputBytes: Buffer.byteLength(raw),
		}),
	});

	assert.doesNotMatch(outcome.body, /UNTRUSTED|TRUNCATED|private-outcome-token/);
	assert.match(outcome.body, /result-line\nMAESTRI_TOKEN=\[REDACTED\]$/);
	assert.match(outcome.result.content[0].text, /^UNTRUSTED PEER OUTPUT/);
	assert.match(outcome.result.content[0].text, /\[TRUNCATED:/);
	assert.equal("body" in outcome.result, false);
	assert.equal(outcome.result.details.truncated, true);
	assert.ok(Buffer.byteLength(outcome.body, "utf8") < 50 * 1024);
	assert.ok(outcome.body.split("\n").length < 2_000);
});

test("keeps the structured body empty when presentation supplies the no-output placeholder", async (t) => {
	const { cli } = await fixture(t);
	const outcome = await invokeMaestriOutcome("list", ["list"], {
		cwd: "/tmp/project",
		env: {
			MAESTRI_CLI: cli,
			MAESTRI_WORKSPACE_ID: "workspace",
			MAESTRI_SOCKET: "/tmp/socket",
		},
		platform: "linux",
		execute: async () => ({
			stdout: "",
			stderr: "",
			code: 0,
			killed: false,
			termination: null,
			totalOutputBytes: 0,
		}),
	});
	assert.equal(outcome.body, "");
	assert.match(outcome.result.content[0].text, /\(no output\)$/);
});

test("does not spawn the CLI when the AbortSignal is already aborted", async (t) => {
	const { cli } = await fixture(t);
	const { calls, invoke } = makeHarness(cli);
	const controller = new AbortController();
	controller.abort();
	const error = await rejection(invoke("maestri_ask", { agent: "Peer", prompt: "one request" }, controller.signal));
	assert.match(error.message, /cancelled before execution/);
	assert.doesNotMatch(error.message, /delivery state is unknown/i);
	assert.equal(calls.length, 0);
});

test("bounded executor preserves split UTF-8 and escalates a TERM-ignoring timeout", async (t) => {
	const { dir } = await fixture(t);
	const splitUtf8 = path.join(dir, "split-utf8");
	await writeFile(splitUtf8, "#!/bin/bash\nprintf '\\360\\237'\nsleep 0.05\nprintf '\\230\\200\\n'\n", { mode: 0o700 });
	const decoded = await runBoundedProcess(splitUtf8, [], {
		cwd: dir,
		env: { PATH: process.env.PATH },
		platform: "linux",
		timeoutMs: 2_000,
	});
	assert.equal(decoded.stdout, "😀\n");
	assert.equal(decoded.termination, null);

	const ignoresTerm = path.join(dir, "ignores-term");
	const descendantPidFile = path.join(dir, "descendant.pid");
	await writeFile(
		ignoresTerm,
		`#!/bin/bash\ntrap '' TERM\nsleep 30 >/dev/null 2>&1 &\nprintf '%s\\n' "$!" > ${JSON.stringify(descendantPidFile)}\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n`,
		{ mode: 0o700 },
	);
	const started = Date.now();
	const timedOut = await runBoundedProcess(ignoresTerm, [], {
		cwd: dir,
		env: { PATH: process.env.PATH },
		platform: "linux",
		timeoutMs: 40,
		killGraceMs: 40,
	});
	assert.equal(timedOut.termination, "timeout");
	assert.equal(timedOut.killed, true);
	assert.ok(Date.now() - started < 2_000);
	const descendantPid = Number((await readFile(descendantPidFile, "utf8")).trim());
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.throws(() => process.kill(descendantPid, 0));
});

test("bounded executor rejects a normal leader exit until its process group is empty", async (t) => {
	const { dir } = await fixture(t);
	const leavesDescendant = path.join(dir, "leaves-descendant");
	const descendantPidFile = path.join(dir, "normal-descendant.pid");
	await writeFile(
		leavesDescendant,
		`#!/bin/bash\ntrap '' TERM\nsleep 30 >/dev/null 2>&1 &\nprintf '%s\\n' "$!" > ${JSON.stringify(descendantPidFile)}\nexit 0\n`,
		{ mode: 0o700 },
	);
	const result = await runBoundedProcess(leavesDescendant, [], {
		cwd: dir,
		env: { PATH: process.env.PATH },
		platform: "linux",
		timeoutMs: 2_000,
		killGraceMs: 40,
	});
	assert.equal(result.termination, "descendant");
	assert.equal(result.killed, true);
	const descendantPid = Number((await readFile(descendantPidFile, "utf8")).trim());
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.throws(() => process.kill(descendantPid, 0));
});

test("bounded executor stops capture at the raw byte limit", async (t) => {
	const { dir } = await fixture(t);
	const noisy = path.join(dir, "noisy");
	await writeFile(noisy, "#!/bin/bash\nwhile :; do printf 1234567890; done\n", { mode: 0o700 });
	const result = await runBoundedProcess(noisy, [], {
		cwd: dir,
		env: { PATH: process.env.PATH },
		platform: "linux",
		timeoutMs: 2_000,
		killGraceMs: 40,
		maxOutputBytes: 4_096,
	});
	assert.equal(result.termination, "output-limit");
	assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 0);
	assert.ok(result.totalOutputBytes > 4_096);
	const formatted = formatMaestriOutput(result);
	assert.equal(formatted.details.truncated, true);
	assert.equal(formatted.details.truncatedBy, "bytes");
	assert.match(formatted.text, /partial output was discarded/);
});

test("never exposes a credential prefix cut by the raw output limit", async (t) => {
	const { dir } = await fixture(t);
	const noisy = path.join(dir, "credential-boundary");
	const secret = "github_pat_11AA22BB33CC44DD55EE66FF77";
	await writeFile(
		noisy,
		`#!/bin/bash\nprintf '123456789012345%s-extra' "$GITHUB_PAT"\n`,
		{ mode: 0o700 },
	);
	const result = await runBoundedProcess(noisy, [], {
		cwd: dir,
		env: { PATH: process.env.PATH, GITHUB_PAT: secret },
		platform: "linux",
		timeoutMs: 2_000,
		killGraceMs: 40,
		maxOutputBytes: 24,
	});
	assert.equal(result.termination, "output-limit");
	assert.equal(result.stdout, "");
	assert.doesNotMatch(formatMaestriOutput(result, { GITHUB_PAT: secret }).text, /github_pat_|11AA/);
});

test("discards partial output when a process times out at the exact capture boundary", async (t) => {
	const { dir } = await fixture(t);
	const partial = path.join(dir, "partial-credential");
	const secret = "github_pat_11AA22BB33CC44DD55EE66FF77";
	const partialOutput = "123456789012github_pat_AA";
	await writeFile(
		partial,
		`#!/bin/bash\nprintf %s ${JSON.stringify(partialOutput)}\ntrap '' TERM\nwhile :; do sleep 1; done\n`,
		{ mode: 0o700 },
	);
	const result = await runBoundedProcess(partial, [], {
		cwd: dir,
		env: { PATH: process.env.PATH, GITHUB_PAT: secret },
		platform: "linux",
		timeoutMs: 40,
		killGraceMs: 40,
		maxOutputBytes: Buffer.byteLength(partialOutput),
	});
	assert.equal(result.termination, "timeout");
	assert.equal(result.stdout, "");
	assert.doesNotMatch(formatMaestriOutput(result, { GITHUB_PAT: secret }).text, /github_pat_|11AA/);
});

test("bounded executor honors an AbortSignal after spawn", async (t) => {
	const { dir } = await fixture(t);
	const sleeper = path.join(dir, "sleeper");
	await writeFile(sleeper, "#!/bin/bash\ntrap '' TERM\nwhile :; do sleep 1; done\n", { mode: 0o700 });
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 40);
	const result = await runBoundedProcess(sleeper, [], {
		cwd: dir,
		env: { PATH: process.env.PATH },
		platform: "linux",
		signal: controller.signal,
		timeoutMs: 2_000,
		killGraceMs: 40,
	});
	assert.equal(result.termination, "abort");
	assert.equal(result.killed, true);
});

test("marks ask timeout or abort as unknown delivery and never retries", async (t) => {
	const { cli } = await fixture(t);
	const result: MaestriExecResult = {
		stdout: "sensitive-partial-payload-xyz",
		stderr: "",
		code: 143,
		killed: true,
		termination: "timeout",
		totalOutputBytes: 29,
	};
	const { calls, invoke } = makeHarness(cli, result);
	const error = await rejection(invoke("maestri_ask", { agent: "Peer", prompt: "one request" }));
	assert.match(error.message, /delivery state is unknown; use maestri_check and do not resend automatically/i);
	assert.doesNotMatch(error.message, /sensitive-partial-payload-xyz/);
	assert.equal(calls.length, 1);
});

test("discards captured output when cancellation races with process completion", async (t) => {
	const { cli } = await fixture(t);
	const controller = new AbortController();
	const harness = createPiToolHarness("/tmp/project");
	registerMaestriTools(harness.registrar, {
		env: {
			MAESTRI_CLI: cli,
			MAESTRI_WORKSPACE_ID: "workspace",
			MAESTRI_SOCKET: "/tmp/socket",
		},
		platform: "linux",
		execute: async () => {
			controller.abort();
			return {
				stdout: "partial-secret-output",
				stderr: "",
				code: 0,
				killed: false,
				termination: null,
				totalOutputBytes: 21,
			};
		},
	});
	const error = await rejection(harness.invoke("maestri_list", {}, controller.signal));
	assert.match(error.message, /partial output was discarded/);
	assert.doesNotMatch(error.message, /partial-secret-output/);
});

test("sanitizes nonzero CLI diagnostics before throwing", async (t) => {
	const { cli } = await fixture(t);
	const token = "do-not-leak-this-token";
	const harness = createPiToolHarness("/tmp/project");
	registerMaestriTools(harness.registrar, {
		env: {
			MAESTRI_CLI: cli,
			MAESTRI_WORKSPACE_ID: "workspace",
			MAESTRI_SOCKET: "/tmp/socket",
			MAESTRI_TOKEN: token,
		},
		platform: "linux",
		execute: async () => ({
				stdout: "",
				stderr: `MAESTRI_TOKEN=${token}\nAuthorization: Bearer another-secret`,
				code: 7,
				killed: false,
				termination: null,
				totalOutputBytes: 80,
			}),
	});

	const error = await rejection(harness.invoke("maestri_list", {}));
	assert.match(error.message, /exited with code 7/);
	assert.match(error.message, /UNTRUSTED PEER OUTPUT/);
	assert.doesNotMatch(error.message, /do-not-leak|another-secret/);
});

test("keeps failed tool output within the model-visible line and byte caps", async (t) => {
	const { cli } = await fixture(t);
	const raw = Array.from({ length: 2_500 }, (_, index) => `failure-${index}`).join("\n");
	const { invoke } = makeHarness(cli, {
		stdout: raw,
		stderr: "",
		code: 9,
		killed: false,
		termination: null,
		totalOutputBytes: Buffer.byteLength(raw),
	});
	const error = await rejection(invoke("maestri_list", {}));
	assert.ok(Buffer.byteLength(error.message, "utf8") <= 50 * 1024);
	assert.ok(error.message.split("\n").length <= 2_000);
	assert.match(error.message, /UNTRUSTED PEER OUTPUT/);
});
