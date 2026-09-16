import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import maestriPiOperator from "../src/index.ts";

type Environment = Readonly<Record<string, string | undefined>>;
interface TestEvent { readonly kind?: "test" }
interface TestEventContext { readonly idle?: boolean }
type RegisteredHandler = (event: TestEvent, context: TestEventContext) => void | Promise<void>;
interface TestMessage {
	content: string;
	customType: string;
	details: { digest: string };
}
interface DeliveryOptions {
	deliverAs: "followUp" | "nextTurn";
	triggerTurn?: true;
}
interface TestCommandContext {
	sessionManager: { getEntries(): Array<TestMessage & { type: "custom_message" }> };
	ui: { notify(message: string): void };
}
interface TestCommand {
	handler(args: string, ctx: TestCommandContext): Promise<void>;
}
const contextKeys = ["MAESTRI_WORKSPACE_ID", "MAESTRI_SOCKET", "MAESTRI_TERMINAL_ID"] as const;

function sessionEntry(message: TestMessage): TestMessage & { type: "custom_message" } {
	return { type: "custom_message", ...message };
}

function loadExtension(env: Environment) {
	const tools: string[] = [];
	const commands = new Map<string, TestCommand>();
	const messages: Array<{ message: TestMessage; options: DeliveryOptions }> = [];
	const handlers = new Map<string, RegisteredHandler[]>();
	const pi = {
		registerTool(tool: { name: string }) { tools.push(tool.name); },
		registerCommand(name: string, command: TestCommand) { commands.set(name, command); },
		on(name: string, handler: RegisteredHandler) {
			const entries = handlers.get(name) ?? [];
			entries.push(handler);
			handlers.set(name, entries);
		},
		sendMessage(message: TestMessage, options: DeliveryOptions) { messages.push({ message, options }); },
	};
	// SAFETY: this harness implements every ExtensionAPI member exercised while the extension registers.
	const extensionApi = pi as ExtensionAPI;
	const previous = Object.fromEntries(contextKeys.map((key) => [key, process.env[key]]));
	try {
		for (const key of contextKeys) {
			const value = env[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		maestriPiOperator(extensionApi);
	} finally {
		for (const key of contextKeys) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	return { commands, handlers, messages, tools };
}

test("exposes no Maestri tools, hooks, or command without a complete Maestri context", () => {
	for (const env of [
		{},
		{ MAESTRI_WORKSPACE_ID: "workspace" },
		{ MAESTRI_SOCKET: "/tmp/maestri.sock" },
	]) {
		const loaded = loadExtension(env);
		assert.deepEqual(loaded.tools, []);
		assert.deepEqual([...loaded.handlers], []);
		assert.deepEqual([...loaded.commands], []);
	}
});

test("exposes 14 transport tools, one command, and four hooks inside Maestri", () => {
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
	assert.equal([...loaded.handlers.values()].flat().length, 4);
	assert.equal(loaded.handlers.has("resources_discover"), false);
	assert.deepEqual([...loaded.commands.keys()], ["maestri-operator"]);
});

test("maestri operator queues no-argument guidance and deduplicates it after reload", async () => {
	const env = { MAESTRI_WORKSPACE_ID: "workspace", MAESTRI_SOCKET: "/tmp/maestri.sock", MAESTRI_TERMINAL_ID: "terminal" };
	const loaded = loadExtension(env);
	const notices: string[] = [];
	const ctx = {
		sessionManager: { getEntries: () => loaded.messages.map(({ message }) => sessionEntry(message)) },
		ui: { notify: (message: string) => { notices.push(message); } },
	};
	const command = loaded.commands.get("maestri-operator");
	assert.ok(command);
	await command.handler("", ctx);
	assert.deepEqual(loaded.messages[0].options, { deliverAs: "nextTurn" });
	assert.equal(loaded.messages[0].message.customType, "mpo.maestri-operator");
	await command.handler("", ctx);
	assert.equal(loaded.messages.length, 1);
	assert.match(notices[0], /already active/);
	await command.handler("Inspect the connected reviewer", ctx);
	assert.deepEqual(loaded.messages[1].options, { deliverAs: "followUp", triggerTurn: true });
	assert.match(loaded.messages[1].message.content, /Task: Inspect the connected reviewer/);
});
