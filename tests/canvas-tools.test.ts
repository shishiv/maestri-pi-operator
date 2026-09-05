import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Assert } from "typebox/value";
import { registerCanvasTools } from "../src/canvas-tools.ts";
import { MAESTRI_CHECK_TIMEOUT_MS, type MaestriExec, type MaestriExecOptions } from "../src/maestri.ts";

async function fixture(t: TestContext, execute?: MaestriExec) {
	const dir = await mkdtemp(path.join(tmpdir(), "maestri-canvas-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const cli = path.join(dir, "maestri");
	await writeFile(cli, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), token: process.env.MAESTRI_TOKEN }));\n', { mode: 0o700 });
	const tools = new Map<string, Pick<ToolDefinition, "parameters" | "execute">>();
	registerCanvasTools({ registerTool(tool) { tools.set(tool.name, tool); } }, {
		env: {
			HOME: dir,
			XDG_STATE_HOME: path.join(dir, "state"),
			PATH: process.env.PATH,
			MAESTRI_CLI: cli,
			MAESTRI_WORKSPACE_ID: "fixture-workspace",
			MAESTRI_SOCKET: path.join(dir, "fixture.sock"),
			MAESTRI_TOKEN: "fixture-secret-token",
			GITHUB_TOKEN: "unrelated-secret",
		},
		platform: "linux",
		execute,
	});
	const ctx = { cwd: dir } as ExtensionContext;
	return {
		dir,
		async invoke(name: string, params: Record<string, unknown>, signal?: AbortSignal) {
			const tool = tools.get(name);
			assert.ok(tool, name);
			Assert(tool.parameters, params);
			return tool.execute("call", params, signal, undefined, ctx);
		},
	};
}

test("maps typed role and note calls to fixed literal argv without planning or journaling", async (t) => {
	const calls: Array<{ command: string; args: string[]; options: MaestriExecOptions }> = [];
	const { dir, invoke } = await fixture(t, async (command, args, options) => {
		calls.push({ command, args, options });
		return { stdout: "ok", stderr: "", code: 0, killed: false, termination: null, totalOutputBytes: 2 };
	});
	const name = "Note; $(literal)";
	const text = "- item\nLiteral \\n and \\t";
	const encoded = "- item\nLiteral \\\\n and \\\\t";
	const cases = [
		{ tool: "maestri_role_list", params: {}, argv: ["role", "list"] },
		{ tool: "maestri_role_show", params: { name }, argv: ["role", "show", name] },
		{ tool: "maestri_role_create", params: { name, prompt: text }, argv: ["role", "create", name, encoded, "--scope", "current"] },
		{ tool: "maestri_note_read", params: { name }, argv: ["note", "read", name] },
		{ tool: "maestri_note_read", params: { name, offset: 10, limit: 20 }, argv: ["note", "read", name, "10", "20"] },
		{ tool: "maestri_note_read", params: { name, offset: 10 }, argv: ["note", "read", name, "10"] },
		{ tool: "maestri_note_read", params: { name, limit: 20 }, argv: ["note", "read", name, "1", "20"] },
		{ tool: "maestri_note_create", params: { name, content: text, stack: "Book" }, argv: ["note", "create", "--name", name, "--stack", "Book", encoded] },
		{ tool: "maestri_note_create", params: { name }, argv: ["note", "create", "--name", name, ""] },
		{ tool: "maestri_note_edit", params: { name, oldText: text, newText: "" }, argv: ["note", "edit", name, encoded, ""] },
		{ tool: "maestri_note_edit", params: { name, oldText: "before", newText: text }, argv: ["note", "edit", name, "before", encoded] },
		{ tool: "maestri_note_stack", params: { name, stack: "Book" }, argv: ["note", "stack", name, "Book"] },
		{ tool: "maestri_note_stack", params: { name }, argv: ["note", "stack", name] },
	];
	const controller = new AbortController();
	for (const entry of cases) await invoke(entry.tool, entry.params, controller.signal);
	assert.deepEqual(calls.map((call) => call.args), cases.map((entry) => entry.argv));
	for (const call of calls) {
		assert.equal(call.command, path.join(dir, "maestri"));
		assert.equal(call.options.cwd, dir);
		assert.equal(call.options.signal, controller.signal);
		assert.equal(call.options.timeoutMs, MAESTRI_CHECK_TIMEOUT_MS);
		assert.equal(call.options.env.GITHUB_TOKEN, undefined);
	}
	await assert.rejects(access(path.join(dir, "state")));
});

