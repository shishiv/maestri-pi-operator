export interface ReplyEnvelope {
	begin: string;
	end: string;
}

export type ReplyEnvelopeResult =
	| { reply: "received"; content: string; reason: "envelope-received" }
	| { reply: "unknown"; content: null; reason: "envelope-missing" | "envelope-duplicate" | "envelope-malformed" };

export function replyEnvelope(requestId: string): ReplyEnvelope {
	return {
		begin: `<<<MAESTRI_REPLY_BEGIN:${requestId}>>>`,
		end: `<<<MAESTRI_REPLY_END:${requestId}>>>`,
	};
}

export function isReplyEnvelopeMarker(line: string): boolean {
	return /^<<<MAESTRI_REPLY_(?:BEGIN|END):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}>>>$/i.test(line);
}

export function envelopedPrompt(prompt: string, requestId: string): string {
	return `${prompt}\n\nReturn your final reply exactly once inside a request-specific envelope. Request ID: ${requestId}. Construct the begin line by concatenating "<<<", "MAESTRI_REPLY_BEGIN:", the request ID, and ">>>". Construct the end line the same way with "MAESTRI_REPLY_END:". Put only your final reply between those lines and emit neither constructed marker elsewhere.`;
}

export function extractReplyEnvelope(capture: string, requestId: string): ReplyEnvelopeResult {
	const envelope = replyEnvelope(requestId);
	const lines = capture.split("\n");
	const trimmed = lines.map((line) => line.trim());
	const begins = trimmed.flatMap((line, index) => line === envelope.begin ? [index] : []);
	const ends = trimmed.flatMap((line, index) => line === envelope.end ? [index] : []);
	// A terminal capture includes earlier requests. Only this request's markers must be unique.
	const markerLines = trimmed.filter((line) =>
		line.includes(`<<<MAESTRI_REPLY_BEGIN:${requestId}`) || line.includes(`<<<MAESTRI_REPLY_END:${requestId}`));
	if (begins.length === 0 || ends.length === 0) return { reply: "unknown", content: null, reason: "envelope-missing" };
	if (begins.length !== 1 || ends.length !== 1 || markerLines.length !== 2) {
		return { reply: "unknown", content: null, reason: "envelope-duplicate" };
	}
	if (begins[0] >= ends[0]) return { reply: "unknown", content: null, reason: "envelope-malformed" };
	if (trimmed.slice(begins[0] + 1, ends[0]).some((line) =>
		line.includes("<<<MAESTRI_REPLY_BEGIN:") || line.includes("<<<MAESTRI_REPLY_END:"))) {
		return { reply: "unknown", content: null, reason: "envelope-malformed" };
	}
	const content = lines.slice(begins[0] + 1, ends[0]).join("\n").trim();
	if (!content) return { reply: "unknown", content: null, reason: "envelope-malformed" };
	return { reply: "received", content, reason: "envelope-received" };
}
