import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	assertReadyPiScreen,
	registerMaestriAsyncTools,
	resolveNodeExecutable,
	type MaestriAsyncRuntimeOptions,
} from "../src/ask-async.ts";
import { envelopedPrompt, extractReplyEnvelope, replyEnvelope } from "../src/reply-envelope.ts";
import {
	atomicWriteRecord,
	askStateBase,
	askStateRoot,
	clientDigest,
	createAcceptedRequest,
	createOutput,
	ensureAskStateRoot,
	outputPath,
	promptDigest,
	transitionTerminal,
	type AskRequestRecord,
} from "../src/ask-store.ts";

const execFileAsync = promisify(execFile);

type ToolResult = {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
};

type RegisteredTool = {
	name: string;
	parameters: { additionalProperties?: boolean };
	execute: (
		toolCallId: string,
		params: Record<string, string>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: { cwd: string },
	) => Promise<ToolResult>;
};

function registerTools(
	env: Record<string, string | undefined>,
	options: Omit<MaestriAsyncRuntimeOptions, "env" | "platform"> = {},
): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
		on() {},
		sendMessage() {},
	} as unknown as ExtensionAPI;
	registerMaestriAsyncTools(pi, { env, platform: "linux", ...options });
	return tools;
}

async function fixture(t: TestContext, options: Omit<MaestriAsyncRuntimeOptions, "env" | "platform"> = {}) {
	const dir = await mkdtemp(path.join(tmpdir(), "maestri-ask-async-"));
	const cli = path.join(dir, "maestri");
	await writeFile(cli, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const events = path.join(path.dirname(process.argv[1]), "events");
const [action, agent, wirePrompt] = process.argv.slice(2);
// Controlled escape decoder, verified against the installed CLI's /ask HTTP body.
const prompt = wirePrompt?.replace(/\\\\([\\\\nt])/g, (_, escape) => escape === "n" ? "\\n" : escape === "t" ? "\\t" : "\\\\");
fs.appendFileSync(events, action + ":" + (agent || "") + "\\n");
if (action === "check") {
  if (agent === "Busy") console.log("working...\\nGPT-5.6 Sol • low");
  else if (agent === "Spinner") console.log("⠴ Working\\nGPT-5.6 Sol • high");
  else if (agent === "Shell") console.log("/bin/bash $");
  else if (agent === "Blank") {}
  else if (agent === "NonPi") console.log("connected terminal");
  else if (agent === "Ambiguous") console.log("GPT-5.6 Sol");
  else if (agent === "MultiFooter") console.log("GPT-5.6 Sol • low\\nGPT-5.6 Sol • high");
  else if (agent === "Retrying") console.log("Retrying request\\nGPT-5.6 Sol • high");
  else if (agent === "ShellFooter") console.log("/bin/bash $\\nGPT-5.6 Sol • high");
  else if (agent === "ThinkingHigh") console.log("GPT-5.6 Sol • thinking high");
  else if (agent === "ThinkingOff") console.log("GPT-5.6 Sol • thinking off");
  else if (agent === "Off") console.log("~/project GPT-5.6 Sol • off");
  else if (agent === "Stale") console.log("GPT-5.6 Sol • low\\nline\\nline\\nline\\nline\\nline\\nline\\nline\\nworking...");
  else if (agent === "Missing") process.exitCode = 7;
  else if (agent === "Slow") setTimeout(() => console.log("GPT-5.6 Sol • low"), 60000);
  else console.log("~/project GPT-5.6 Sol • low");
} else if (action === "ask") {
  fs.writeFileSync(path.join(path.dirname(process.argv[1]), "received-prompt.json"), JSON.stringify(prompt));
  const task = prompt.split("\\n\\nReturn your final reply exactly once")[0];
  const requestId = (prompt.match(/Request ID: ([0-9a-f-]{36})/) || ["", ""])[1];
  const begin = "<<<MAESTRI_REPLY_BEGIN:" + requestId + ">>>";
  const end = "<<<MAESTRI_REPLY_END:" + requestId + ">>>";
  const emit = (body) => console.log(begin + "\\n" + body + "\\n" + end);
  if (task === "long") setTimeout(() => emit("late"), 60000);
  else if (task === "partial-long") {
    process.stdout.write("private-async-token-partial");
    setTimeout(() => emit("late"), 60000);
  }
  else if (task === "timeout") {
    process.stdout.write("github_pat_PARTIAL_SECRET");
    process.on("SIGTERM", () => {});
    const child = spawn("/bin/bash", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore" });
    fs.writeFileSync(path.join(path.dirname(process.argv[1]), "descendant"), String(child.pid));
    setInterval(() => {}, 1000);
  }
  else if (task === "leader-exits") {
    process.stdout.write("github_pat_LEADER_PARTIAL");
    const child = spawn("/bin/bash", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore" });
    child.unref();
    fs.writeFileSync(path.join(path.dirname(process.argv[1]), "descendant-leader"), String(child.pid));
    setInterval(() => {}, 1000);
  }
  else if (task === "normal-descendant") {
    const child = spawn("/bin/bash", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: ["ignore", "inherit", "inherit"] });
    child.unref();
    fs.writeFileSync(path.join(path.dirname(process.argv[1]), "descendant-normal"), String(child.pid));
    console.log("premature-success");
  }
  else if (task === "replacement:GEN-A") {
    fs.writeFileSync(path.join(path.dirname(process.argv[1]), "replacement-dispatched"), "GEN-A");
    const marker = path.join(path.dirname(process.argv[1]), "replace-target");
    const timer = setInterval(() => {
      if (!fs.existsSync(marker)) return;
      clearInterval(timer);
      process.stdout.write(begin + "\\nGEN-B\\n" + end + "\\n");
      process.exit(9);
    }, 10);
  }
  else if (task === "noisy") process.stdout.write("x".repeat(1024 * 1024 + 1));
  else if (task === "many") {
    console.log(begin);
    for (let index = 0; index < 2500; index += 1) console.log("line-" + index + "-abcdefghijklmnopqrstuvwxyz");
    console.log("token=" + process.env.MAESTRI_TOKEN.slice(0, 8) + "\\u001b[31m" + process.env.MAESTRI_TOKEN.slice(8));
    console.log("proxy=https://alice:password@example.invalid");
    console.log("\\u202eDB_PASS=hidden-bidi-secret");
    console.log(end);
  }
  else if (task === "missing-envelope") console.log("missing");
  else if (task === "duplicate-envelope") { emit("first"); emit("second"); }
  else if (task === "malformed-envelope") console.log(end + "\\nbad\\n" + begin);
  else if (task === "isolation") console.log("<<<MAESTRI_REPLY_BEGIN:11111111-1111-4111-8111-111111111111>>>\\nold-reply\\n<<<MAESTRI_REPLY_END:11111111-1111-4111-8111-111111111111>>>\\nnoise-before\\n  " + begin + "   \\n  ASYNC_REPLY   \\n  " + end + "   \\nnoise-after");
  else emit("reply token=" + (process.env.MAESTRI_TOKEN || ""));
}
`, { mode: 0o700 });
	await chmod(cli, 0o700);
	const env = {
		HOME: dir,
		XDG_STATE_HOME: path.join(dir, "state"),
		PATH: process.env.PATH,
		MAESTRI_CLI: cli,
		MAESTRI_WORKSPACE_ID: "workspace",
		MAESTRI_TERMINAL_ID: "terminal",
		MAESTRI_SOCKET: "/tmp/private-maestri-test.sock",
		MAESTRI_TOKEN: "private-async-token",
	};
	const tools = registerTools(env, options);
	t.after(async () => {
		try {
			const root = askStateRoot(env);
			for (const name of await import("node:fs/promises").then((fs) => fs.readdir(root))) {
				if (!name.endsWith(".json")) continue;
				const record = JSON.parse(await readFile(path.join(root, name), "utf8"));
				if (record.phase !== "terminal" && record.runner?.pgid) {
					try { process.kill(-record.runner.pgid, "SIGKILL"); } catch {}
				}
			}
		} catch {}
		await rm(dir, { recursive: true, force: true });
	});
	return { cli, dir, env, tools, events: path.join(dir, "events") };
}

async function invoke(tool: RegisteredTool, params: Record<string, string>, signal?: AbortSignal): Promise<ToolResult> {
	return tool.execute("call", params, signal, undefined, { cwd: "/tmp" });
}

function state(result: ToolResult) {
	return JSON.parse(result.content[0].text) as {
		request_id: string;
		phase: string;
		delivery: string;
		reply: string;
		state_version: number;
		refusal?: string;
	};
}

function acceptedRecord(
	clientRequestId: string,
	prompt: string,
	scopeKey: string,
	createdAt = new Date().toISOString(),
): AskRequestRecord {
	return {
		schema: 1,
		scope_key: scopeKey,
		runner_token_digest: promptDigest("runner-token"),
		request_id: randomUUID(),
		client_request_id: clientRequestId,
		agent: "Farol",
		prompt_digest: promptDigest(prompt),
		prompt_bytes: Buffer.byteLength(prompt),
		created_at: createdAt,
		phase: "accepted",
		delivery: "not-attempted",
		reply: "none",
		custody: "none",
		cleanup_deadline_ms: null,
		notification: { state: "none", digest: null, sent_at: null, attempts: 0, claim: null },
		output: { raw_bytes: 0, truncated: false },
		state_version: 1,
	};
}

async function waitForTerminal(tool: RegisteredTool, requestId: string) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const current = state(await invoke(tool, { action: "status", request_id: requestId }));
		if (current.phase === "terminal") return current;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("request did not become terminal");
}

async function eventCount(file: string, prefix: string): Promise<number> {
	try {
		return (await readFile(file, "utf8")).split("\n").filter((line) => line.startsWith(prefix)).length;
	} catch {
		return 0;
	}
}

async function waitForFile(file: string): Promise<string> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		try {
			return await readFile(file, "utf8");
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	throw new Error(`file did not appear: ${file}`);
}

async function waitForGroupGone(pgid: number): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		try {
			process.kill(-pgid, 0);
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`process group remained alive: ${pgid}`);
}

test("prompt fidelity survives runner and controlled CLI decoding with original digest and replay", async (t) => {
	const { dir, env, events, tools } = await fixture(t);
	const prompt = String.raw`C:\tmp\notes literal \n \t \\ \\\\ "quotes" 'single' ` + "`$HOME é 😀\nreal\ttab";
	const params = { agent: "Farol", prompt, client_request_id: "literal-corpus" };
	const first = state(await invoke(tools.get("maestri_ask_async")!, params));
	await waitForTerminal(tools.get("maestri_ask_request")!, first.request_id);
	assert.equal(JSON.parse(await readFile(path.join(dir, "received-prompt.json"), "utf8")), envelopedPrompt(prompt, first.request_id));
	const record = JSON.parse(await readFile(path.join(askStateRoot(env), `${first.request_id}.json`), "utf8"));
	assert.equal(record.prompt_digest, promptDigest(prompt));
	assert.equal(record.prompt_bytes, Buffer.byteLength(prompt));
	assert.equal(state(await invoke(tools.get("maestri_ask_async")!, params)).request_id, first.request_id);
	assert.equal(await eventCount(events, "ask:"), 1);
	await assert.rejects(invoke(tools.get("maestri_ask_async")!, { ...params, prompt: prompt.replace("\\n", "\n") }), /different agent or prompt/);
});

test("async accepts an option-looking prompt in the post-agent prompt position", async (t) => {
	const { dir, tools } = await fixture(t);
	const started = state(await invoke(tools.get("maestri_ask_async")!, {
		agent: "Farol", prompt: "--raw", client_request_id: "option-looking-prompt",
	}));
	await waitForTerminal(tools.get("maestri_ask_request")!, started.request_id);
	assert.equal(JSON.parse(await readFile(path.join(dir, "received-prompt.json"), "utf8")), envelopedPrompt("--raw", started.request_id));
});

test("prompt fidelity rejects encoded envelope overflow before preflight or acceptance", async (t) => {
	const { env, events, tools } = await fixture(t);
	// Raw text fits; only encoding plus the request envelope exceeds the limit.
	await assert.rejects(invoke(tools.get("maestri_ask_async")!, {
		agent: "Farol", prompt: "\\".repeat(32_768), client_request_id: "encoded-overflow",
	}), /UTF-8 bytes/);
	assert.equal(await eventCount(events, "check:"), 0);
	assert.equal(await eventCount(events, "ask:"), 0);
	// Recovery is checked first; an invalid new prompt must not create a receipt or dispatch.
	const root = askStateRoot(env);
	assert.deepEqual((await readdir(root)).filter((name) => /\.json$|\.out$/.test(name)), []);
	assert.deepEqual(await readdir(path.join(root, "by-client")), []);
});

test("recovers historical client keys without applying new wire limits to a prompt that will not be resent", async (t) => {
	const { env, events, tools } = await fixture(t);
	const root = await ensureAskStateRoot(env);
	const prompt = "\\".repeat(32_700);
	const original = acceptedRecord("historical-wire-limit", prompt, path.basename(root));
	await createAcceptedRequest(root, original, clientDigest(original.client_request_id));
	await atomicWriteRecord(root, transitionTerminal(original, {
		delivery: "confirmed", reply: "received", reason: "envelope-received", termination: null,
		exitCode: 0, rawBytes: 0, truncated: false,
	}));
	const params = { agent: original.agent, prompt, client_request_id: original.client_request_id };
	const ask = tools.get("maestri_ask_async")!;
	assert.equal(state(await invoke(ask, params)).request_id, original.request_id);
	await assert.rejects(invoke(ask, { ...params, prompt: prompt + "different" }), /different agent or prompt/);
	await assert.rejects(invoke(ask, { ...params, client_request_id: "new-wire-limit" }), /encoded prompt/);
	assert.equal(await eventCount(events, "check:"), 0);
	assert.equal(await eventCount(events, "ask:"), 0);
});

test("prompt fidelity accepts exact encoded envelope limit and JSON-expanded payload", async (t) => {
	const { dir, tools } = await fixture(t);
	const overhead = Buffer.byteLength(envelopedPrompt("", "00000000-0000-4000-8000-000000000000"));
	const budget = 65_536 - overhead;
	const prompts = ["\\".repeat(Math.floor(budget / 2)) + "a".repeat(budget % 2), "\u0001".repeat(budget)];
	for (const [index, prompt] of prompts.entries()) {
		const accepted = state(await invoke(tools.get("maestri_ask_async")!, {
			agent: "Farol", prompt, client_request_id: `boundary-${index}`,
		}));
		const terminal = await waitForTerminal(tools.get("maestri_ask_request")!, accepted.request_id);
		assert.equal(terminal.delivery, "confirmed");
		assert.equal(JSON.parse(await readFile(path.join(dir, "received-prompt.json"), "utf8")), envelopedPrompt(prompt, accepted.request_id));
	}
});

test("resolves a real Node executable instead of assuming the Pi launcher", async (t) => {
	const { dir } = await fixture(t);
	const node = path.join(dir, "node");
	await writeFile(node, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	await chmod(node, 0o700);
	assert.equal(await resolveNodeExecutable({ PATH: dir }), node);
	await assert.rejects(resolveNodeExecutable({ PATH: "" }), /Node\.js is unavailable/);
});

test("reports safe runner startup diagnostics without losing the original receipt or retrying", async (t) => {
	const { dir, env, events } = await fixture(t);
	const invalidRunner = path.join(dir, "invalid-runner.mjs");
	await writeFile(invalidRunner, 'import "./private-async-token-missing.mjs";\n');
	const tools = registerTools(env, { asyncRunnerPath: invalidRunner, asyncHandshakeTimeoutMs: 1_000, asyncKillGraceMs: 75 });
	const ask = tools.get("maestri_ask_async")!;
	const request = tools.get("maestri_ask_request")!;
	const params = { agent: "Farol", prompt: "reply", client_request_id: "startup-import-error" };
	const first = await invoke(ask, params);
	const current = state(first);
	assert.deepEqual([current.phase, current.delivery, current.reply], ["terminal", "unknown", "unknown"]);
	assert.match(first.content[0].text, /ERR_MODULE_NOT_FOUND/);
	assert.equal(first.details.exit_code, 1);
	assert.equal(first.details.termination, "process-error");
	for (const action of ["status", "result"]) {
		const result = await invoke(request, { action, request_id: current.request_id });
		assert.match(result.content[0].text, /ERR_MODULE_NOT_FOUND/);
		assert.doesNotMatch(JSON.stringify(result), /private-async-token|invalid-runner\.mjs/);
	}
	assert.equal(state(await invoke(ask, params)).request_id, current.request_id);
	assert.equal(await eventCount(events, "check:"), 1);
	assert.equal(await eventCount(events, "ask:"), 0);
	assert.equal((await stat(outputPath(askStateRoot(env), current.request_id))).size, 0);
});

test("retains startup diagnostics when a large payload loses its pipe before handshake", async (t) => {
	const { dir, env, events } = await fixture(t);
	const invalidRunner = path.join(dir, "invalid-large-runner.mjs");
	await writeFile(invalidRunner, 'import "./private-async-token-missing.mjs";\n');
	const tools = registerTools(env, { asyncRunnerPath: invalidRunner, asyncHandshakeTimeoutMs: 1_000, asyncKillGraceMs: 75 });
	const result = await invoke(tools.get("maestri_ask_async")!, {
		agent: "Farol", prompt: "\u0001".repeat(60_000), client_request_id: "startup-large",
	});
	assert.match(result.content[0].text, /ERR_MODULE_NOT_FOUND/);
	assert.equal(result.details.exit_code, 1);
	assert.doesNotMatch(JSON.stringify(result), /private-async-token/);
	assert.equal(await eventCount(events, "ask:"), 0);
});

test("bounds payload backpressure when a runner never reads its inherited pipe", { timeout: 5_000 }, async (t) => {
	const { dir, env, events } = await fixture(t);
	const blockedRunner = path.join(dir, "blocked-input.mjs");
	await writeFile(blockedRunner, 'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./blocked.pid", import.meta.url), String(process.pid));\nsetInterval(() => {}, 1000);\n');
	const tools = registerTools(env, { asyncRunnerPath: blockedRunner, asyncHandshakeTimeoutMs: 150, asyncKillGraceMs: 75 });
	const result = await invoke(tools.get("maestri_ask_async")!, {
		agent: "Farol", prompt: "\u0001".repeat(60_000), client_request_id: "blocked-input",
	});
	assert.equal(state(result).phase, "terminal");
	assert.equal(result.details.reason, "runner-payload-timeout");
	assert.equal(await eventCount(events, "ask:"), 0);
	const pid = Number(await readFile(path.join(dir, "blocked.pid"), "utf8"));
	assert.throws(() => process.kill(-pid, 0));
});

test("never promotes a live child that does not author the token-bound runner handshake", async (t) => {
	const { dir, env, events } = await fixture(t);
	const nonRunner = path.join(dir, "non-runner.mjs");
	await writeFile(nonRunner, `import { createReadStream, writeFileSync } from "node:fs";\nwriteFileSync(new URL("./non-runner.pid", import.meta.url), String(process.pid));\nfor await (const _ of createReadStream(null, { fd: 3 })) {}\nsetInterval(() => {}, 1000);\n`);
	const tools = registerTools(env, {
		asyncRunnerPath: nonRunner,
		asyncHandshakeTimeoutMs: 75,
		asyncKillGraceMs: 75,
	});
	const result = state(await invoke(tools.get("maestri_ask_async")!, {
		agent: "Farol",
		prompt: "reply",
		client_request_id: "no-handshake",
	}));
	assert.deepEqual([result.phase, result.delivery, result.reply], ["terminal", "unknown", "unknown"]);
	assert.equal(await eventCount(events, "ask:"), 0);
	const pid = Number((await waitForFile(path.join(dir, "non-runner.pid"))).trim());
	assert.throws(() => process.kill(pid, 0));
});

test("preserves orphan custody when an unmarked child cannot be cleaned up", async (t) => {
	const { dir, env, tools: _tools } = await fixture(t);
	const nonRunner = path.join(dir, "orphan-runner.mjs");
	await writeFile(nonRunner, `import { createReadStream, writeFileSync } from "node:fs";\nwriteFileSync(new URL("./orphan-runner.pid", import.meta.url), String(process.pid));\nfor await (const _ of createReadStream(null, { fd: 3 })) {}\nsetInterval(() => {}, 1000);\n`);
	const tools = registerTools(env, {
		asyncRunnerPath: nonRunner,
		asyncHandshakeTimeoutMs: 75,
		asyncKillGraceMs: 75,
		asyncCancelProcessGroup: async () => false,
	});
	const result = state(await invoke(tools.get("maestri_ask_async")!, {
		agent: "Farol",
		prompt: "reply",
		client_request_id: "orphan-handshake",
	}));
	assert.deepEqual([result.phase, result.delivery, result.reply], ["accepted", "unknown", "unknown"]);
	const root = askStateRoot(env);
	const persisted = JSON.parse(await readFile(path.join(root, `${result.request_id}.json`), "utf8"));
	assert.equal(persisted.phase, "accepted");
	assert.equal(persisted.custody, "orphan");
	await assert.rejects(
		invoke(tools.get("maestri_ask_async")!, { agent: "Farol", prompt: "reply", client_request_id: "blocked-by-launch-orphan" }),
		/already has active async request/,
	);
	const pid = Number((await waitForFile(path.join(dir, "orphan-runner.pid"))).trim());
	assert.doesNotThrow(() => process.kill(pid, 0));
	process.kill(-pid, "SIGKILL");
});

test("returns a durable id quickly, launches once on replay, and cancels without resend", async (t) => {
	const { env, events, tools } = await fixture(t);
	const ask = tools.get("maestri_ask_async")!;
	const request = tools.get("maestri_ask_request")!;
	const started = Date.now();
	const first = state(await invoke(ask, { agent: "Farol", prompt: "long", client_request_id: "task-42" }));
	assert.ok(Date.now() - started < 5_000);
	assert.equal(first.phase, "running");
	const replay = state(await invoke(ask, { agent: "Farol", prompt: "long", client_request_id: "task-42" }));
	assert.equal(replay.request_id, first.request_id);
	await assert.rejects(
		invoke(ask, { agent: "Farol", prompt: "changed", client_request_id: "task-42" }),
		/different agent or prompt/,
	);
	await assert.rejects(
		invoke(ask, { agent: "Other", prompt: "long", client_request_id: "task-42" }),
		/different agent or prompt/,
	);
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline && await eventCount(events, "ask:") < 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.equal(await eventCount(events, "ask:"), 1);
	assert.equal(await eventCount(events, "check:"), 1);
	const root = askStateRoot(env);
	const recordFile = path.join(root, `${first.request_id}.json`);
	const persisted = await readFile(recordFile, "utf8");
	assert.doesNotMatch(persisted, /"prompt"|long/);
	assert.equal((await stat(root)).mode & 0o777, 0o700);
	assert.equal((await stat(recordFile)).mode & 0o777, 0o600);
	const cancelled = state(await invoke(request, { action: "cancel", request_id: first.request_id }));
	assert.equal(cancelled.reply, "cancelled");
	assert.equal(await eventCount(events, "ask:"), 1);
});

test("serializes identical client keys across processes", async (t) => {
	const { env, events, tools } = await fixture(t);
	const childEnv = {
		...process.env,
		...env,
		ASYNC_TEST_AGENT: "Farol",
		ASYNC_TEST_PROMPT: "long",
		ASYNC_TEST_CLIENT_ID: "cross-process",
		ASYNC_TEST_CWD: "/tmp",
	};
	const helper = path.join(import.meta.dirname, "invoke-async.ts");
	const [left, right] = await Promise.all([
		execFileAsync(process.execPath, [helper], { env: childEnv }),
		execFileAsync(process.execPath, [helper], { env: childEnv }),
	]);
	const leftState = state(JSON.parse(left.stdout));
	const rightState = state(JSON.parse(right.stdout));
	assert.equal(leftState.request_id, rightState.request_id);
	assert.equal(await eventCount(events, "check:"), 2);
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline && await eventCount(events, "ask:") < 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.equal(await eventCount(events, "ask:"), 1);
	await invoke(tools.get("maestri_ask_request")!, { action: "cancel", request_id: leftState.request_id });
});

test("runs slow readiness outside the create lock and converges identical callers", async (t) => {
	let started = 0;
	let release!: () => void;
	const bothStarted = new Promise<void>((resolve) => { release = resolve; });
	const { events, tools } = await fixture(t, {
		execute: async () => {
			started += 1;
			if (started === 2) release();
			await bothStarted;
			return {
				stdout: "~/project GPT-5.6 Sol • low\n",
				stderr: "",
				code: 0,
				killed: false,
				termination: null,
				totalOutputBytes: 34,
			};
		},
	});
	const ask = tools.get("maestri_ask_async")!;
	const params = { agent: "Farol", prompt: "long", client_request_id: "slow-shared" };
	const [left, right] = await Promise.all([invoke(ask, params), invoke(ask, params)]);
	assert.equal(state(left).request_id, state(right).request_id);
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline && await eventCount(events, "ask:") < 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.equal(started, 2);
	assert.equal(await eventCount(events, "ask:"), 1);
	await invoke(tools.get("maestri_ask_request")!, { action: "cancel", request_id: state(left).request_id });
});

test("abort before acceptance or during handshake never dispatches invisibly", async (t) => {
	const before = new AbortController();
	const { events, tools } = await fixture(t, {
		execute: async (_command, _args, options) => {
			await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
			return { stdout: "", stderr: "", code: 130, killed: true, termination: "abort", totalOutputBytes: 0 };
		},
	});
	setTimeout(() => before.abort(), 25);
	await assert.rejects(
		invoke(tools.get("maestri_ask_async")!, { agent: "Farol", prompt: "reply", client_request_id: "abort-preflight" }, before.signal),
		/readiness check failed/,
	);
	assert.equal(await eventCount(events, "ask:"), 0);

	const delayed = path.join(path.dirname(events), "abort-handshake.mjs");
	const payloadRead = path.join(path.dirname(events), "abort-handshake-ready");
	await writeFile(delayed, `import { createReadStream, writeFileSync } from "node:fs";\nfor await (const _ of createReadStream(null, { fd: 3 })) {}\nwriteFileSync(${JSON.stringify(payloadRead)}, "ready");\nsetInterval(() => {}, 1000);\n`);
	const after = new AbortController();
	const handshakeTools = registerTools({
		HOME: path.dirname(events),
		XDG_STATE_HOME: path.join(path.dirname(events), "other-state"),
		PATH: process.env.PATH,
		MAESTRI_CLI: path.join(path.dirname(events), "maestri"),
		MAESTRI_WORKSPACE_ID: "workspace",
		MAESTRI_TERMINAL_ID: "terminal-abort",
		MAESTRI_SOCKET: "/tmp/private-maestri-test.sock",
	}, { asyncRunnerPath: delayed, asyncHandshakeTimeoutMs: 2_000, asyncKillGraceMs: 75 });
	const pending = invoke(handshakeTools.get("maestri_ask_async")!, {
		agent: "Farol",
		prompt: "reply",
		client_request_id: "abort-handshake",
	}, after.signal);
	await waitForFile(payloadRead);
	after.abort();
	const cancelled = state(await pending);
	assert.deepEqual([cancelled.phase, cancelled.delivery, cancelled.reply], ["terminal", "not-attempted", "cancelled"]);
	assert.equal(await eventCount(events, "ask:"), 0);
});

test("refuses request IDs and client keys from foreign or unscoped Maestri contexts", async (t) => {
	const { env, tools } = await fixture(t, { asyncKillGraceMs: 75 });
	const ask = tools.get("maestri_ask_async")!;
	const request = tools.get("maestri_ask_request")!;
	const local = state(await invoke(ask, { agent: "Farol", prompt: "long", client_request_id: "scoped-key" }));
	const foreignWorkspace = registerTools({ ...env, MAESTRI_WORKSPACE_ID: "foreign-workspace" });
	await assert.rejects(
		invoke(foreignWorkspace.get("maestri_ask_request")!, { action: "status", request_id: local.request_id }),
		/foreign Maestri scope/,
	);
	const foreignTerminal = registerTools({ ...env, MAESTRI_TERMINAL_ID: "foreign-terminal" });
	await assert.rejects(
		invoke(foreignTerminal.get("maestri_ask_request")!, { action: "cancel", request_id: local.request_id }),
		/foreign Maestri scope/,
	);
	const legacyKey = "legacy-key";
	const legacyIndex = path.join(askStateBase(env), "by-client");
	await mkdir(legacyIndex, { recursive: true, mode: 0o700 });
	await writeFile(path.join(legacyIndex, clientDigest(legacyKey)), "legacy\n", { mode: 0o600 });
	await assert.rejects(
		invoke(ask, { agent: "Farol", prompt: "reply", client_request_id: legacyKey }),
		/unscoped legacy/,
	);
	const { MAESTRI_TERMINAL_ID: _terminal, ...missingTerminalEnv } = env;
	const missingTerminal = registerTools(missingTerminalEnv);
	await assert.rejects(
		invoke(missingTerminal.get("maestri_ask_async")!, { agent: "Farol", prompt: "reply", client_request_id: "missing-terminal" }),
		/require MAESTRI_WORKSPACE_ID and MAESTRI_TERMINAL_ID/,
	);
	await invoke(request, { action: "cancel", request_id: local.request_id });
});

test("fresh registrations reconcile accepted, running, output, and completed crash boundaries without resend", async (t) => {
	const { env, events, tools } = await fixture(t);
	const root = await ensureAskStateRoot(env);
	const request = tools.get("maestri_ask_request")!;
	const interrupted = acceptedRecord("crash-client-index", "never-send-index", path.basename(root));
	await writeFile(
		path.join(root, "by-client", clientDigest(interrupted.client_request_id)),
		`${JSON.stringify(interrupted)}\n`,
		{ mode: 0o600 },
	);
	const afterIndexCrash = registerTools(env);
	const interruptedReplay = state(await invoke(afterIndexCrash.get("maestri_ask_async")!, {
		agent: interrupted.agent,
		prompt: "never-send-index",
		client_request_id: interrupted.client_request_id,
	}));
	assert.equal(interruptedReplay.request_id, interrupted.request_id);
	assert.deepEqual(
		[interruptedReplay.phase, interruptedReplay.delivery, interruptedReplay.reply],
		["terminal", "not-attempted", "none"],
	);
	assert.equal(await eventCount(events, "check:"), 0);
	assert.equal(await eventCount(events, "ask:"), 0);
	const accepted = acceptedRecord("crash-accepted", "never-send", path.basename(root), new Date(Date.now() - 20_000).toISOString());
	await createAcceptedRequest(root, accepted, clientDigest(accepted.client_request_id));
	const afterAcceptedCrash = registerTools(env);
	const acceptedReplay = state(await invoke(afterAcceptedCrash.get("maestri_ask_async")!, {
		agent: accepted.agent,
		prompt: "never-send",
		client_request_id: accepted.client_request_id,
	}));
	assert.equal(acceptedReplay.request_id, accepted.request_id);
	assert.deepEqual([acceptedReplay.phase, acceptedReplay.delivery, acceptedReplay.reply], ["terminal", "unknown", "unknown"]);
	assert.equal(await eventCount(events, "check:"), 0);
	assert.equal(await eventCount(events, "ask:"), 0);

	const outputCrash = acceptedRecord("crash-output", "never-send-output", path.basename(root));
	await createAcceptedRequest(root, outputCrash, clientDigest(outputCrash.client_request_id));
	await createOutput(root, outputCrash.request_id);
	await writeFile(outputPath(root, outputCrash.request_id), "github_pat_UNCOMMITTED_PARTIAL", { mode: 0o600 });
	await atomicWriteRecord(root, {
		...outputCrash,
		phase: "running",
		delivery: "unknown",
		reply: "pending",
		custody: "held",
		runner: {
			pid: 999_999_999,
			pgid: 999_999_999,
			identity: { start_time: "1", cmdline_hex: "00" },
		},
		state_version: 2,
	});
	const afterOutputCrash = registerTools(env);
	const outputState = state(await invoke(afterOutputCrash.get("maestri_ask_request")!, {
		action: "status",
		request_id: outputCrash.request_id,
	}));
	assert.deepEqual([outputState.delivery, outputState.reply], ["unknown", "unknown"]);
	assert.equal((await stat(outputPath(root, outputCrash.request_id))).size, 0);
	const outputReplay = state(await invoke(afterOutputCrash.get("maestri_ask_async")!, {
		agent: outputCrash.agent,
		prompt: "never-send-output",
		client_request_id: outputCrash.client_request_id,
	}));
	assert.equal(outputReplay.request_id, outputCrash.request_id);
	assert.equal(await eventCount(events, "ask:"), 0);

	const live = state(await invoke(afterOutputCrash.get("maestri_ask_async")!, {
		agent: "Farol",
		prompt: "long",
		client_request_id: "crash-running",
	}));
	const sendDeadline = Date.now() + 2_000;
	while (Date.now() < sendDeadline && await eventCount(events, "ask:") < 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.equal(await eventCount(events, "ask:"), 1);
	const liveRecord = JSON.parse(await readFile(path.join(root, `${live.request_id}.json`), "utf8"));
	process.kill(-liveRecord.runner.pgid, "SIGKILL");
	await new Promise((resolve) => setTimeout(resolve, 50));
	const afterRunningCrash = registerTools(env);
	const dead = state(await invoke(afterRunningCrash.get("maestri_ask_request")!, {
		action: "status",
		request_id: live.request_id,
	}));
	assert.deepEqual([dead.delivery, dead.reply], ["unknown", "unknown"]);
	const liveReplay = state(await invoke(afterRunningCrash.get("maestri_ask_async")!, {
		agent: "Farol",
		prompt: "long",
		client_request_id: "crash-running",
	}));
	assert.equal(liveReplay.request_id, live.request_id);
	const sendsAfterRunningCrash = await eventCount(events, "ask:");
	assert.equal(sendsAfterRunningCrash, 1);

	const fast = state(await invoke(afterRunningCrash.get("maestri_ask_async")!, {
		agent: "Farol",
		prompt: "reply",
		client_request_id: "crash-after-terminal",
	}));
	const fastTerminal = await waitForTerminal(request, fast.request_id);
	const afterCallerCrash = registerTools(env);
	const stable = state(await invoke(afterCallerCrash.get("maestri_ask_async")!, {
		agent: "Farol",
		prompt: "reply",
		client_request_id: "crash-after-terminal",
	}));
	assert.deepEqual(stable, fastTerminal);
	const stableResult = await invoke(afterCallerCrash.get("maestri_ask_request")!, {
		action: "result",
		request_id: fast.request_id,
	});
	assert.match(stableResult.content[0].text, /reply token=\[REDACTED\]/);
	assert.equal(await eventCount(events, "ask:"), sendsAfterRunningCrash + 1);
});

test("target replacement after native dispatch never resends or accepts the new generation", async (t) => {
	const { dir, env, events, tools } = await fixture(t);
	const ask = tools.get("maestri_ask_async")!;
	const request = tools.get("maestri_ask_request")!;
	const accepted = state(await invoke(ask, {
		agent: "Farol",
		prompt: "replacement:GEN-A",
		client_request_id: "replace-after-dispatch",
	}));
	assert.equal((await waitForFile(path.join(dir, "replacement-dispatched"))).trim(), "GEN-A");
	assert.equal(await eventCount(events, "ask:"), 1);
	const runningRecord = JSON.parse(await readFile(path.join(askStateRoot(env), `${accepted.request_id}.json`), "utf8"));
	assert.equal(runningRecord.phase, "running");
	await writeFile(path.join(dir, "replace-target"), "GEN-B");
	const terminal = await waitForTerminal(request, accepted.request_id);
	assert.deepEqual([terminal.delivery, terminal.reply], ["unknown", "unknown"]);
	await waitForGroupGone(runningRecord.runner.pgid);
	const replay = state(await invoke(ask, {
		agent: "Farol",
		prompt: "replacement:GEN-A",
		client_request_id: "replace-after-dispatch",
	}));
	assert.deepEqual(replay, terminal);
	assert.equal(await eventCount(events, "ask:"), 1);
	const evidence = await invoke(request, { action: "result", request_id: accepted.request_id });
	assert.equal(evidence.details.outputKind, "full-capture-evidence");
});

test("pending result exposes state only and never partial output", async (t) => {
	const { events, tools } = await fixture(t, { asyncKillGraceMs: 75 });
	const ask = tools.get("maestri_ask_async")!;
	const request = tools.get("maestri_ask_request")!;
	const running = state(await invoke(ask, {
		agent: "Farol",
		prompt: "partial-long",
		client_request_id: "pending-result",
	}));
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline && await eventCount(events, "ask:") < 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	const pending = await invoke(request, { action: "result", request_id: running.request_id });
	assert.equal(state(pending).phase, "running");
	assert.doesNotMatch(pending.content[0].text, /UNTRUSTED|private-async-token|partial/);
	await invoke(request, { action: "cancel", request_id: running.request_id });
});

test("isolates one matched reply envelope and rejects missing duplicate or malformed markers", async (t) => {
	const { env, tools } = await fixture(t);
	const sampleId = "00000000-0000-4000-8000-000000000000";
	const instruction = envelopedPrompt("task", sampleId);
	const marker = replyEnvelope(sampleId);
	assert.doesNotMatch(instruction, new RegExp(marker.begin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.deepEqual(
		extractReplyEnvelope(`${instruction}\n  ${marker.begin}  \nASYNC_OK\n  ${marker.end}  `, sampleId),
		{ reply: "received", content: "ASYNC_OK", reason: "envelope-received" },
	);
	const stale = replyEnvelope("11111111-1111-4111-8111-111111111111");
	assert.deepEqual(
		extractReplyEnvelope(`${stale.begin}\nstale\n${stale.end}\n${marker.begin}\nASYNC_OK\n${marker.end}`, sampleId),
		{ reply: "received", content: "ASYNC_OK", reason: "envelope-received" },
	);
	assert.equal(extractReplyEnvelope(`${stale.begin}\nstale\n${stale.end}`, sampleId).reply, "unknown");
	assert.equal(extractReplyEnvelope(`${marker.begin}\n${stale.begin}\nnested\n${stale.end}\n${marker.end}`, sampleId).reply, "unknown");
	assert.equal(extractReplyEnvelope(`${marker.begin}\nOK\n${marker.end}\nextra ${marker.end}`, sampleId).reply, "unknown");
	assert.equal(
		extractReplyEnvelope(`${marker.begin}\none\n${marker.end}\n${marker.begin}\ntwo\n${marker.end}`, sampleId).reply,
		"unknown",
	);
	const ask = tools.get("maestri_ask_async")!;
	const request = tools.get("maestri_ask_request")!;
	const isolated = state(await invoke(ask, { agent: "Farol", prompt: "isolation", client_request_id: "isolation" }));
	const isolatedTerminal = await waitForTerminal(request, isolated.request_id);
	assert.equal(isolatedTerminal.reply, "received");
	const isolatedResult = await invoke(request, { action: "result", request_id: isolated.request_id });
	assert.match(isolatedResult.content[0].text, /ASYNC_REPLY/);
	assert.doesNotMatch(isolatedResult.content[0].text, /noise-before|noise-after|old-reply|MAESTRI_REPLY_(?:BEGIN|END)/);
	assert.equal(isolatedResult.details.outputKind, "extracted-reply");
	assert.match(await readFile(outputPath(askStateRoot(env), isolated.request_id), "utf8"), /noise-before[\s\S]*noise-after/);
	for (const prompt of ["missing-envelope", "duplicate-envelope", "malformed-envelope"]) {
		const accepted = state(await invoke(ask, { agent: "Farol", prompt, client_request_id: prompt }));
		const terminal = await waitForTerminal(request, accepted.request_id);
		assert.equal(terminal.delivery, "confirmed", prompt);
		assert.equal(terminal.reply, "unknown", prompt);
		const evidence = await invoke(request, { action: "result", request_id: accepted.request_id });
		assert.equal(evidence.details.outputKind, "full-capture-evidence");
	}
});

test("cleanup uncertainty resolves terminal unknown without reporting cancellation", async (t) => {
	const { env, tools } = await fixture(t, {
		asyncKillGraceMs: 75,
		asyncCancelProcessGroup: async () => false,
	});
	const ask = tools.get("maestri_ask_async")!;
	const request = tools.get("maestri_ask_request")!;
	const running = state(await invoke(ask, { agent: "Farol", prompt: "long", client_request_id: "cleanup-unknown" }));
	const refused = state(await invoke(request, { action: "cancel", request_id: running.request_id }));
	assert.equal(refused.phase, "running");
	assert.equal(refused.reply, "unknown");
	assert.match(refused.refusal ?? "", /not reported/);
	const persisted = JSON.parse(await readFile(path.join(askStateRoot(env), `${running.request_id}.json`), "utf8"));
	assert.equal(persisted.phase, "running");
	assert.equal(persisted.custody, "orphan");
	await assert.rejects(
		invoke(ask, { agent: "Farol", prompt: "long", client_request_id: "blocked-after-cleanup" }),
		/already has active async request/,
	);
	process.kill(-persisted.runner.pgid, "SIGKILL");
	await waitForGroupGone(persisted.runner.pgid);
	await invoke(request, { action: "status", request_id: running.request_id });
});

test("refuses non-ready targets before creating or launching a request", async (t) => {
	const { env, events, tools } = await fixture(t);
	const ask = tools.get("maestri_ask_async")!;
	for (const agent of ["Busy", "Spinner", "Shell", "Blank", "NonPi", "Ambiguous", "MultiFooter", "Retrying", "ShellFooter", "ThinkingHigh", "Stale", "Missing"]) {
		await assert.rejects(invoke(ask, {
			agent,
			prompt: "reply",
			client_request_id: `not-ready-${agent}`,
		}), /no async request was launched/);
	}
	assert.doesNotThrow(() => assertReadyPiScreen("~/project GPT-5.6 Sol • off"));
	assert.doesNotThrow(() => assertReadyPiScreen("GPT-5.6 Sol • thinking off"));
	assert.equal(await eventCount(events, "ask:"), 0);
	const root = askStateRoot(env);
	assert.deepEqual((await import("node:fs/promises").then((fs) => fs.readdir(root))).filter((name) => name.endsWith(".json")), []);
	const timed = registerTools(env, { asyncPreflightTimeoutMs: 75 });
	await assert.rejects(invoke(timed.get("maestri_ask_async")!, {
		agent: "Slow",
		prompt: "reply",
		client_request_id: "not-ready-timeout",
	}), /readiness check failed/);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		ask.execute("call", {
			agent: "Farol",
			prompt: "reply",
			client_request_id: "not-ready-abort",
		}, controller.signal, undefined, { cwd: "/tmp" }),
		/readiness check failed/,
	);
	assert.equal(await eventCount(events, "ask:"), 0);
	assert.deepEqual((await import("node:fs/promises").then((fs) => fs.readdir(root))).filter((name) => /\.json$|\.out$/.test(name)), []);
	const accepted = state(await invoke(ask, {
		agent: "ThinkingOff",
		prompt: "reply",
		client_request_id: "ready-thinking-off",
	}));
	await waitForTerminal(tools.get("maestri_ask_request")!, accepted.request_id);
	assert.equal(await eventCount(events, "ask:"), 1);
});

test("caps raw output and returns only sanitized untrusted terminal output", async (t) => {
	const { env, tools } = await fixture(t);
	const ask = tools.get("maestri_ask_async")!;
	const request = tools.get("maestri_ask_request")!;
	const success = state(await invoke(ask, { agent: "Farol", prompt: "reply", client_request_id: "reply" }));
	await waitForTerminal(request, success.request_id);
	const root = askStateRoot(env);
	assert.doesNotMatch(await readFile(outputPath(root, success.request_id), "utf8"), /private-async-token/);
	const rotated = registerTools({ ...env, MAESTRI_TOKEN: "rotated-token" });
	const result = await invoke(rotated.get("maestri_ask_request")!, { action: "result", request_id: success.request_id });
	assert.match(result.content[0].text, /UNTRUSTED PEER OUTPUT/);
	assert.doesNotMatch(result.content[0].text, /private-async-token/);
	const absent = registerTools({ ...env, MAESTRI_TOKEN: undefined });
	const absentResult = await invoke(absent.get("maestri_ask_request")!, { action: "result", request_id: success.request_id });
	assert.doesNotMatch(absentResult.content[0].text, /private-async-token/);
	const many = state(await invoke(ask, { agent: "Farol", prompt: "many", client_request_id: "many" }));
	await waitForTerminal(request, many.request_id);
	const manyResult = await invoke(request, { action: "result", request_id: many.request_id });
	assert.equal(manyResult.details.truncated, true);
	assert.match(manyResult.content[0].text, /\[TRUNCATED:/);
	assert.doesNotMatch(manyResult.content[0].text, /private-async-token|password@example|hidden-bidi|\u001b|\u202e/);
	assert.ok(Buffer.byteLength(manyResult.content[0].text) <= 50 * 1024);
	assert.ok(manyResult.content[0].text.split("\n").length <= 2_000);
	assert.equal((await stat(outputPath(root, many.request_id))).mode & 0o777, 0o600);
	const noisy = state(await invoke(ask, { agent: "Farol", prompt: "noisy", client_request_id: "noisy" }));
	const terminal = await waitForTerminal(request, noisy.request_id);
	assert.equal(terminal.delivery, "unknown");
	assert.equal(terminal.reply, "unknown");
	const capped = await invoke(request, { action: "result", request_id: noisy.request_id });
	assert.equal(capped.details.outputKind, "discarded");
	assert.match(capped.content[0].text, /UNTRUSTED PEER OUTPUT/);
	assert.match(capped.content[0].text, /partial output was discarded/);
	assert.ok(Buffer.byteLength(capped.content[0].text) <= 50 * 1024);
	assert.equal((await stat(outputPath(root, noisy.request_id))).size, 0);
	assert.doesNotMatch(JSON.stringify(capped.details), /x{20}|private-async-token/);
});

test("times out and kills a TERM-ignoring process group without exposing partial output", async (t) => {
	const { dir, env, events, tools } = await fixture(t, { asyncAskTimeoutMs: 75, asyncKillGraceMs: 75 });
	const ask = tools.get("maestri_ask_async")!;
	const request = tools.get("maestri_ask_request")!;
	const accepted = state(await invoke(ask, { agent: "Farol", prompt: "timeout", client_request_id: "timeout" }));
	const terminal = accepted.phase === "terminal" ? accepted : await waitForTerminal(request, accepted.request_id);
	assert.equal(terminal.delivery, "unknown");
	assert.equal(terminal.reply, "unknown");
	const root = askStateRoot(env);
	const record = JSON.parse(await readFile(path.join(root, `${accepted.request_id}.json`), "utf8"));
	assert.equal(record.terminal.termination, "timeout");
	assert.equal((await stat(path.join(root, `${accepted.request_id}.out`))).size, 0);
	const descendant = Number((await waitForFile(path.join(dir, "descendant"))).trim());
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.throws(() => process.kill(descendant, 0));
	await waitForGroupGone(record.runner.pgid);
	const result = await invoke(request, { action: "result", request_id: accepted.request_id });
	assert.equal(result.details.outputKind, "discarded");
	assert.doesNotMatch(result.content[0].text, /github_pat_|PARTIAL_SECRET/);
	assert.match(result.content[0].text, /partial output was discarded/);
	const leader = state(await invoke(ask, { agent: "Farol", prompt: "leader-exits", client_request_id: "timeout-leader" }));
	const leaderTerminal = leader.phase === "terminal" ? leader : await waitForTerminal(request, leader.request_id);
	assert.deepEqual([leaderTerminal.delivery, leaderTerminal.reply], ["unknown", "unknown"]);
	const leaderRecord = JSON.parse(await readFile(path.join(root, `${leader.request_id}.json`), "utf8"));
	assert.equal(leaderRecord.terminal.termination, "timeout");
	const leaderDescendant = Number((await waitForFile(path.join(dir, "descendant-leader"))).trim());
	assert.throws(() => process.kill(leaderDescendant, 0));
	await waitForGroupGone(leaderRecord.runner.pgid);
	assert.equal((await stat(outputPath(root, leader.request_id))).size, 0);
	const normal = state(await invoke(ask, { agent: "Farol", prompt: "normal-descendant", client_request_id: "normal-descendant" }));
	const normalTerminal = normal.phase === "terminal" ? normal : await waitForTerminal(request, normal.request_id);
	assert.deepEqual([normalTerminal.delivery, normalTerminal.reply], ["unknown", "unknown"]);
	const normalRecord = JSON.parse(await readFile(path.join(root, `${normal.request_id}.json`), "utf8"));
	assert.equal(normalRecord.terminal.termination, "process-error");
	const normalDescendant = Number((await waitForFile(path.join(dir, "descendant-normal"))).trim());
	assert.throws(() => process.kill(normalDescendant, 0));
	await waitForGroupGone(normalRecord.runner.pgid);
	assert.equal((await stat(outputPath(root, normal.request_id))).size, 0);
	const normalResult = await invoke(request, { action: "result", request_id: normal.request_id });
	assert.doesNotMatch(normalResult.content[0].text, /premature-success/);
	assert.equal(await eventCount(events, "ask:"), 3);
});

test("cancellation empties the process group, is idempotent, and leaves completed results unchanged", async (t) => {
	const { dir, env, events, tools } = await fixture(t, { asyncAskTimeoutMs: 60_000, asyncKillGraceMs: 75 });
	const ask = tools.get("maestri_ask_async")!;
	const request = tools.get("maestri_ask_request")!;
	const root = askStateRoot(env);
	await ensureAskStateRoot(env);
	const accepted = acceptedRecord("cancel-accepted", "never-send", path.basename(root));
	await createAcceptedRequest(root, accepted, clientDigest(accepted.client_request_id));
	const acceptedCancel = state(await invoke(request, { action: "cancel", request_id: accepted.request_id }));
	assert.deepEqual([acceptedCancel.delivery, acceptedCancel.reply], ["not-attempted", "cancelled"]);
	const acceptedAgain = state(await invoke(request, { action: "cancel", request_id: accepted.request_id }));
	assert.equal(acceptedAgain.state_version, acceptedCancel.state_version);
	const running = state(await invoke(ask, { agent: "Farol", prompt: "timeout", client_request_id: "cancel-tree" }));
	const descendant = Number((await waitForFile(path.join(dir, "descendant"))).trim());
	const before = JSON.parse(await readFile(path.join(root, `${running.request_id}.json`), "utf8"));
	const first = state(await invoke(request, { action: "cancel", request_id: running.request_id }));
	assert.equal(first.reply, "cancelled");
	assert.throws(() => process.kill(descendant, 0));
	assert.throws(() => process.kill(-before.runner.pgid, 0));
	const second = state(await invoke(request, { action: "cancel", request_id: running.request_id }));
	assert.equal(second.state_version, first.state_version);
	const replay = state(await invoke(ask, { agent: "Farol", prompt: "timeout", client_request_id: "cancel-tree" }));
	assert.deepEqual(replay, first);
	assert.equal(await eventCount(events, "ask:"), 1);
	const cancelledResult = await invoke(request, { action: "result", request_id: running.request_id });
	assert.equal(cancelledResult.details.outputKind, "discarded");
	assert.doesNotMatch(cancelledResult.content[0].text, /github_pat_|PARTIAL_SECRET/);
	const completed = state(await invoke(ask, { agent: "Farol", prompt: "reply", client_request_id: "completed-cancel" }));
	const completedState = await waitForTerminal(request, completed.request_id);
	const afterCancel = state(await invoke(request, { action: "cancel", request_id: completed.request_id }));
	assert.deepEqual(afterCancel, completedState);
});

test("an already-aborted cancellation does not change or signal the request", async (t) => {
	const { env, tools } = await fixture(t, { asyncAskTimeoutMs: 60_000, asyncKillGraceMs: 75 });
	const ask = tools.get("maestri_ask_async")!;
	const request = tools.get("maestri_ask_request")!;
	const running = state(await invoke(ask, { agent: "Farol", prompt: "long", client_request_id: "abort-before-cancel" }));
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		invoke(request, { action: "cancel", request_id: running.request_id }, controller.signal),
		/abort/i,
	);
	const persisted = JSON.parse(await readFile(path.join(askStateRoot(env), `${running.request_id}.json`), "utf8"));
	assert.equal(persisted.phase, "running");
	assert.equal(persisted.custody, "held");
	assert.doesNotThrow(() => process.kill(-persisted.runner.pgid, 0));
	const cleaned = state(await invoke(request, { action: "cancel", request_id: running.request_id }));
	assert.equal(cleaned.reply, "cancelled");
});

test("never signals a runner whose exact process identity no longer matches", async (t) => {
	const { env, tools } = await fixture(t);
	const ask = tools.get("maestri_ask_async")!;
	const request = tools.get("maestri_ask_request")!;
	const accepted = state(await invoke(ask, { agent: "Farol", prompt: "long", client_request_id: "identity" }));
	const recordFile = path.join(askStateRoot(env), `${accepted.request_id}.json`);
	const record = JSON.parse(await readFile(recordFile, "utf8"));
	record.runner.identity.start_time = "0";
	await writeFile(recordFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	const cancelled = state(await invoke(request, { action: "cancel", request_id: accepted.request_id }));
	assert.match(cancelled.refusal ?? "", /no signal was sent/);
	assert.equal(cancelled.delivery, "unknown");
	assert.equal(cancelled.reply, "unknown");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.doesNotThrow(() => process.kill(record.runner.pid, 0));
	const refused = JSON.parse(await readFile(recordFile, "utf8"));
	assert.equal(refused.phase, "running");
	assert.equal(refused.custody, "orphan");
	assert.equal(refused.custody_reason, "cancellation-process-identity-mismatch");
	await assert.rejects(
		invoke(ask, { agent: "Farol", prompt: "long", client_request_id: "blocked-by-orphan" }),
		/already has active async request/,
	);
	process.kill(-record.runner.pgid, "SIGKILL");
	await waitForGroupGone(record.runner.pgid);
	await invoke(request, { action: "status", request_id: accepted.request_id });
	const pgidCase = state(await invoke(ask, { agent: "Farol", prompt: "long", client_request_id: "pgid" }));
	const pgidFile = path.join(askStateRoot(env), `${pgidCase.request_id}.json`);
	const pgidRecord = JSON.parse(await readFile(pgidFile, "utf8"));
	const actualPgid = pgidRecord.runner.pgid;
	pgidRecord.runner.pgid += 1;
	await writeFile(pgidFile, `${JSON.stringify(pgidRecord)}\n`, { mode: 0o600 });
	const pgidRefusal = state(await invoke(request, { action: "cancel", request_id: pgidCase.request_id }));
	assert.match(pgidRefusal.refusal ?? "", /no signal was sent/);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.doesNotThrow(() => process.kill(pgidRecord.runner.pid, 0));
	process.kill(-actualPgid, "SIGKILL");
});

test("uncertain process identity resolves terminal unknown without signalling", async (t) => {
	const { env, tools } = await fixture(t);
	const ask = tools.get("maestri_ask_async")!;
	const request = tools.get("maestri_ask_request")!;
	const first = state(await invoke(ask, { agent: "Farol", prompt: "long", client_request_id: "uncertain-status" }));
	const firstRecord = JSON.parse(await readFile(path.join(askStateRoot(env), `${first.request_id}.json`), "utf8"));
	const uncertain = registerTools(env, { asyncReadProcessIdentity: async () => { throw new Error("uncertain"); } });
	const status = state(await invoke(uncertain.get("maestri_ask_request")!, { action: "status", request_id: first.request_id }));
	assert.deepEqual([status.phase, status.delivery, status.reply], ["running", "unknown", "unknown"]);
	assert.doesNotThrow(() => process.kill(firstRecord.runner.pid, 0));
	const firstPersisted = JSON.parse(await readFile(path.join(askStateRoot(env), `${first.request_id}.json`), "utf8"));
	assert.equal(firstPersisted.custody, "orphan");
	assert.equal(firstPersisted.phase, "running");
	process.kill(-firstRecord.runner.pgid, "SIGKILL");
	await waitForGroupGone(firstRecord.runner.pgid);
	await invoke(request, { action: "status", request_id: first.request_id });
	const second = state(await invoke(ask, { agent: "Farol", prompt: "long", client_request_id: "uncertain-cancel" }));
	const secondRecord = JSON.parse(await readFile(path.join(askStateRoot(env), `${second.request_id}.json`), "utf8"));
	const cancelled = state(await invoke(uncertain.get("maestri_ask_request")!, { action: "cancel", request_id: second.request_id }));
	assert.deepEqual([cancelled.phase, cancelled.delivery, cancelled.reply], ["running", "unknown", "unknown"]);
	assert.doesNotThrow(() => process.kill(secondRecord.runner.pid, 0));
	const secondPersisted = JSON.parse(await readFile(path.join(askStateRoot(env), `${second.request_id}.json`), "utf8"));
	assert.equal(secondPersisted.custody, "orphan");
	process.kill(-secondRecord.runner.pgid, "SIGKILL");
});