test("rejects unsafe CLI inputs, scope overrides, and cancelled calls before dispatch", async (t) => {
	let calls = 0;
	const { invoke } = await fixture(t, async () => {
		calls += 1;
		throw new Error("must not execute");
	});
	for (const entry of [
		{ tool: "maestri_role_show", params: { name: "--help" } },
		{ tool: "maestri_note_read", params: { name: "bad\0name" } },
		{ tool: "maestri_note_create", params: { name: "Safe", stack: "--help" } },
		{ tool: "maestri_note_create", params: { name: "Safe", content: "--stack" } },
		{ tool: "maestri_note_create", params: { name: "Safe", content: "--name" } },
		{ tool: "maestri_note_create", params: { name: "Safe", content: "\\".repeat(32_769) } },
		{ tool: "maestri_note_edit", params: { name: "Safe", oldText: "before", newText: "\0" } },
		{ tool: "maestri_note_edit", params: { name: "Safe", oldText: "", newText: "after" } },
		{ tool: "maestri_role_create", params: { name: "Safe", prompt: "é".repeat(32_769) } },
		{ tool: "maestri_role_create", params: { name: "Safe", prompt: "prompt", scope: "global" } },
		{ tool: "maestri_note_read", params: { name: "Safe", offset: 0 } },
	]) await assert.rejects(invoke(entry.tool, entry.params));
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(invoke("maestri_note_create", { name: "Safe" }, controller.signal), /cancelled before execution/);
	assert.equal(calls, 0);
});

test("runs note creation without a shell and returns only redacted untrusted CLI output", async (t) => {
	const { dir, invoke } = await fixture(t);
	const sentinel = path.join(dir, "must-not-exist");
	const name = "Note; touch " + sentinel;
	const content = "$(touch " + sentinel + ")\nLiteral \\n";
	const result = await invoke("maestri_note_create", { name, content });
	const output = result.content.find((part) => part.type === "text");
	assert.ok(output);
	assert.match(output.text, /^UNTRUSTED PEER OUTPUT/);
	assert.doesNotMatch(output.text, /fixture-secret-token/);
	assert.deepEqual(JSON.parse(output.text.slice(output.text.indexOf("\n") + 1)), {
		argv: ["note", "create", "--name", name, "$(touch " + sentinel + ")\nLiteral \\\\n"],
		token: "[REDACTED]",
	});
	await assert.rejects(access(sentinel));
});

test("surfaces native failures and unknown mutation completion without retrying or leaking output", async (t) => {
	let mode = "denied";
	let calls = 0;
	const { invoke } = await fixture(t, async () => {
		calls += 1;
		if (mode === "throw") throw new Error("fixture-secret-token");
		return {
			stdout: mode === "timeout" ? "partial fixture-secret-token" : "",
			stderr: mode === "denied" ? "Maestro Mode required: fixture-secret-token" : "",
			code: 1,
			killed: mode === "timeout",
			termination: mode === "timeout" ? "timeout" : null,
			totalOutputBytes: 60,
		};
	});
	await assert.rejects(invoke("maestri_role_list", {}), (error: Error) => {
		assert.match(error.message, /Maestro Mode required/);
		assert.doesNotMatch(error.message, /fixture-secret-token/);
		return true;
	});
	mode = "timeout";
	await assert.rejects(invoke("maestri_note_edit", { name: "Safe", oldText: "a", newText: "b" }), (error: Error) => {
		assert.match(error.message, /Completion is unknown.*maestri_note_read.*do not retry automatically/);
		assert.doesNotMatch(error.message, /partial fixture-secret-token/);
		return true;
	});
	mode = "throw";
	await assert.rejects(invoke("maestri_role_create", { name: "Safe", prompt: "prompt" }), (error: Error) => {
		assert.match(error.message, /Completion is unknown.*maestri_role_show/);
		assert.doesNotMatch(error.message, /fixture-secret-token/);
		return true;
	});
	assert.equal(calls, 3);
});
