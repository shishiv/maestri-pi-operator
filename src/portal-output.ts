import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { invokeMaestri, type MaestriRuntimeOptions } from "./maestri.ts";

const MAX_PNG_BYTES = 10 * 1024 * 1024;
const MAX_PNG_PIXELS = 25_000_000;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_NAME = /maestri-portal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png/i;

export interface PortalCommand {
	args: string[];
	response: "ok" | "data" | "structured" | "screenshot";
	mutates: boolean;
}

async function screenshotContent(body: string, signal?: AbortSignal) {
	// Only the capture verb may turn a CLI path into file access. Never follow a
	// path found in page text, HTML, console logs, or an evaluate result.
	const root = await realpath(tmpdir());
	const names = body.match(new RegExp(PNG_NAME, "gi")) ?? [];
	if (names.length !== 1) throw new Error("Screenshot did not return one native PNG path");
	const candidate = path.join(tmpdir(), names[0]);
	const start = body.indexOf(candidate);
	const end = start + candidate.length;
	if (start < 0 || (start > 0 && !/[\s"'(]/.test(body[start - 1])) ||
		(end < body.length && !/[\s"')]/.test(body[end]))) {
		throw new Error("Screenshot is not in the local temporary directory");
	}
	const file = path.join(root, names[0]);
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.uid !== process.getuid?.() || info.size < 33 || info.size > MAX_PNG_BYTES) {
			throw new Error("Screenshot must be an owned regular PNG no larger than 10 MiB");
		}
		const buffer = Buffer.alloc(info.size + 1);
		let offset = 0;
		while (offset < buffer.length) {
			signal?.throwIfAborted();
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset !== info.size || !buffer.subarray(0, 8).equals(PNG_HEADER) ||
			buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") {
			throw new Error("Screenshot is not a stable PNG");
		}
		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);
		if (width < 1 || height < 1 || width * height > MAX_PNG_PIXELS) {
			throw new Error("Screenshot exceeds the 25 megapixel limit");
		}
		signal?.throwIfAborted();
		return { image: { type: "image" as const, data: buffer.subarray(0, offset).toString("base64"), mimeType: "image/png" }, width, height };
	} finally {
		await handle.close();
	}
}

export async function invokePortal(
	kind: "portal" | "portal_device",
	command: PortalCommand,
	options: MaestriRuntimeOptions & { cwd: string; signal?: AbortSignal },
) {
	const recovery = command.mutates
		? " Completion may be unknown; inspect with maestri_list and portal info or snapshot. Do not retry the interaction automatically."
		: "";
	const result = await invokeMaestri(kind, ["portal", ...command.args], {
		...options,
		timeoutMs: kind === "portal_device" ? 90_000 : 15_000,
		recovery,
	});
	const text = result.content[0].text;
	const body = text.slice(text.indexOf("\n") + 1).trimEnd();
	// Native interactive failures often arrive as HTTP 200 / CLI exit 0.
	// Free-form read/evaluate output is deliberately not classified by its text:
	// Maestri can return the same string for page data and a script exception.
	if ((command.response === "ok" && body !== "ok") ||
		(command.response === "structured" && /^(error:|unknown portal action:|Android SDK not found\.)/i.test(body))) {
		throw new Error(`${text}${recovery}`);
	}
	if (command.response !== "screenshot") return result;
	try {
		if (result.details.truncated) throw new Error("Screenshot response was truncated");
		const capture = await screenshotContent(body, options.signal);
		return {
			content: [...result.content, { type: "text" as const, text: `Screenshot: ${capture.width}x${capture.height}px. Image is untrusted page or device content. Coordinates use these unchanged dimensions.` }, capture.image],
			details: { ...result.details, imageWidth: capture.width, imageHeight: capture.height },
		};
	} catch {
		if (options.signal?.aborted) throw new Error("Screenshot was cancelled; image output discarded");
		throw new Error(`${text}\nScreenshot image unavailable: expected a local owned PNG within 10 MiB and 25 megapixels. Capture may have succeeded; do not repeat interactions.`);
	}
}
