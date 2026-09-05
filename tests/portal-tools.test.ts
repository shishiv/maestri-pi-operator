import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { portalCommand, type PortalInput } from "../src/portal-command.ts";
import { invokePortal } from "../src/portal-output.ts";
import type { MaestriExec, MaestriExecOptions } from "../src/maestri.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQCbn9HwAERgJTEuXMlgAAAABJRU5ErkJggg==", "base64");

async function fixture(t: TestContext, execute?: MaestriExec) {
	const dir = await mkdtemp(path.join(tmpdir(), "mpo-portal-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const cli = path.join(dir, "maestri");
	await writeFile(cli, '#!/usr/bin/env node\nconsole.log(JSON.stringify({argv:process.argv.slice(2),token:process.env.MAESTRI_TOKEN}));\n', { mode: 0o700 });
	const options = {
		cwd: dir, platform: "linux" as const, execute,
		env: { PATH: process.env.PATH, HOME: dir, MAESTRI_CLI: cli, MAESTRI_SOCKET: path.join(dir, "fixture.sock"), MAESTRI_WORKSPACE_ID: "fixture-ws", MAESTRI_TOKEN: "fixture-private-token", GITHUB_TOKEN: "do-not-pass" },
	};
	return {
		dir,
		invoke(input: PortalInput, device = false, signal?: AbortSignal) {
			const kind = device ? "portal_device" : "portal";
			return invokePortal(kind, portalCommand(kind, input), { ...options, signal });
		},
	};
}

function output(stdout: string, code = 0) {
	return { stdout, stderr: "", code, killed: false, termination: null, totalOutputBytes: Buffer.byteLength(stdout) };
}

test("translates portal operations to the native CLI contract, without aliases that change meaning", () => {
	const cases: Array<[PortalInput, string[], boolean?]> = [
		[{ action: "create", url: "http://localhost:3000", name: "Web", width: 390, height: 844 }, ["create", "http://localhost:3000", "Web", "--size", "390x844"]],
		[{ action: "create", device: "emulator-5554", name: "Pixel" }, ["create", "--simulator", "emulator-5554", "Pixel"], true],
		[{ action: "devices" }, ["devices"], true],
		[{ action: "edit", portal: "Web", url: "about:blank" }, ["edit", "Web", "--url", "about:blank"]],
		[{ action: "navigate", portal: "Pixel", url: "exp://localhost:8081" }, ["navigate", "Pixel", "exp://localhost:8081"], true],
		[{ action: "fill", portal: "Web", selector: "@e2", text: "literal\\n\n" }, ["fill", "Web", "@e2", "literal\\\\n\n"]],
		[{ action: "fill", portal: "Web", selector: "#q", text: "" }, ["fill", "Web", "#q", ""]],
		[{ action: "type", portal: "Web", selector: "#q", text: "--help" }, ["type", "Web", "#q", "--help"]],
		[{ action: "type", portal: "Pixel", text: "literal\\t" }, ["type", "Pixel", "literal\\\\t"], true],
		[{ action: "select", portal: "Web", selector: "@e2", value: "literal\\n" }, ["select", "Web", "@e2", "literal\\n"]],
		[{ action: "evaluate", portal: "Web", expression: '"literal\\n"' }, ["evaluate", "Web", '"literal\\n"']],
		[{ action: "scroll", portal: "Web", direction: "down", selector: "#pane" }, ["scroll", "Web", "down", "300", "#pane"]],
		[{ action: "scroll", portal: "Pixel", direction: "up", amount: 400 }, ["scroll", "Pixel", "up", "400"], true],
		[{ action: "drag", portal: "Web", selector: "@e2", to: "@e3" }, ["drag", "Web", "@e2", "@e3"]],
		[{ action: "swipe", portal: "Pixel", selector: "@e2", to: "50,100" }, ["swipe", "Pixel", "@e2", "50,100"], true],
		[{ action: "tap", portal: "Pixel", selector: "50.5,100" }, ["tap", "Pixel", "50.5,100"], true],
		[{ action: "button", portal: "Pixel", key: "home" }, ["button", "Pixel", "home"], true],
		[{ action: "key", portal: "Web", key: "ctrl+a" }, ["key", "Web", "ctrl+a"]],
		[{ action: "launch", portal: "Pixel", package: "com.example.app" }, ["launch", "Pixel", "com.example.app"], true],
		[{ action: "terminate", portal: "Pixel", package: "com.example.app" }, ["terminate", "Pixel", "com.example.app"], true],
		[{ action: "wait", portal: "Web", selector: "@e2" }, ["wait", "Web", "@e2", "5000"]],
		[{ action: "wait", portal: "Web", selector: "@e2", timeout_ms: 8000 }, ["wait", "Web", "@e2", "8000"]],
		[{ action: "resize", portal: "Web", width: 390, height: 844 }, ["resize", "Web", "390", "844"]],
		[{ action: "ua", portal: "Web", preset: "firefox-android" }, ["ua", "Web", "firefox-android"]],
	];
	for (const action of ["click", "focus", "uncheck", "hover", "scrollintoview", "text"]) {
		cases.push([{ action, portal: "Web", selector: "@e2" }, [action, "Web", "@e2"]]);
	}
	for (const action of ["info", "snapshot", "screenshot", "html", "logs", "logs-start", "selectall", "clear", "ua", "close"]) {
		cases.push([{ action, portal: "Web" }, [action, "Web"]]);
	}
	for (const [input, expected, device] of cases) {
		assert.deepEqual(portalCommand(device ? "portal_device" : "portal", input).args, expected);
	}
});

test("rejects action-specific missing/extra fields, option confusion, CSS on Android and unsafe values before dispatch", async (t) => {
	let calls = 0;
	const { invoke } = await fixture(t, async () => { calls++; return output("ok"); });
	const invalid: Array<[PortalInput, boolean?]> = [
		[{ action: "check", portal: "Web", selector: "@e2" }],
		[{ action: "create", url: "about:blank", name: "--simulator" }],
		[{ action: "create", device: "--help" }, true],
		[{ action: "create", url: "about:blank", width: 390 }],
		[{ action: "fill", portal: "Web", selector: "@e2" }],
		[{ action: "fill", portal: "Web", selector: "@e2", text: "\\".repeat(32_769) }],
		[{ action: "type", portal: "Web", text: "é".repeat(32_769) }],
		[{ action: "type", portal: "Web", text: "\0" }],
		[{ action: "snapshot", portal: " Web" }],
		[{ action: "snapshot", portal: "Web\n" }],
		[{ action: "snapshot", portal: "Web", text: "ignored?" }],
		[{ action: "close" }],
		[{ action: "tap", portal: "Pixel", selector: "#q" }, true],
		[{ action: "fill", portal: "Pixel", selector: "@e2", text: "hello" }, true],
		[{ action: "create", device: "emulator-5554", url: "about:blank" }, true],
		[{ action: "navigate", portal: "Web", url: "--help" }],
		[{ action: "wait", portal: "Web", selector: "@e2", timeout_ms: 15000 }],
		[{ action: "resize", portal: "Web", width: NaN, height: 844 }],
		[{ action: "scroll", portal: "Web", direction: "sideways" }],
		[{ action: "ua", portal: "Web", preset: "invented" }],
	];
	for (const [input, device] of invalid) await assert.rejects(async () => invoke(input, device));
	assert.equal(calls, 0);
});

test("uses the shared bounded process, literal argv and minimal environment", async (t) => {
	const { dir, invoke } = await fixture(t);
	const sentinel = path.join(dir, "must-not-exist");
	const expression = '"$(touch ' + sentinel + ')\\n"';
	const result = await invoke({ action: "evaluate", portal: "Web; $(false)", expression });
	const text = result.content[0];
	assert.equal(text.type, "text");
	if (text.type !== "text") throw new Error("expected text");
	assert.match(text.text, /^UNTRUSTED PEER OUTPUT/);
	assert.deepEqual(JSON.parse(text.text.slice(text.text.indexOf("\n") + 1)), { argv: ["portal", "evaluate", "Web; $(false)", expression], token: "[REDACTED]" });
	await assert.rejects(access(sentinel));
});

test("turns native zero-exit interaction failures into errors without retrying or misclassifying page text", async (t) => {
	let body = "click failed — element not found\n";
	let calls = 0;
	const { invoke } = await fixture(t, async () => { calls++; return output(body); });
	await assert.rejects(invoke({ action: "click", portal: "Web", selector: "@e2" }), /click failed.*\n.*Do not retry/s);
	body = "timeout waiting for @e2\n";
	await assert.rejects(invoke({ action: "wait", portal: "Web", selector: "@e2" }), /timeout waiting/);
	body = "Error: portal not loaded\n";
	await assert.rejects(invoke({ action: "snapshot", portal: "Web" }), /portal not loaded/);
	for (const action of ["evaluate", "text"]) {
		const input = action === "evaluate" ? { action, portal: "Web", expression: '"Error: portal not loaded"' } : { action, portal: "Web", selector: "@e2" };
		assert.ok((await invoke(input)).content.every((part) => part.type === "text"));
	}
	assert.equal(calls, 5);
});

test("cancellation discards output, keeps device timeout distinct and never repeats mutations", async (t) => {
	const calls: MaestriExecOptions[] = [];
	const { invoke } = await fixture(t, async (_command, _args, options) => {
		calls.push(options);
		return { ...output("PARTIAL_CAPTURE_CANARY fixture-private-token"), killed: true, termination: "timeout" };
	});
	await assert.rejects(invoke({ action: "type", portal: "Web", text: "hello" }), (error: Error) => {
		assert.match(error.message, /15000ms.*Completion may be unknown/);
		assert.doesNotMatch(error.message, /PARTIAL_CAPTURE_CANARY|fixture-private-token/);
		return true;
	});
	await assert.rejects(invoke({ action: "tap", portal: "Pixel", selector: "@e2" }, true), /90000ms/);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(invoke({ action: "close", portal: "Web" }, false, controller.signal), /cancelled before execution/);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].env.GITHUB_TOKEN, undefined);
});

