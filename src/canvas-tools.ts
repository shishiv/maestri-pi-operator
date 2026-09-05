import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { invokeMaestri, type MaestriRuntimeOptions } from "./maestri.ts";

const nameSchema = Type.String({ minLength: 1 });
const MAX_TEXT_BYTES = 65_536;

function assertName(name: string): void {
	if (!name || name.trim() !== name || name.startsWith("-") || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
		throw new Error("name must be non-empty, trimmed, single-line, contain no control characters, and not start with '-'");
	}
}

function encodeCliText(text: string): string {
	const encoded = text.replaceAll("\\", "\\\\");
	if (text.includes("\0") || Buffer.byteLength(encoded, "utf8") > MAX_TEXT_BYTES) {
		throw new Error("text must contain at most 65536 encoded UTF-8 bytes and no NUL");
	}
	return encoded;
}

export function registerCanvasTools(
	pi: Pick<ExtensionAPI, "registerTool">,
	options: MaestriRuntimeOptions = {},
): void {
	pi.registerTool({
		name: "maestri_role_list",
		label: "Maestri roles",
		description: "List workspace and global role presets. Requires Maestro Mode",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, signal, _onUpdate, ctx) {
			return invokeMaestri("role_list", ["role", "list"], { ...options, signal, cwd: ctx.cwd });
		},
	});

	pi.registerTool({
		name: "maestri_role_show",
		label: "Maestri role",
		description: "Read a role's full prompt rather than its list preview. Requires Maestro Mode",
		parameters: Type.Object({ name: nameSchema }, { additionalProperties: false }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			assertName(params.name);
			return invokeMaestri("role_show", ["role", "show", params.name], { ...options, signal, cwd: ctx.cwd });
		},
	});

	pi.registerTool({
		name: "maestri_role_create",
		label: "Create Maestri role",
		description: "Create a role in the current workspace. Requires Maestro Mode",
		parameters: Type.Object({
			name: nameSchema,
			prompt: Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }),
		}, { additionalProperties: false }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			assertName(params.name);
			if (params.prompt.length === 0) throw new Error("prompt must not be empty");
			return invokeMaestri("role_create", ["role", "create", params.name, encodeCliText(params.prompt), "--scope", "current"],
				{ ...options, signal, cwd: ctx.cwd });
		},
	});

	pi.registerTool({
		name: "maestri_note_read",
		label: "Read Maestri note",
		description: "Read a connected note with line numbers",
		parameters: Type.Object({
			name: nameSchema,
			offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line, 1-based" })),
			limit: Type.Optional(Type.Integer({ minimum: 1 })),
		}, { additionalProperties: false }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			assertName(params.name);
			const argv = ["note", "read", params.name];
			if (params.offset !== undefined || params.limit !== undefined) argv.push(String(params.offset ?? 1));
			if (params.limit !== undefined) argv.push(String(params.limit));
			return invokeMaestri("note_read", argv, { ...options, signal, cwd: ctx.cwd });
		},
	});

	pi.registerTool({
		name: "maestri_note_create",
		label: "Create Maestri note",
		description: "Create a named note connected to this terminal, optionally in a fichário. Returns its assigned name",
		parameters: Type.Object({
			name: nameSchema,
			content: Type.Optional(Type.String({ maxLength: MAX_TEXT_BYTES })),
			stack: Type.Optional(nameSchema),
		}, { additionalProperties: false }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			assertName(params.name);
			const content = encodeCliText(params.content ?? "");
			if (content === "--name" || content === "--stack") {
				throw new Error("content matches a Maestri CLI option; create a note with placeholder text, then replace it with maestri_note_edit");
			}
			const argv = ["note", "create", "--name", params.name];
			if (params.stack !== undefined) {
				assertName(params.stack);
				argv.push("--stack", params.stack);
			}
			argv.push(content);
			return invokeMaestri("note_create", argv, { ...options, signal, cwd: ctx.cwd });
		},
	});

	pi.registerTool({
		name: "maestri_note_edit",
		label: "Edit Maestri note",
		description: "Replace a substring in a connected note. Read it first and use any new name returned",
		parameters: Type.Object({
			name: nameSchema,
			oldText: Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }),
			newText: Type.String({ maxLength: MAX_TEXT_BYTES }),
		}, { additionalProperties: false }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			assertName(params.name);
			if (params.oldText.length === 0) throw new Error("oldText must not be empty");
			const argv = ["note", "edit", params.name, encodeCliText(params.oldText), encodeCliText(params.newText)];
			return invokeMaestri("note_edit", argv, { ...options, signal, cwd: ctx.cwd });
		},
	});

	pi.registerTool({
		name: "maestri_note_stack",
		label: "File Maestri note",
		description: "Move a connected note into a fichário",
		parameters: Type.Object({
			name: nameSchema,
			stack: Type.Optional(Type.String({ minLength: 1, description: "Fichário; inferred only when exactly one is reachable" })),
		}, { additionalProperties: false }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			assertName(params.name);
			const argv = ["note", "stack", params.name];
			if (params.stack !== undefined) {
				assertName(params.stack);
				argv.push(params.stack);
			}
			return invokeMaestri("note_stack", argv, { ...options, signal, cwd: ctx.cwd });
		},
	});
}
