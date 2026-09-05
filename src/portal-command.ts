import type { PortalCommand } from "./portal-output.ts";

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

const WEB_FIELDS: Record<string, readonly (keyof PortalInput)[]> = {
	create: ["name", "url", "width", "height"], edit: ["url"], navigate: ["url"],
	info: [], snapshot: [], screenshot: [], close: [], html: [], logs: [], "logs-start": [],
	click: ["selector"], fill: ["selector", "text"], type: ["selector", "text"], key: ["key"],
	focus: ["selector"], select: ["selector", "value"], uncheck: ["selector"],
	selectall: ["selector"], clear: ["selector"], scroll: ["direction", "amount", "selector"],
	scrollintoview: ["selector"], hover: ["selector"], drag: ["selector", "to"],
	text: ["selector"], wait: ["selector", "timeout_ms"], evaluate: ["expression"],
	resize: ["width", "height"], ua: ["preset"],
};
const DEVICE_FIELDS: Record<string, readonly (keyof PortalInput)[]> = {
	devices: [], create: ["device", "name"], info: [], snapshot: [], screenshot: [], close: [],
	tap: ["selector"], type: ["text"], key: ["key"], scroll: ["direction", "amount"],
	swipe: ["selector", "to"], button: ["key"], launch: ["package"], terminate: ["package"], navigate: ["url"],
};

export const WEB_ACTIONS = Object.keys(WEB_FIELDS);
export const DEVICE_ACTIONS = Object.keys(DEVICE_FIELDS);

function text(value: string | undefined, field: string, empty = false, escapes = false): string {
	if (value === undefined || (!empty && value.length === 0) || value.includes("\0")) {
		throw new Error(`${field} is required and must contain no NUL`);
	}
	const encoded = escapes ? value.replaceAll("\\", "\\\\") : value;
	if (Buffer.byteLength(encoded, "utf8") > 65_536) throw new Error(`${field} exceeds 65536 encoded UTF-8 bytes`);
	return encoded;
}

function name(value: string | undefined, field: string): string {
	const result = text(value, field);
	if (result.trim() !== result || result.startsWith("-") || /[\u0000-\u001f\u007f-\u009f]/.test(result)) {
		throw new Error(`${field} must be trimmed, single-line and not start with '-'`);
	}
	return result;
}

function number(value: number | undefined, field: string, min: number, max: number): string {
	if (value === undefined || !Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${field} must be an integer from ${min} to ${max}`);
	}
	return String(value);
}

function selector(value: string | undefined, device: boolean): string {
	const result = text(value, "selector");
	if (device && !/^(@e[1-9]\d*|\d+(\.\d+)?,\d+(\.\d+)?)$/.test(result)) {
		throw new Error("Android selectors must be a fresh @e ref or x,y coordinates, not CSS");
	}
	return result;
}

function url(value: string | undefined): string {
	const result = name(value, "url");
	try { new URL(result); } catch { throw new Error("url must be an absolute URL, including its scheme"); }
	return result;
}

export function portalCommand(kind: "portal" | "portal_device", input: PortalInput): PortalCommand {
	const device = kind === "portal_device";
	const fields = device ? DEVICE_FIELDS : WEB_FIELDS;
	if (!Object.hasOwn(fields, input.action)) throw new Error(`Unsupported ${kind} action: ${input.action}`);
	const target = input.action !== "create" && input.action !== "devices";
	const allowed: readonly string[] = ["action", ...fields[input.action], ...(target ? ["portal"] : [])];
	for (const field of Object.keys(input)) {
		if (!allowed.includes(field)) throw new Error(`${field} does not apply to ${input.action}`);
	}
	const args = [input.action];
	if (target) args.push(name(input.portal, "portal"));
	let response: PortalCommand["response"] = "ok";
	let mutates = true;
	switch (input.action) {
		case "devices": case "info": case "snapshot":
			response = "structured"; mutates = false; break;
		case "html": case "text":
			response = "data"; mutates = false;
			if (input.action === "text") args.push(selector(input.selector, device));
			break;
		case "logs": response = "data"; break; // Native reads consume the log buffer.
		case "screenshot": response = "screenshot"; mutates = false; break;
		case "create":
			if (device) args.push("--simulator", name(input.device, "device"));
			else args.push(url(input.url));
			if (input.name !== undefined) args.push(name(input.name, "name"));
			if (input.width !== undefined || input.height !== undefined) {
				args.push("--size", `${number(input.width, "width", 80, 10_000)}x${number(input.height, "height", 80, 10_000)}`);
			}
			response = "structured";
			break;
		case "close": response = "structured"; break;
		case "edit": args.push("--url", url(input.url)); break;
		case "navigate": args.push(url(input.url)); break;
		case "click": case "tap": case "focus": case "uncheck": case "hover": case "scrollintoview":
			args.push(selector(input.selector, device)); break;
		case "fill": args.push(selector(input.selector, device), text(input.text, "text", true, true)); break;
		case "type":
			if (input.selector !== undefined) args.push(selector(input.selector, device));
			args.push(text(input.text, "text", true, true)); break;
		case "key": case "button": args.push(name(input.key, "key")); break;
		case "select": args.push(selector(input.selector, device), text(input.value, "value", true)); break;
		case "selectall": case "clear":
			if (input.selector !== undefined) args.push(selector(input.selector, device));
			break;
		case "scroll":
			if (!["up", "down", "left", "right"].includes(input.direction ?? "")) throw new Error("scroll requires direction: up, down, left or right");
			args.push(text(input.direction, "direction"), number(input.amount ?? 300, "amount", 1, 100_000));
			if (input.selector !== undefined) args.push(selector(input.selector, device));
			break;
		case "drag": case "swipe": args.push(selector(input.selector, device), selector(input.to, device)); break;
		case "wait": args.push(selector(input.selector, device), number(input.timeout_ms ?? 5_000, "timeout_ms", 1, 10_000)); mutates = false; break;
		case "evaluate": args.push(text(input.expression, "expression")); response = "data"; break;
		case "resize":
			args.push(number(input.width, "width", 80, 10_000), number(input.height, "height", 80, 10_000)); response = "structured"; break;
		case "ua":
			if (input.preset !== undefined) {
				if (!["ios", "android", "firefox-android", "edge-android", "chrome", "firefox", "edge", "desktop"].includes(input.preset)) throw new Error("Unknown user-agent preset");
				args.push(input.preset);
			}
			response = "structured"; mutates = input.preset !== undefined; break;
		case "launch": case "terminate": args.push(name(input.package, "package")); break;
		case "logs-start": break;
		default: throw new Error(`Unmapped ${kind} action: ${input.action}`);
	}
	return { args, response, mutates };
}
