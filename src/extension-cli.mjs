#!/usr/bin/env node
// @ts-check

import { readFileSync } from "node:fs";
import {
	AskRequestNotFoundError,
	AskRequestRefusalError,
} from "./ask-store.ts";
import {
	ASK_WAITER_DEFAULT_TIMEOUT_SECONDS,
	ASK_WAITER_MAX_TIMEOUT_SECONDS,
	AskWaiterContextError,
	canonicalJson,
	waitForTerminalRequest,
} from "./ask-waiter.ts";

/** @typedef {import("./ask-terminal.ts").CanonicalJsonValue} JsonValue */
/** @typedef {import("./ask-terminal.ts").CanonicalJsonObject} JsonObject */
/** @typedef {import("./ask-waiter.ts").Environment} Environment */
/** @typedef {import("./ask-terminal.ts").AskTerminalEnvelope} AskTerminalEnvelope */

const EXTENSION_ID = "org.maestri.pi-operator";
const EXTENSION_VERSION = readPackageVersion(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ADAPTER_NAME = "maestri-ask";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_PROTOCOL_REQUEST_ID = `sha256:${"0".repeat(64)}`;

class InvalidRequestError extends Error {}
class UsageError extends Error {}

/**
 * @param {string} text
 * @returns {string}
 */
function readPackageVersion(text) {
	const value = JSON.parse(text);
	if (!isObject(value) || !isString(value.version)) throw new Error("package version is invalid");
	return value.version;
}

/**
 * @param {JsonValue} value
 * @returns {value is JsonObject}
 */
function isObject(value) {
	return value !== null && value instanceof Object && !Array.isArray(value);
}

/** @param {JsonValue} value @returns {value is string} */
function isString(value) {
	return Object.prototype.toString.call(value) === "[object String]";
}

/** @param {JsonValue} value @returns {value is number} */
function isNumber(value) {
	return Object.prototype.toString.call(value) === "[object Number]";
}

/**
 * @param {JsonValue} value
 * @param {string} label
 * @returns {JsonObject}
 */
function requireObject(value, label) {
	if (!isObject(value)) throw new InvalidRequestError(`${label} must be an object`);
	return value;
}

/**
 * @param {JsonObject} value
 * @param {readonly string[]} keys
 * @param {string} label
 */
function exactKeys(value, keys, label) {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new InvalidRequestError(`${label} has unexpected fields`);
	}
}

/** @param {JsonObject} value @param {string} key @param {string} label @returns {string} */
function requiredString(value, key, label) {
	const field = value[key];
	if (!isString(field)) throw new InvalidRequestError(`${label}.${key} must be a string`);
	return field;
}

/** @param {JsonObject} value @param {string} key @param {string} label @returns {JsonValue} */
function requiredValue(value, key, label) {
	if (!(key in value)) throw new InvalidRequestError(`${label}.${key} is required`);
	return value[key];
}

/** @param {JsonValue} value @param {string} label @returns {string[]} */
function stringArray(value, label) {
	if (!Array.isArray(value) || !value.every(isString)) throw new InvalidRequestError(`${label} must be a string array`);
	return value;
}

/** @param {JsonValue} value @param {string} label @returns {number[]} */
function integerArray(value, label) {
	if (!Array.isArray(value) || !value.every((item) => isNumber(item) && Number.isInteger(item))) {
		throw new InvalidRequestError(`${label} must be an integer array`);
	}
	return value;
}

/** @param {string} text @returns {JsonValue} */
function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		throw new InvalidRequestError("request is invalid JSON");
	}
}

/** @returns {Promise<JsonValue>} */
async function readInput() {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of process.stdin) {
		bytes += chunk.length;
		if (bytes > 65_536) throw new InvalidRequestError("request is oversized");
		chunks.push(chunk);
	}
	let decoded;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
	} catch {
		throw new InvalidRequestError("request is invalid UTF-8 JSON");
	}
	if (!decoded || decoded.charCodeAt(0) === 0xfeff) throw new InvalidRequestError("request is invalid UTF-8 JSON");
	return parseJson(decoded);
}

/**
 * @param {JsonValue} value
 * @returns {{ requestId: string; timeout: number }}
 */
function parseSourceReference(value) {
	if (!isString(value)) throw new InvalidRequestError("config_ref must be a string");
	const match = value.match(/^ask:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\?timeout=([0-9]{1,2}))?$/i);
	if (!match) throw new InvalidRequestError("config_ref must be ask:<request_id>[?timeout=<seconds>]");
	const timeout = match[2] === undefined ? ASK_WAITER_DEFAULT_TIMEOUT_SECONDS : Number(match[2]);
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > ASK_WAITER_MAX_TIMEOUT_SECONDS) {
		throw new InvalidRequestError(`timeout must be 1-${ASK_WAITER_MAX_TIMEOUT_SECONDS} seconds`);
	}
	return { requestId: match[1], timeout };
}

