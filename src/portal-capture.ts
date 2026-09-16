import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_PNG_BYTES = 10 * 1024 * 1024;
const MAX_PNG_PIXELS = 25_000_000;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_NAME = /maestri-portal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png/i;

interface CaptureFile {
	handle: FileHandle;
	size: number;
	modified: number;
}

interface PngCapture {
	image: { type: "image"; data: string; mimeType: "image/png" };
	width: number;
	height: number;
}

interface PngDimensions {
	width: number;
	height: number;
}

export class ScreenshotCaptureError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScreenshotCaptureError";
	}
}

function extractCaptureName(body: string): string {
	const names = body.match(new RegExp(PNG_NAME, "gi")) ?? [];
	if (names.length !== 1) throw new Error("Screenshot did not return one native PNG path");
	const candidate = path.join(tmpdir(), names[0]);
	const start = body.indexOf(candidate);
	const end = start + candidate.length;
	const hasValidBounds = start >= 0 && (start === 0 || /[\s"'(]/.test(body[start - 1])) &&
		(end === body.length || /[\s"')]/.test(body[end]));
	if (!hasValidBounds) throw new Error("Screenshot is not in the local temporary directory");
	return names[0];
}

async function openCapture(name: string): Promise<CaptureFile> {
	const root = await realpath(tmpdir());
	const handle = await open(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.uid !== process.getuid?.() || info.size < 33 || info.size > MAX_PNG_BYTES) {
			throw new Error("Screenshot must be an owned regular PNG no larger than 10 MiB");
		}
		return { handle, size: info.size, modified: info.mtimeMs };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function readBounded(handle: FileHandle, size: number, signal?: AbortSignal): Promise<Buffer> {
	const buffer = Buffer.alloc(size);
	let offset = 0;
	while (offset < size) {
		signal?.throwIfAborted();
		const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
		if (bytesRead === 0) throw new Error("Screenshot changed while it was being read");
		offset += bytesRead;
	}
	return buffer;
}

function assertStablePng(buffer: Buffer): PngDimensions {
	const validHeader = buffer.subarray(0, 8).equals(PNG_HEADER) && buffer.readUInt32BE(8) === 13 &&
		buffer.toString("ascii", 12, 16) === "IHDR";
	if (!validHeader) throw new Error("Screenshot is not a stable PNG");
	const width = buffer.readUInt32BE(16);
	const height = buffer.readUInt32BE(20);
	if (width < 1 || height < 1 || width * height > MAX_PNG_PIXELS) {
		throw new Error("Screenshot exceeds the 25 megapixel limit");
	}
	return { width, height };
}

export async function assertUnchanged(handle: FileHandle, size: number, modified: number): Promise<void> {
	const info = await handle.stat();
	if (info.size !== size || info.mtimeMs !== modified) {
		throw new Error("Screenshot changed while it was being read");
	}
}

export async function readScreenshot(body: string, signal?: AbortSignal): Promise<PngCapture> {
	try {
		const file = await openCapture(extractCaptureName(body));
		try {
			const buffer = await readBounded(file.handle, file.size, signal);
			await assertUnchanged(file.handle, file.size, file.modified);
			const { width, height } = assertStablePng(buffer);
			signal?.throwIfAborted();
			return { image: { type: "image", data: buffer.toString("base64"), mimeType: "image/png" }, width, height };
		} finally {
			await file.handle.close();
		}
	} catch (error) {
		if (signal?.aborted) throw error;
		if (error instanceof ScreenshotCaptureError) throw error;
		const message = error instanceof Error ? error.message : "Screenshot capture failed";
		throw new ScreenshotCaptureError(message);
	}
}