test("returns native PNG bytes unchanged with dimensions, but never follows paths in page data", async (t) => {
	const file = path.join(tmpdir(), `maestri-portal-${randomUUID()}.png`);
	await writeFile(file, PNG);
	t.after(() => rm(file, { force: true }));
	const { invoke } = await fixture(t, async () => output(file + "\n"));
	for (const device of [false, true]) {
		const result = await invoke({ action: "screenshot", portal: "View" }, device);
		const image = result.content.find((part) => part.type === "image");
		assert.ok(image?.type === "image");
		assert.equal(image.mimeType, "image/png");
		assert.deepEqual(Buffer.from(image.data, "base64"), PNG);
		assert.ok(result.content.some((part) => part.type === "text" && part.text.includes("1x1px")));
	}
	const data = await invoke({ action: "evaluate", portal: "View", expression: "'path'" });
	assert.ok(data.content.every((part) => part.type === "text"));
});

test("rejects screenshot symlinks, other locations, non-PNGs, duplicate paths and oversized images", async (t) => {
	const file = path.join(tmpdir(), `maestri-portal-${randomUUID()}.png`);
	t.after(() => rm(file, { force: true }));
	let body = file;
	const { dir, invoke } = await fixture(t, async () => output(body));
	const capture = () => invoke({ action: "screenshot", portal: "View" });
	await writeFile(path.join(dir, "private"), PNG);
	await symlink(path.join(dir, "private"), file);
	await assert.rejects(capture(), /image unavailable/);
	await rm(file);
	await writeFile(file, "not a PNG".repeat(20));
	await assert.rejects(capture(), /image unavailable/);
	await writeFile(file, PNG);
	body = "/elsewhere" + file;
	await assert.rejects(capture(), /image unavailable/);
	body = file + "\n" + file;
	await assert.rejects(capture(), /image unavailable/);
	body = file;
	const tooWide = Buffer.from(PNG); tooWide.writeUInt32BE(25_000_001, 16);
	await writeFile(file, tooWide);
	await assert.rejects(capture(), /image unavailable/);
	await writeFile(file, Buffer.alloc(10 * 1024 * 1024 + 1));
	await assert.rejects(capture(), /image unavailable/);
});
