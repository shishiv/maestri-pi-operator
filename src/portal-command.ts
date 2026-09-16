export type PortalResponse = "ok" | "data" | "structured" | "screenshot";

export interface PortalCommand {
	args: string[];
	response: PortalResponse;
	mutates: boolean;
}

export interface PortalInput {
	action: string;
	portal?: string;
	name?: string;
	device?: string;
	url?: string;
	selector?: string;
	to?: string;
	text?: string;
	key?: string;
	value?: string;
	direction?: string;
	amount?: number;
	width?: number;
	height?: number;
	timeout_ms?: number;
	expression?: string;
	preset?: string;
	package?: string;
}

type PortalField = keyof PortalInput;
type MutationPolicy = (input: PortalInput) => boolean;

interface PortalActionSpec {
	action: string;
	fields: readonly PortalField[];
	target: boolean;
	response: PortalResponse;
	mutates: MutationPolicy;
	build: (input: PortalInput) => string[];
}

const MAX_TEXT_BYTES = 65_536;
const alwaysMutates: MutationPolicy = () => true;
const neverMutates: MutationPolicy = () => false;

function hasForbiddenControlCharacters(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.codePointAt(0);
		return code !== undefined && ((code >= 0 && code <= 31) || (code >= 127 && code <= 159));
	});
}

function textValue(value: string | undefined, field: string, empty = false, escapes = false): string {
	if (value === undefined || (!empty && value.length === 0) || value.includes("\0")) {
		throw new Error(`${field} is required and must contain no NUL`);
	}
	const encoded = escapes ? value.replaceAll("\\", "\\\\") : value;
	if (Buffer.byteLength(encoded, "utf8") > MAX_TEXT_BYTES) throw new Error(`${field} exceeds 65536 encoded UTF-8 bytes`);
	return encoded;
}

function nameValue(value: string | undefined, field: string): string {
	const result = textValue(value, field);
	if (result.trim() !== result || result.startsWith("-") || hasForbiddenControlCharacters(result)) {
		throw new Error(`${field} must be trimmed, single-line and not start with '-'`);
	}
	return result;
}

