import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import maestriPiOperator from "../src/index.ts";

type Environment = Readonly<Record<string, string | undefined>>;
type RegisteredHandler = (event: unknown, context: unknown) => unknown;
const contextKeys = ["MAESTRI_WORKSPACE_ID", "MAESTRI_SOCKET", "MAESTRI_TERMINAL_ID"] as const;

function loadExtension(env: Environment) {
	const tools: string[] = [];
	const handlers = new Map<string, RegisteredHandler[]>();
	const pi = {
		registerTool(tool: { name: string }) { tools.push(tool.name); },
		on(name: string, handler: RegisteredHandler) {
			const entries = handlers.get(name) ?? [];
			entries.push(handler);
			handlers.set(name, entries);
		},
		sendMessage() {},
	} as unknown as ExtensionAPI;
	const previous = Object.fromEntries(contextKeys.map((key) => [key, process.env[key]]));
	try {
		for (const key of contextKeys) {
			const value = env[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		maestriPiOperator(pi);
	} finally {
		for (const key of contextKeys) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	return { handlers, tools };
}

async function withEnvironment<T>(env: Environment, action: () => Promise<T> | T): Promise<T> {
	const previous = Object.fromEntries(contextKeys.map((key) => [key, process.env[key]]));
	try {
		for (const key of contextKeys) {
			const value = env[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		return await action();
	} finally {
		for (const key of contextKeys) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("exposes no Maestri tools, hooks, or skills without a complete Maestri context", () => {
	for (const env of [
		{},
		{ MAESTRI_WORKSPACE_ID: "workspace" },
		{ MAESTRI_SOCKET: "/tmp/maestri.sock" },
	]) {
		const loaded = loadExtension(env);
		assert.deepEqual(loaded.tools, []);
		assert.deepEqual([...loaded.handlers], []);
	}
});

test("exposes all transport tools and bundled skills inside Maestri", async () => {
	const env = {
		MAESTRI_WORKSPACE_ID: "workspace",
		MAESTRI_SOCKET: "/tmp/maestri.sock",
		MAESTRI_TERMINAL_ID: "terminal",
	};
	const loaded = loadExtension(env);
	assert.deepEqual(loaded.tools.sort(), [
		"maestri_ask", "maestri_ask_async", "maestri_ask_request", "maestri_check", "maestri_list",
		"maestri_note_create", "maestri_note_edit", "maestri_note_read", "maestri_note_stack",
		"maestri_portal", "maestri_portal_device", "maestri_role_create", "maestri_role_list", "maestri_role_show",
	].sort());
	const resourceHandlers = loaded.handlers.get("resources_discover") ?? [];
	assert.equal(resourceHandlers.length, 1);
	const resources = await withEnvironment(env, () => resourceHandlers[0]({ type: "resources_discover", cwd: "/tmp", reason: "startup" }, {}));
	assert.ok(resources && typeof resources === "object" && "skillPaths" in resources);
	const skillPaths = (resources as { skillPaths: string[] }).skillPaths;
	assert.equal(skillPaths.length, 1);
	const discovered = loadSkillsFromDir({ dir: skillPaths[0], source: "path" });
	assert.deepEqual(discovered.diagnostics, []);
	assert.deepEqual(discovered.skills.map(({ name }) => name).sort(), [
		"maestri", "maestri-manager", "maestri-portal", "maestri-portal-devices", "maestri-routines", "maestri-workspace",
	].sort());
});
