import { stripVTControlCharacters } from "node:util";

type Environment = Readonly<Record<string, string | undefined>>;

function isUnsafeControlCharacter(character: string): boolean {
	const code = character.charCodeAt(0);
	return code <= 0x08 || code === 0x0b || code === 0x0c ||
		(code >= 0x0e && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}

export function normalizeUntrustedText(input: string): string {
	return stripVTControlCharacters(input)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "")
		.replace(/[\u0085\u2028\u2029]/g, "\n")
		.split("")
		.filter((character) => !isUnsafeControlCharacter(character))
		.join("")
		.replace(/\p{Cf}/gu, "");
}

function isSensitiveEnvironmentName(name: string): boolean {
	// Shell directory metadata is not a password. MYSQL_PWD and other credential names still match below.
	if (name === "PWD" || name === "OLDPWD") return false;
	return name.startsWith("MAESTRI_") ||
		/(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|API_KEY|ACCESS_KEY|ACCESS_KEY_ID|PRIVATE_KEY|AUTH|AUTHORIZATION|COOKIE|CREDENTIAL|CREDENTIALS|PAT|DATABASE_URL|CONNECTION_STRING)(?:_|$)/i.test(name) ||
		name === "PGPASSWORD" || name === "KUBECONFIG";
}

export function redactSensitiveText(input: string, env: Environment): string {
	let output = normalizeUntrustedText(input);
	const values = Object.entries(env)
		.flatMap(([name, value]) => value && isSensitiveEnvironmentName(name)
			? [normalizeUntrustedText(value)]
			: [])
		.filter(Boolean)
		.sort((left, right) => right.length - left.length);
	for (const value of new Set(values)) output = output.replaceAll(value, "[REDACTED]");

	return output
		.replace(/\bgithub_pat_[A-Za-z0-9_]{6,}\b/gi, "[REDACTED]")
		.replace(/\b(?:gh[pousr]_[A-Za-z0-9]+|glpat-[A-Za-z0-9_-]+|npm_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]+)\b/gi, "[REDACTED]")
		.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
		.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
		.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
		.replace(/^([A-Z][A-Z0-9_]*)(\s*[=:]\s*).*$/gim, (line, name: string, separator: string) =>
			isSensitiveEnvironmentName(name) ? `${name}${separator}[REDACTED]` : line
		)
		.replace(/(authorization\s*[:=]\s*)([^\r\n]+)/gi, "$1[REDACTED]")
		.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]");
}