function numberValue(value: number | undefined, field: string, min: number, max: number): string {
	if (value === undefined || !Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${field} must be an integer from ${min} to ${max}`);
	}
	return String(value);
}

function selectorValue(value: string | undefined, device: boolean): string {
	const result = textValue(value, "selector");
	if (device && !/^(@e[1-9]\d*|\d+(\.\d+)?,\d+(\.\d+)?)$/.test(result)) {
		throw new Error("Android selectors must be a fresh @e ref or x,y coordinates, not CSS");
	}
	return result;
}

function urlValue(value: string | undefined): string {
	const result = nameValue(value, "url");
	try {
		new URL(result);
	} catch {
		throw new Error("url must be an absolute URL, including its scheme");
	}
	return result;
}

function directionValue(value: string | undefined): string {
	if (value !== "up" && value !== "down" && value !== "left" && value !== "right") {
		throw new Error("scroll requires direction: up, down, left or right");
	}
	return value;
}

const webSpecs = [
	{
		action: "create", fields: ["name", "url", "width", "height"], target: false, response: "structured", mutates: alwaysMutates,
		build: (input) => {
			const args = [urlValue(input.url)];
			if (input.name !== undefined) args.push(nameValue(input.name, "name"));
			if (input.width !== undefined || input.height !== undefined) {
				args.push("--size", `${numberValue(input.width, "width", 80, 10_000)}x${numberValue(input.height, "height", 80, 10_000)}`);
			}
			return args;
		},
	},
	{ action: "edit", fields: ["url"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => ["--url", urlValue(input.url)] },
	{ action: "navigate", fields: ["url"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [urlValue(input.url)] },
	{ action: "info", fields: [], target: true, response: "structured", mutates: neverMutates, build: () => [] },
	{ action: "snapshot", fields: [], target: true, response: "structured", mutates: neverMutates, build: () => [] },
	{ action: "screenshot", fields: [], target: true, response: "screenshot", mutates: neverMutates, build: () => [] },
	{ action: "close", fields: [], target: true, response: "structured", mutates: alwaysMutates, build: () => [] },
	{ action: "html", fields: [], target: true, response: "data", mutates: neverMutates, build: () => [] },
	{ action: "logs", fields: [], target: true, response: "data", mutates: alwaysMutates, build: () => [] },
	{ action: "logs-start", fields: [], target: true, response: "ok", mutates: alwaysMutates, build: () => [] },
	{ action: "click", fields: ["selector"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [selectorValue(input.selector, false)] },
	{ action: "fill", fields: ["selector", "text"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [selectorValue(input.selector, false), textValue(input.text, "text", true, true)] },
	{ action: "type", fields: ["selector", "text"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => input.selector === undefined
		? [textValue(input.text, "text", true, true)]
		: [selectorValue(input.selector, false), textValue(input.text, "text", true, true)] },
	{ action: "key", fields: ["key"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [nameValue(input.key, "key")] },
	{ action: "focus", fields: ["selector"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [selectorValue(input.selector, false)] },
	{ action: "select", fields: ["selector", "value"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [selectorValue(input.selector, false), textValue(input.value, "value", true)] },
	{ action: "uncheck", fields: ["selector"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [selectorValue(input.selector, false)] },
	{ action: "selectall", fields: ["selector"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => input.selector === undefined ? [] : [selectorValue(input.selector, false)] },
	{ action: "clear", fields: ["selector"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => input.selector === undefined ? [] : [selectorValue(input.selector, false)] },
	{ action: "scroll", fields: ["direction", "amount", "selector"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => {
		const args = [directionValue(input.direction), numberValue(input.amount ?? 300, "amount", 1, 100_000)];
		if (input.selector !== undefined) args.push(selectorValue(input.selector, false));
		return args;
	} },
	{ action: "scrollintoview", fields: ["selector"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [selectorValue(input.selector, false)] },
	{ action: "hover", fields: ["selector"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [selectorValue(input.selector, false)] },
	{ action: "drag", fields: ["selector", "to"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [selectorValue(input.selector, false), selectorValue(input.to, false)] },
	{ action: "text", fields: ["selector"], target: true, response: "data", mutates: neverMutates, build: (input) => [selectorValue(input.selector, false)] },
	{ action: "wait", fields: ["selector", "timeout_ms"], target: true, response: "ok", mutates: neverMutates, build: (input) => [selectorValue(input.selector, false), numberValue(input.timeout_ms ?? 5_000, "timeout_ms", 1, 10_000)] },
	{ action: "evaluate", fields: ["expression"], target: true, response: "data", mutates: alwaysMutates, build: (input) => [textValue(input.expression, "expression")] },
	{ action: "resize", fields: ["width", "height"], target: true, response: "structured", mutates: alwaysMutates, build: (input) => [numberValue(input.width, "width", 80, 10_000), numberValue(input.height, "height", 80, 10_000)] },
	{ action: "ua", fields: ["preset"], target: true, response: "structured", mutates: (input) => input.preset !== undefined, build: (input) => input.preset === undefined ? [] : [presetValue(input.preset)] },
] satisfies readonly PortalActionSpec[];

function presetValue(value: string): string {
	if (value !== "ios" && value !== "android" && value !== "firefox-android" && value !== "edge-android" &&
		value !== "chrome" && value !== "firefox" && value !== "edge" && value !== "desktop") {
		throw new Error("Unknown user-agent preset");
	}
	return value;
}

const deviceSpecs = [
	{ action: "devices", fields: [], target: false, response: "structured", mutates: neverMutates, build: () => [] },
	{
		action: "create", fields: ["device", "name"], target: false, response: "structured", mutates: alwaysMutates,
		build: (input) => {
			const args = ["--simulator", nameValue(input.device, "device")];
			if (input.name !== undefined) args.push(nameValue(input.name, "name"));
			return args;
		},
	},
	{ action: "info", fields: [], target: true, response: "structured", mutates: neverMutates, build: () => [] },
	{ action: "snapshot", fields: [], target: true, response: "structured", mutates: neverMutates, build: () => [] },
	{ action: "screenshot", fields: [], target: true, response: "screenshot", mutates: neverMutates, build: () => [] },
	{ action: "close", fields: [], target: true, response: "structured", mutates: alwaysMutates, build: () => [] },
	{ action: "tap", fields: ["selector"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [selectorValue(input.selector, true)] },
	{ action: "type", fields: ["text"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [textValue(input.text, "text", true, true)] },
	{ action: "key", fields: ["key"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [nameValue(input.key, "key")] },
	{ action: "scroll", fields: ["direction", "amount"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [directionValue(input.direction), numberValue(input.amount ?? 300, "amount", 1, 100_000)] },
	{ action: "swipe", fields: ["selector", "to"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [selectorValue(input.selector, true), selectorValue(input.to, true)] },
	{ action: "button", fields: ["key"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [nameValue(input.key, "key")] },
	{ action: "launch", fields: ["package"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [nameValue(input.package, "package")] },
	{ action: "terminate", fields: ["package"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [nameValue(input.package, "package")] },
	{ action: "navigate", fields: ["url"], target: true, response: "ok", mutates: alwaysMutates, build: (input) => [urlValue(input.url)] },
] satisfies readonly PortalActionSpec[];

export const WEB_ACTIONS = webSpecs.map((spec) => spec.action);
export const DEVICE_ACTIONS = deviceSpecs.map((spec) => spec.action);

function findActionSpec(kind: "portal" | "portal_device", action: string): PortalActionSpec {
	const specs = kind === "portal_device" ? deviceSpecs : webSpecs;
	const spec = specs.find((candidate) => candidate.action === action);
	if (spec === undefined) throw new Error(`Unsupported ${kind} action: ${action}`);
	return spec;
}

export function portalCommand(kind: "portal" | "portal_device", input: PortalInput): PortalCommand {
	const spec = findActionSpec(kind, input.action);
	const allowed = ["action", ...spec.fields, ...(spec.target ? ["portal"] : [])];
	for (const field of Object.keys(input)) {
		if (!allowed.includes(field)) throw new Error(`${field} does not apply to ${input.action}`);
	}
	const args = [spec.action];
	if (spec.target) args.push(nameValue(input.portal, "portal"));
	args.push(...spec.build(input));
	return { args, response: spec.response, mutates: spec.mutates(input) };
}