/** @param {JsonObject} request @returns {boolean} */
function hasRequestMetadata(request) {
	return isString(request.request_id) && isString(request.package_digest);
}

/** @param {JsonObject} request @returns {boolean} */
function matchesHandshakeIdentity(request) {
	return requiredString(request, "schema", "handshake request") === "firstmate.extension-handshake-request.v1" &&
		requiredString(request, "extension_id", "handshake request") === EXTENSION_ID &&
		requiredString(request, "extension_version", "handshake request") === EXTENSION_VERSION;
}

/** @param {JsonObject} request @returns {boolean} */
function matchesExtensionIdentity(request) {
	return requiredString(request, "schema", "extension request") === "firstmate.extension-request.v1" &&
		requiredString(request, "extension_id", "extension request") === EXTENSION_ID &&
		requiredString(request, "extension_version", "extension request") === EXTENSION_VERSION &&
		requiredString(request, "capability", "extension request") === "process-event-adapter" &&
		requiredString(request, "adapter", "extension request") === ADAPTER_NAME;
}

/**
 * @param {JsonObject} request
 * @param {JsonObject} capability
 * @param {number[]} hostProtocols
 * @param {number[]} versions
 * @param {string[]} adapterNames
 */
function assertHandshakeCompatibility(request, capability, hostProtocols, versions, adapterNames) {
	const compatible =
		hasRequestMetadata(request) && matchesHandshakeIdentity(request) &&
		hostProtocols.includes(1) &&
		requiredString(capability, "name", "handshake capability") === "process-event-adapter" &&
		versions.includes(1) && adapterNames.length === 1 && adapterNames[0] === ADAPTER_NAME;
	if (!compatible) throw new InvalidRequestError("incompatible handshake");
}

/** @param {JsonObject} request */
function assertExtensionCompatibility(request) {
	const compatible =
		hasRequestMetadata(request) && matchesExtensionIdentity(request) &&
		isNumber(request.host_protocol) && request.host_protocol === 1 &&
		isNumber(request.capability_version) && request.capability_version === 1;
	if (!compatible) throw new InvalidRequestError("incompatible extension request");
}

/** @param {JsonValue} value @returns {JsonObject} */
function parseHandshake(value) {
	const request = requireObject(value, "handshake request");
	exactKeys(request, ["schema", "request_id", "host_protocols", "extension_id", "extension_version", "package_digest", "capability"], "handshake request");
	const capability = requireObject(requiredValue(request, "capability", "handshake request"), "handshake capability");
	exactKeys(capability, ["name", "versions", "adapter_names"], "handshake capability");
	const hostProtocols = integerArray(requiredValue(request, "host_protocols", "handshake request"), "host_protocols");
	const versions = integerArray(requiredValue(capability, "versions", "handshake capability"), "capability.versions");
	const adapterNames = stringArray(requiredValue(capability, "adapter_names", "handshake capability"), "capability.adapter_names");
	assertHandshakeCompatibility(request, capability, hostProtocols, versions, adapterNames);
	return request;
}

/** @param {JsonValue} value @returns {JsonObject} */
function parseExtensionRequest(value) {
	const request = requireObject(value, "extension request");
	exactKeys(request, ["schema", "request_id", "host_protocol", "extension_id", "extension_version", "package_digest", "capability", "capability_version", "adapter", "operation", "input"], "extension request");
	assertExtensionCompatibility(request);
	return request;
}

/** @param {string} requestId @param {JsonValue} result */
function response(requestId, result) {
	process.stdout.write(`${canonicalJson({
		schema: "firstmate.extension-response.v1",
		request_id: requestId,
		ok: true,
		result,
		error: null,
	})}\n`);
}

/** @param {string} requestId @param {"conflict"|"invalid-request"|"missing-context"|"internal"} code @param {boolean} retryable */
function failure(requestId, code, retryable) {
	process.stdout.write(`${canonicalJson({
		schema: "firstmate.extension-response.v1",
		request_id: requestId,
		ok: false,
		result: null,
		error: { code, retryable, diagnostic: code },
	})}\n`);
}

/** @param {JsonObject} request */
function handshake(request) {
	const checked = parseHandshake(request);
	const requestId = requiredString(checked, "request_id", "handshake request");
	process.stdout.write(`${canonicalJson({
		schema: "firstmate.extension-handshake-response.v1",
		request_id: requestId,
		extension_id: EXTENSION_ID,
		extension_version: EXTENSION_VERSION,
		host_protocol: 1,
		capability: "process-event-adapter",
		capability_version: 1,
		adapter_names: [ADAPTER_NAME],
	})}\n`);
}

