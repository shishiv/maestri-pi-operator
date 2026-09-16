import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DEVICE_ACTIONS, WEB_ACTIONS, portalCommand } from "./portal-command.ts";
import { invokePortal } from "./portal-output.ts";
import type { MaestriRuntimeOptions } from "./maestri.ts";
import type { PiToolRegistrar } from "./pi-tool.ts";

const name = Type.String({ minLength: 1, maxLength: 256 });
const text = Type.String({ maxLength: 65_536 });
const target = Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Connected portal name; omit for create or devices" }));
const direction = Type.Optional(StringEnum(["up", "down", "left", "right"]));
const amount = Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000, description: "Scroll pixels; default 300" }));

export function registerPortalTools(pi: PiToolRegistrar, options: MaestriRuntimeOptions = {}): void {
	pi.registerTool({
		name: "maestri_portal",
		label: "Maestri web portal",
		description: "Control a connected Maestri browser portal, not an Android device. Screenshots return images. create returns before the page is ready. close deletes the portal: only on explicit user request",
		promptGuidelines: [
			"Use maestri_list for exact portal names. With maestri_portal, refresh snapshot refs after page changes; never retry an interrupted interaction automatically.",
		],
		parameters: Type.Object({
			action: StringEnum(WEB_ACTIONS),
			portal: target,
			name: Type.Optional(name),
			url: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536, description: "create, edit or navigate" })),
			selector: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536, description: "@e ref, CSS or x,y; optional for type, clear, selectall and scroll" })),
			to: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536, description: "Drag destination selector" })),
			text: Type.Optional(Type.String({ maxLength: 65_536, description: "fill or type; literal text" })),
			key: Type.Optional(Type.String({ minLength: 1, description: "key action; e.g. Enter or ctrl+a" })),
			value: Type.Optional(Type.String({ maxLength: 65_536, description: "select option text" })),
			direction,
			amount,
			width: Type.Optional(Type.Integer({ minimum: 80, maximum: 10_000, description: "create or resize, with height; CSS pixels" })),
			height: Type.Optional(Type.Integer({ minimum: 80, maximum: 10_000 })),
			timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000, description: "wait action; default 5000" })),
			expression: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536, description: "evaluate JavaScript" })),
			preset: Type.Optional(StringEnum(["ios", "android", "firefox-android", "edge-android", "chrome", "firefox", "edge", "desktop"], { description: "ua action; omit to inspect, setting reloads" })),
		}, { additionalProperties: false }),
		async execute(_id, params, signal, _update, ctx) {
			return invokePortal("portal", portalCommand("portal", params), { ...options, signal, cwd: ctx.cwd });
		},
	});

	pi.registerTool({
		name: "maestri_portal_device",
		label: "Maestri Android portal",
		description: "Control Android emulators or phones through Maestri device portals. devices discovers IDs for create; creation does not wait for boot. Screenshots return images. close deletes the portal: only on explicit user request",
		promptGuidelines: [
			"Use maestri_portal_device for Android, not maestri_portal. Refresh snapshot or screenshot after screen changes; coordinates use the latest capture dimensions. Never retry an interrupted interaction automatically.",
		],
		parameters: Type.Object({
			action: StringEnum(DEVICE_ACTIONS),
			portal: target,
			device: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "ID from devices, for create" })),
			name: Type.Optional(name),
			selector: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "tap or swipe origin: @e ref or x,y, never CSS" })),
			to: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Swipe destination: @e ref or x,y" })),
			text: Type.Optional(text),
			key: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "key action: Enter, back, home, recents, power, volumeup, volumedown; button: home, lock, side" })),
			direction,
			amount,
			package: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Installed Android package for launch or terminate" })),
			url: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536, description: "navigate URL or deep link" })),
		}, { additionalProperties: false }),
		async execute(_id, params, signal, _update, ctx) {
			return invokePortal("portal_device", portalCommand("portal_device", params), { ...options, signal, cwd: ctx.cwd });
		},
	});
}
