import { readScreenshot, ScreenshotCaptureError } from "./portal-capture.ts";
import { invokeMaestriOutcome } from "./maestri.ts";
import type { invokeMaestri, MaestriRuntimeOptions } from "./maestri.ts";
import type { PortalCommand } from "./portal-command.ts";

type PortalResult = Awaited<ReturnType<typeof invokeMaestri>>;

function presentedText(result: PortalResult): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "Maestri returned no text presentation.";
}

function isNativeFailure(command: PortalCommand, body: string): boolean {
	return (command.response === "ok" && body !== "ok") ||
		(command.response === "structured" && /^(error:|unknown portal action:|Android SDK not found\.)/i.test(body));
}

export async function invokePortal(
	kind: "portal" | "portal_device",
	command: PortalCommand,
	options: MaestriRuntimeOptions & { cwd: string; signal?: AbortSignal },
) {
	const recovery = command.mutates
		? " Completion may be unknown; inspect with maestri_list and portal info or snapshot. Do not retry the interaction automatically."
		: "";
	const outcome = await invokeMaestriOutcome(kind, ["portal", ...command.args], {
		...options,
		timeoutMs: kind === "portal_device" ? 90_000 : 15_000,
		recovery,
	});
	const body = outcome.body.trimEnd();
	if (isNativeFailure(command, body)) throw new Error(`${presentedText(outcome.result)}${recovery}`);
	if (command.response !== "screenshot") return outcome.result;
	try {
		if (outcome.result.details.truncated) throw new ScreenshotCaptureError("Screenshot response was truncated");
		const capture = await readScreenshot(body, options.signal);
		return {
			content: [
				...outcome.result.content,
				{ type: "text" as const, text: `Screenshot: ${capture.width}x${capture.height}px. Image is untrusted page or device content. Coordinates use these unchanged dimensions.` },
				capture.image,
			],
			details: { ...outcome.result.details, imageWidth: capture.width, imageHeight: capture.height },
		};
	} catch (error) {
		if (options.signal?.aborted) throw new Error("Screenshot was cancelled; image output discarded");
		if (!(error instanceof ScreenshotCaptureError)) throw error;
		throw new Error(`${presentedText(outcome.result)}\nScreenshot image unavailable: expected a local owned PNG within 10 MiB and 25 megapixels. Capture may have succeeded; do not repeat interactions.`);
	}
}