/** @param {JsonObject} request @returns {Promise<void>} */
async function invokeSourcePoll(request) {
	const input = requireObject(requiredValue(request, "input", "extension request"), "source.poll input");
	exactKeys(input, ["source_id", "config_ref"], "source.poll input");
	const source = parseSourceReference(requiredValue(input, "config_ref", "source.poll input"));
	const envelope = await waitForTerminalRequest(process.env, source.requestId, source.timeout * 1000);
	response(requiredString(request, "request_id", "extension request"), envelope
		? { status: "result", output: canonicalJson(envelope) }
		: { status: "no-result", output: "" });
}

/** @param {JsonObject} request @param {"result.classify"|"result.terminal"|"result.silent"} operation */
function invokeResultClassification(request, operation) {
	const input = requireObject(requiredValue(request, "input", "extension request"), `${operation} input`);
	exactKeys(input, ["source_id", "sequence", "content"], `${operation} input`);
	const requestId = requiredString(request, "request_id", "extension request");
	if (operation === "result.classify") response(requestId, { classification: "maestri-ask-terminal" });
	else response(requestId, { value: operation === "result.terminal" });
}

/** @param {JsonObject} request @returns {Promise<void>} */
async function invoke(request) {
	const checked = parseExtensionRequest(request);
	const operation = requiredString(checked, "operation", "extension request");
	if (operation === "source.poll") return invokeSourcePoll(checked);
	if (operation === "result.classify" || operation === "result.terminal" || operation === "result.silent") {
		invokeResultClassification(checked, operation);
		return;
	}
	throw new InvalidRequestError("unsupported extension operation");
}

/** @param {string[]} args @returns {{ requestId: string; timeout: number }} */
function parseWaitArgs(args) {
	let requestId = "";
	let timeout = ASK_WAITER_DEFAULT_TIMEOUT_SECONDS;
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index];
		const value = args[index + 1];
		if ((flag === "--request" || flag === "--timeout") && value) {
			if (flag === "--request") requestId = value;
			else timeout = Number(value);
			index += 1;
			continue;
		}
		throw new UsageError("usage: mpo-extension wait --request <uuid> [--timeout <1-55>]");
	}
	if (!UUID_RE.test(requestId) || !Number.isInteger(timeout) || timeout < 1 || timeout > ASK_WAITER_MAX_TIMEOUT_SECONDS) {
		throw new UsageError("usage: mpo-extension wait --request <uuid> [--timeout <1-55>]");
	}
	return { requestId, timeout };
}

/** @param {string[]} args @returns {Promise<void>} */
async function plainWait(args) {
	const parsed = parseWaitArgs(args);
	const envelope = await waitForTerminalRequest(process.env, parsed.requestId, parsed.timeout * 1000);
	if (envelope) process.stdout.write(`${canonicalJson(envelope)}\n`);
}

/** @param {JsonValue} value @returns {string} */
function protocolRequestId(value) {
	return isObject(value) && isString(value.request_id) ? value.request_id : DEFAULT_PROTOCOL_REQUEST_ID;
}

const verb = process.argv[2] ?? "";
let requestId = DEFAULT_PROTOCOL_REQUEST_ID;
try {
	if (verb === "wait") {
		await plainWait(process.argv.slice(3));
	} else if (verb === "handshake") {
		const input = await readInput();
		requestId = protocolRequestId(input);
		handshake(requireObject(input, "handshake request"));
	} else if (verb === "invoke") {
		const input = await readInput();
		requestId = protocolRequestId(input);
		await invoke(requireObject(input, "extension request"));
	} else {
		throw new UsageError("usage: mpo-extension wait|handshake|invoke");
	}
} catch (error) {
	if (verb === "invoke") {
		if (error instanceof AskWaiterContextError) failure(requestId, "missing-context", false);
		else if (error instanceof AskRequestRefusalError) failure(requestId, "conflict", false);
		else if (error instanceof AskRequestNotFoundError || error instanceof InvalidRequestError) failure(requestId, "invalid-request", false);
		else failure(requestId, "internal", true);
	} else {
		process.stderr.write(`${error instanceof Error ? error.message : "internal failure"}\n`);
		process.exitCode = error instanceof AskWaiterContextError ? 2
			: error instanceof AskRequestRefusalError ? 3
			: error instanceof AskRequestNotFoundError || error instanceof UsageError ? 2 : 4;
	}
}
