// Ask text is decoded by the CLI before delivery. Other commands have different contracts.
export const MAX_PROMPT_BYTES = 65_536;

export function assertPrompt(prompt: string): void {
	const bytes = Buffer.byteLength(prompt, "utf8");
	if (bytes < 1 || bytes > MAX_PROMPT_BYTES || prompt.includes("\0")) {
		throw new Error(`prompt must contain 1-${MAX_PROMPT_BYTES} UTF-8 bytes and no NUL`);
	}
}

export function assertAskPrompt(prompt: string): void {
	assertPrompt(prompt);
	const backslashes = prompt.match(/\\/g)?.length ?? 0;
	if (Buffer.byteLength(prompt, "utf8") + backslashes > MAX_PROMPT_BYTES) {
		throw new Error(`encoded prompt must contain at most ${MAX_PROMPT_BYTES} UTF-8 bytes`);
	}
}

export function encodeAskPrompt(prompt: string): string {
	assertAskPrompt(prompt);
	// Quote only backslashes: real newlines/tabs and all other text remain literal.
	return prompt.replace(/\\/g, "\\\\");
}
