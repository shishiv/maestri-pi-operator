import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import {
	clientDigest, createAcceptedRequest, createOutput, ensureAskStateRoot, promptDigest, readOutput, readRequest,
	type AskRequestRecord,
} from "../src/ask-store.ts";

const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));

test("installed tarball runs its external CLI and durable runner without a TypeScript loader", { timeout: 60_000 }, async (t) => {
	const home = await mkdtemp(path.join(tmpdir(), "mpo-installed-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		npm_config_cache: path.join(home, "empty-cache"),
		npm_config_userconfig: path.join(home, "npmrc"),
	};
	await writeFile(env.npm_config_userconfig, "");
	const archiveDir = path.join(home, "archives");
	const consumer = path.join(home, "consumer");
	await mkdir(archiveDir);
	await mkdir(consumer);
	await exec("npm", ["pack", "--json", "--offline", "--pack-destination", archiveDir], {
		cwd: repository, env, timeout: 30_000, maxBuffer: 1024 * 1024,
	});
	const sourceManifest = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"));
	const archive = path.join(archiveDir, `${sourceManifest.name}-${sourceManifest.version}.tgz`);
	const packed = (await exec("tar", ["-tzf", archive], { env, timeout: 5_000 })).stdout
		.trim().split("\n").map((entry) => entry.replace(/^package\//, ""));
	for (const required of [
		"package.json", "README.md", "bin/mpo-extension", "dist/index.js", "dist/index.d.ts", "dist/operator-command.js",
		"dist/ask-runner.mjs", "dist/extension-cli.mjs", "docs/architecture.md", "firstmate-extension.json",
	]) assert.ok(packed.includes(required), `missing packed file: ${required}`);
	assert.ok(packed.every((entry) => !entry.startsWith("resources/skills/")), "bundled skills leaked into the tarball");
	assert.ok(packed.every((entry) => !/^(?:src|skills|maestri\/roles|\.artifacts)\//.test(entry)), "retired or local sources leaked into the tarball");
	await exec("npm", ["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", archive], {
		cwd: consumer, env, timeout: 30_000, maxBuffer: 1024 * 1024,
	});
	// Provide declared peers from the locked development install, not npm's ambient cache.
	// Only these dependencies are linked; the package under test must remain a real tarball install.
	for (const peer of Object.keys(sourceManifest.peerDependencies)) {
		const peerRoot = path.join(repository, "node_modules", peer);
		const peerManifest = JSON.parse(await readFile(path.join(peerRoot, "package.json"), "utf8"));
		assert.equal(peerManifest.version, sourceManifest.devDependencies[peer], `unexpected fixture peer version: ${peer}`);
		const target = path.join(consumer, "node_modules", peer);
		await mkdir(path.dirname(target), { recursive: true });
		await symlink(peerRoot, target, "dir");
	}
	const installed = path.join(consumer, "node_modules", "maestri-pi-operator");
	const installedInfo = await lstat(installed);
	assert.ok(installedInfo.isDirectory() && !installedInfo.isSymbolicLink(), "the package must be an installed directory");
	assert.notEqual(await realpath(installed), await realpath(repository), "the package must not resolve to the checkout");
	const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
	const bin = path.join(installed, manifest.bin["mpo-extension"]);
	const runtime = path.dirname(path.join(installed, manifest.pi.extensions[0]));
	const manifestRequest = {
		schema: "firstmate.extension-handshake-request.v1",
		request_id: `sha256:${"1".repeat(64)}`,
		host_protocols: [1],
		extension_id: "org.maestri.pi-operator",
		extension_version: manifest.version,
		package_digest: `sha256:${"2".repeat(64)}`,
		capability: { name: "process-event-adapter", versions: [1], adapter_names: ["maestri-ask"] },
	};

	await t.test("the installed package hides its tools and bundled skills outside Maestri", async () => {
		const script = path.join(consumer, "surface-probe.mjs");
		await writeFile(script, `
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: process.env.HOME + "/.pi/agent",
  settingsManager: SettingsManager.inMemory({ packages: [process.env.MPO_INSTALLED_PACKAGE] }),
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
const { session } = await createAgentSession({ resourceLoader: loader, sessionManager: SessionManager.inMemory() });
await session.bindExtensions({});
const result = {
  tools: session.getAllTools().map((tool) => tool.name).filter((name) => name.startsWith("maestri")).sort(),
  commands: session._extensionRunner.getRegisteredCommands().map((command) => command.name).filter((name) => name.startsWith("maestri")).sort(),
};
await new Promise((resolve) => process.stdout.write(JSON.stringify(result), resolve));
process.exit(0);
`);
		const probeEnv = { ...env, MPO_INSTALLED_PACKAGE: installed };
		const outside = JSON.parse((await exec(process.execPath, [script], { cwd: consumer, env: probeEnv, timeout: 5_000 })).stdout);
		assert.deepEqual(outside, { tools: [], commands: [] });
		const insideEnv = {
			...probeEnv,
			MAESTRI_WORKSPACE_ID: "fixture-workspace",
			MAESTRI_TERMINAL_ID: "fixture-terminal",
			MAESTRI_SOCKET: "/tmp/fixture.sock",
		};
		const inside = JSON.parse((await exec(process.execPath, [script], { cwd: consumer, env: insideEnv, timeout: 5_000 })).stdout);
		assert.equal(inside.tools.length, 14);
		assert.deepEqual(inside.commands, ["maestri-operator"]);
	});

	await t.test("the installed executable handles a protocol handshake", async () => {
		const child = spawn(bin, ["handshake"], { cwd: consumer, env, timeout: 5_000, killSignal: "SIGKILL", stdio: ["pipe", "pipe", "pipe"] });
		const output: Buffer[] = [];
		const errors: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
		const closed = new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify(manifestRequest));
		assert.equal(await closed, 0, Buffer.concat(errors).toString());
		const answer = JSON.parse(Buffer.concat(output).toString());
		assert.equal(answer.schema, "firstmate.extension-handshake-response.v1");
		assert.equal(answer.request_id, manifestRequest.request_id);
		assert.equal(answer.extension_version, manifest.version);
	});

	await t.test("the installed runner sends once, persists a reply, and feeds the installed waiter", async () => {
		const runtimeEnv = { ...env, XDG_STATE_HOME: path.join(home, "state"), MAESTRI_WORKSPACE_ID: "fixture-workspace", MAESTRI_TERMINAL_ID: "fixture-caller" };
		const root = await ensureAskStateRoot(runtimeEnv);
		const token = randomUUID();
		const requestId = randomUUID();
		const record: AskRequestRecord = {
			schema: 1, scope_key: path.basename(root), runner_token_digest: promptDigest(token), request_id: requestId,
			client_request_id: "installed-package", agent: "Fixture peer", prompt_digest: promptDigest("reply"), prompt_bytes: 5,
			created_at: new Date().toISOString(), phase: "accepted", delivery: "not-attempted", reply: "none", custody: "none",
			cleanup_deadline_ms: null, notification: { state: "none", digest: null, sent_at: null, attempts: 0, claim: null },
			output: { raw_bytes: 0, truncated: false }, state_version: 1,
		};
		await createAcceptedRequest(root, record, clientDigest(record.client_request_id));
		await createOutput(root, requestId);
		const sent = path.join(home, "sent.txt");
		const cli = path.join(home, "controlled-cli.mjs");
		await writeFile(cli, [
			"#!/usr/bin/env node",
			'import { appendFileSync } from "node:fs";',
			`appendFileSync(${JSON.stringify(sent)}, "sent\\n");`,
			`process.stdout.write(${JSON.stringify(`<<<MAESTRI_REPLY_BEGIN:${requestId}>>>\nACK-INSTALLED\n<<<MAESTRI_REPLY_END:${requestId}>>>\n`)});`,
		].join("\n"), { mode: 0o700 });
		const child = spawn(process.execPath, [path.join(runtime, "ask-runner.mjs"), root, requestId, token], {
			cwd: consumer, env: runtimeEnv, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"],
		});
		const errors: Buffer[] = [];
		child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
		child.stdout?.resume();
		const closed = new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		const deadline = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } }, 10_000);
		const input = child.stdio[3];
		assert.ok(input && "end" in input, "runner requires the inherited payload pipe");
		input.on("error", () => {});
		input.end(JSON.stringify({ token, command: cli, cwd: consumer, agent: record.agent, prompt: "reply", askTimeoutMs: 2_000, killGraceMs: 100 }));
		try { assert.equal(await closed, 0, Buffer.concat(errors).toString()); } finally { clearTimeout(deadline); }
		const terminal = await readRequest(root, requestId);
		assert.deepEqual([terminal.phase, terminal.delivery, terminal.reply, terminal.custody], ["terminal", "confirmed", "received", "released"]);
		assert.equal(await readFile(sent, "utf8"), "sent\n");
		assert.match((await readOutput(root, requestId)).toString(), /ACK-INSTALLED/);
		const waited = await exec(process.execPath, [bin, "wait", "--request", requestId, "--timeout", "1"], { cwd: consumer, env: runtimeEnv, timeout: 5_000 });
		const envelope = JSON.parse(waited.stdout);
		assert.equal(envelope.request_id, requestId);
		assert.equal(envelope.reply, "received");
		assert.equal("content" in envelope, false, "the waiter must not consume or leak the reply body");
		assert.deepEqual(await readRequest(root, requestId), terminal, "waiting must not acknowledge the result");
	});

	await t.test("the installed public entrypoint launches its own runner", async () => {
		const stateHome = path.join(home, "public-state");
		const sent = path.join(home, "public-sent.txt");
		const cli = path.join(home, "public-cli.mjs");
		await writeFile(cli, [
			"#!/usr/bin/env node",
			'import { appendFileSync } from "node:fs";',
			"const [action, , prompt] = process.argv.slice(2);",
			'if (action === "check") process.stdout.write("GPT-6 Astra • low\\n");',
			"else if (action === \"ask\") {",
			`  appendFileSync(${JSON.stringify(sent)}, "sent\\n");`,
			'  const id = prompt.match(/Request ID: ([0-9a-f-]{36})/)?.[1];',
			'  process.stdout.write(`<<<MAESTRI_REPLY_BEGIN:${id}>>>\\nACK-PUBLIC\\n<<<MAESTRI_REPLY_END:${id}>>>\\n`);',
			"} else process.exitCode = 2;",
		].join("\n"), { mode: 0o700 });
		const script = path.join(consumer, "public-entry.mjs");
		await writeFile(script, `
import extension, { classifyPiReadiness } from "maestri-pi-operator";
import { classifyPiReadiness as classifyViaSubpath } from "maestri-pi-operator/readiness";
const manifestExtension = await import(process.env.MPO_INSTALLED_EXTENSION_URL);
if (manifestExtension.default !== extension) throw new Error("manifest and public exports resolve different extensions");
const tools = new Map();
extension({ registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, on() {}, sendMessage() {} });
if (classifyPiReadiness !== classifyViaSubpath) throw new Error("readiness exports disagree");
const call = (name, params) => tools.get(name).execute("installed", params, undefined, undefined, { cwd: process.cwd() });
const started = await call("maestri_ask_async", { agent: "Fixture peer", prompt: "reply", client_request_id: "public-entry" });
const id = JSON.parse(started.content[0].text).request_id;
let result;
for (let index = 0; index < 100; index += 1) {
  result = await call("maestri_ask_request", { action: "result", request_id: id });
  if (result.details.phase === "terminal") break;
  await new Promise(resolve => setTimeout(resolve, 20));
}
if (result?.details.phase !== "terminal") {
  await call("maestri_ask_request", { action: "cancel", request_id: id });
  throw new Error("public async request did not reach a terminal state");
}
if (result?.details.delivery !== "confirmed" || result?.details.reply !== "received") throw new Error(JSON.stringify(result));
if (!result.content[0].text.includes("ACK-PUBLIC")) throw new Error("public result omitted reply");
process.stdout.write(JSON.stringify({ id, tools: [...tools.keys()], state: result.details }));
`);
		const publicEnv = {
			...env, XDG_STATE_HOME: stateHome, MAESTRI_WORKSPACE_ID: "fixture-workspace",
			MAESTRI_TERMINAL_ID: "fixture-public", MAESTRI_SOCKET: "/tmp/fixture.sock", MAESTRI_CLI: cli,
			MPO_INSTALLED_EXTENSION_URL: pathToFileURL(path.join(installed, manifest.pi.extensions[0])).href,
		};
		const result = await exec(process.execPath, [script], { cwd: consumer, env: publicEnv, timeout: 10_000, maxBuffer: 1024 * 1024 });
		const output = JSON.parse(result.stdout);
		assert.deepEqual(output.tools.sort(), [
			"maestri_ask", "maestri_ask_async", "maestri_ask_request", "maestri_check", "maestri_list",
			"maestri_note_create", "maestri_note_edit", "maestri_note_read", "maestri_note_stack",
			"maestri_portal", "maestri_portal_device", "maestri_role_create", "maestri_role_list", "maestri_role_show",
		].sort());
		assert.equal(output.state.outputKind, "extracted-reply");
		assert.equal(await readFile(sent, "utf8"), "sent\n");
	});
});
