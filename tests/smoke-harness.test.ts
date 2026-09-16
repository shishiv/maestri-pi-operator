import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const smokeScript = fileURLToPath(new URL("./smoke-v01.sh", import.meta.url));
const controlledPi = [
	"#!/usr/bin/env node",
	'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
	'import { spawnSync } from "node:child_process";',
	"const args = process.argv.slice(2);",
	'const toolsIndex = args.indexOf("--tools");',
	'if (toolsIndex < 0) throw new Error("missing --tools");',
	"const tools = args[toolsIndex + 1];",
	"const prompt = args.at(-1);",
	"const callsFile = process.env.MPO_SMOKE_HARNESS_CALLS;",
	'if (!callsFile) throw new Error("missing call counter");',
	"let call = 1;",
	"try { call = Number(readFileSync(callsFile, \"utf8\")) + 1; } catch {}",
	'writeFileSync(callsFile, String(call));',
	"let toolName;",
	"let toolArgs;",
	"let cliArgs;",
	'if (tools === "maestri_list") {',
	'	toolName = "maestri_list";',
	"	toolArgs = {};",
	'	cliArgs = ["list"];',
	'} else if (tools.startsWith("maestri_note_create")) {',
	'	toolName = "maestri_note_create";',
	'	toolArgs = { name: "Smoke note", content: "Transport checked", stack: "Smoke book" };',
	'	cliArgs = ["note", "create", "--name", "Smoke note", "--stack", "Smoke book", "Transport checked"];',
	'} else if (prompt && prompt.includes("screenshot")) {',
	'	toolName = "maestri_portal";',
	'	toolArgs = { action: "screenshot", portal: "Smoke web" };',
	'	cliArgs = ["portal", "screenshot", "Smoke web"];',
	"} else {",
	'	toolName = "maestri_portal_device";',
	'	toolArgs = { action: "list" };',
	'	cliArgs = ["portal", "devices"];',
	"}",
	"const cli = process.env.MAESTRI_CLI;",
	'if (!cli) throw new Error("missing MAESTRI_CLI");',
	'const invoked = spawnSync(cli, cliArgs, { encoding: "utf8", env: process.env });',
	"if (invoked.error) throw invoked.error;",
	"if (invoked.status !== 0) {",
	"	process.stderr.write(invoked.stderr);",
	"	process.exit(invoked.status ?? 1);",
	"}",
	'if (toolName === "maestri_portal" && !existsSync(invoked.stdout.trim())) {',
	'	throw new Error("fake CLI did not return its screenshot fixture");',
	"}",
	'process.stderr.write("controlled-pi call=" + call + " tool=" + toolName + "\\n");',
	"if (process.env.MPO_SMOKE_HARNESS_FAIL_CALL === String(call)) process.exit(37);",
	'const content = [{ type: "text", text: "UNTRUSTED PEER OUTPUT\\ncontrolled fixture" }];',
	'if (toolName === "maestri_portal") content.push({ type: "image", mimeType: "image/png", data: "fixture" });',
	'process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName, args: toolArgs }) + "\\n");',
	'process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolName, isError: false, result: { content } }) + "\\n");',
].join("\n");

interface SmokeResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

async function fixture(t: TestContext) {
	const root = await mkdtemp(path.join(tmpdir(), "mpo-smoke-harness-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const bin = path.join(root, "bin");
	await mkdir(bin);
	await writeFile(path.join(bin, "pi"), controlledPi, { mode: 0o700 });
	return { root, bin };
}

function runSmoke(artifactRoot: string, bin: string, failCall?: number) {
	return new Promise<SmokeResult>((resolve, reject) => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PATH: bin + path.delimiter + process.env.PATH,
			MPO_SMOKE_ARTIFACTS_DIR: artifactRoot,
			MPO_SMOKE_HARNESS_CALLS: path.join(artifactRoot, "calls"),
		};
		delete env.MPO_SMOKE_HARNESS_FAIL_CALL;
		if (failCall !== undefined) env.MPO_SMOKE_HARNESS_FAIL_CALL = String(failCall);
		const child = spawn("bash", [smokeScript, "--fake"], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
			killSignal: "SIGKILL",
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", reject);
		child.once("close", (code) => resolve({
			code,
			stdout: Buffer.concat(stdout).toString(),
			stderr: Buffer.concat(stderr).toString(),
		}));
	});
}

async function onlyRunDirectory(artifactRoot: string) {
	const entries = (await readdir(artifactRoot)).filter((entry) => entry !== "calls");
	assert.equal(entries.length, 1);
	return path.join(artifactRoot, entries[0]);
}

async function assertJsonLines(file: string) {
	const contents = await readFile(file, "utf8");
	const lines = contents.trim().split("\n");
	assert.equal(lines.length, 2);
	for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
	return contents;
}

test("fake smoke uses one argv artifact per Pi call and preserves event diagnostics", async (t) => {
	const { root, bin } = await fixture(t);
	const artifactRoot = path.join(root, "success");
	await mkdir(artifactRoot);
	const result = await runSmoke(artifactRoot, bin);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /^PASS:/);

	const run = await onlyRunDirectory(artifactRoot);
	const expectedArgv = new Map([
		["list.argv", "list\n"],
		["note.argv", "note\ncreate\n--name\nSmoke note\n--stack\nSmoke book\nTransport checked\n"],
		["portal.argv", "portal\nscreenshot\nSmoke web\n"],
		["device.argv", "portal\ndevices\n"],
	]);
	const argvFiles = (await readdir(run)).filter((entry) => entry.endsWith(".argv")).sort();
	assert.deepEqual(argvFiles, [...expectedArgv.keys()].sort());
	for (const [name, expected] of expectedArgv) {
		assert.equal(await readFile(path.join(run, name), "utf8"), expected);
	}

	for (const name of ["fake", "note", "portal", "device"]) {
		const events = await assertJsonLines(path.join(run, name + ".jsonl"));
		assert.match(events, /"type":"tool_execution_start"/);
		assert.match(events, /"type":"tool_execution_end"/);
		assert.match(await readFile(path.join(run, name + ".jsonl.stderr"), "utf8"), /controlled-pi call=/);
	}
	assert.match(await readFile(path.join(run, "result.txt"), "utf8"), /^status=pass$/m);
});

test("fake smoke returns the first Pi failure without replacing its durable record", async (t) => {
	const { root, bin } = await fixture(t);
	const artifactRoot = path.join(root, "failure");
	await mkdir(artifactRoot);
	const result = await runSmoke(artifactRoot, bin, 2);
	assert.equal(result.code, 37, "smoke masked the controlled Pi failure: " + result.stderr);

	const run = await onlyRunDirectory(artifactRoot);
	const failure = await readFile(path.join(run, "first-failure.txt"), "utf8");
	assert.match(failure, /^status=37$/m);
	assert.equal(failure.match(/^status=/gm)?.length, 1);
	assert.equal(await readFile(path.join(run, "list.argv"), "utf8"), "list\n");
	assert.equal(
		await readFile(path.join(run, "note.argv"), "utf8"),
		"note\ncreate\n--name\nSmoke note\n--stack\nSmoke book\nTransport checked\n",
	);
	assert.match(await readFile(path.join(run, "fake.jsonl.stderr"), "utf8"), /controlled-pi call=1/);
	assert.match(await readFile(path.join(run, "note.jsonl.stderr"), "utf8"), /controlled-pi call=2/);
	await assert.rejects(readFile(path.join(run, "result.txt"), "utf8"));
});
