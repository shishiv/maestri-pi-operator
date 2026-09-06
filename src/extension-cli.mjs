#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
	AskRequestNotFoundError,
	AskRequestRefusalError,
} from "./ask-store.ts";
import {
	ASK_WAITER_DEFAULT_TIMEOUT_SECONDS,
	ASK_WAITER_MAX_TIMEOUT_SECONDS,
	canonicalJson,
	waitForTerminalRequest,
} from "./ask-waiter.ts";

const EXTENSION_ID = "org.maestri.pi-operator";
const EXTENSION_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const ADAPTER_NAME = "maestri-ask";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class InvalidRequestError extends Error {}
class UsageError extends Error {}

function exactKeys(value, keys, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidRequestError(`${label} must be an object`);
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new InvalidRequestError(`${label} has unexpected fields`);
	}
}

async function readInput() {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of process.stdin) {
		bytes += chunk.length;
		if (bytes > 65_536) throw new InvalidRequestError("request is oversized");
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text || text.charCodeAt(0) === 0xfeff) throw new InvalidRequestError("request is invalid UTF-8 JSON");
	try {
		return JSON.parse(text);
	} catch {
		throw new InvalidRequestError("request is invalid JSON");
	}
}

function parseSourceReference(value) {
	if (typeof value !== "string") throw new InvalidRequestError("config_ref must be a string");
	const match = value.match(/^ask:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\?timeout=([0-9]{1,2}))?$/i);
	if (!match) throw new InvalidRequestError("config_ref must be ask:<request_id>[?timeout=<seconds>]");
	const timeout = match[2] === undefined ? ASK_WAITER_DEFAULT_TIMEOUT_SECONDS : Number(match[2]);
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > ASK_WAITER_MAX_TIMEOUT_SECONDS) {
		throw new InvalidRequestError(`timeout must be 1-${ASK_WAITER_MAX_TIMEOUT_SECONDS} seconds`);
	}
	return { requestId: match[1], timeout };
}

function response(requestId, result) {
	process.stdout.write(`${canonicalJson({
		schema: "firstmate.extension-response.v1",
		request_id: requestId,
		ok: true,
		result,
		error: null,
	})}\n`);
}

function failure(requestId, code, retryable) {
	process.stdout.write(`${canonicalJson({
		schema: "firstmate.extension-response.v1",
		request_id: requestId,
		ok: false,
		result: null,
		error: { code, retryable, diagnostic: code },
	})}\n`);
}

function handshake(request) {
	exactKeys(request, ["schema", "request_id", "host_protocols", "extension_id", "extension_version", "package_digest", "capability"], "handshake request");
	exactKeys(request.capability, ["name", "versions", "adapter_names"], "handshake capability");
	if (
		request.schema !== "firstmate.extension-handshake-request.v1" || request.extension_id !== EXTENSION_ID ||
		request.extension_version !== EXTENSION_VERSION || !request.host_protocols?.includes(1) ||
		request.capability.name !== "process-event-adapter" || !request.capability.versions?.includes(1) ||
		!Array.isArray(request.capability.adapter_names) || request.capability.adapter_names.length !== 1 ||
		request.capability.adapter_names[0] !== ADAPTER_NAME
	) {
		throw new InvalidRequestError("incompatible handshake");
	}
	process.stdout.write(`${canonicalJson({
		schema: "firstmate.extension-handshake-response.v1",
		request_id: request.request_id,
		extension_id: EXTENSION_ID,
		extension_version: EXTENSION_VERSION,
		host_protocol: 1,
		capability: "process-event-adapter",
		capability_version: 1,
		adapter_names: [ADAPTER_NAME],
	})}\n`);
}

async function invoke(request) {
	exactKeys(request, ["schema", "request_id", "host_protocol", "extension_id", "extension_version", "package_digest", "capability", "capability_version", "adapter", "operation", "input"], "extension request");
	if (
		request.schema !== "firstmate.extension-request.v1" || request.host_protocol !== 1 ||
		request.extension_id !== EXTENSION_ID || request.extension_version !== EXTENSION_VERSION ||
		request.capability !== "process-event-adapter" || request.capability_version !== 1 || request.adapter !== ADAPTER_NAME
	) {
		throw new InvalidRequestError("incompatible extension request");
	}
	if (request.operation === "source.poll") {
		exactKeys(request.input, ["source_id", "config_ref"], "source.poll input");
		const source = parseSourceReference(request.input.config_ref);
		const envelope = await waitForTerminalRequest(process.env, source.requestId, source.timeout * 1000);
		response(request.request_id, envelope
			? { status: "result", output: canonicalJson(envelope) }
			: { status: "no-result", output: "" });
		return;
	}
	if (request.operation === "result.classify") {
		exactKeys(request.input, ["source_id", "sequence", "content"], "result.classify input");
		response(request.request_id, { classification: "maestri-ask-terminal" });
		return;
	}
	if (request.operation === "result.terminal") {
		exactKeys(request.input, ["source_id", "sequence", "content"], "result.terminal input");
		response(request.request_id, { value: true });
		return;
	}
	if (request.operation === "result.silent") {
		exactKeys(request.input, ["source_id", "sequence", "content"], "result.silent input");
		response(request.request_id, { value: false });
		return;
	}
	throw new InvalidRequestError("unsupported extension operation");
}

async function plainWait(args) {
	let requestId = "";
	let timeout = ASK_WAITER_DEFAULT_TIMEOUT_SECONDS;
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === "--request" && args[index + 1]) requestId = args[++index];
		else if (args[index] === "--timeout" && args[index + 1]) timeout = Number(args[++index]);
		else throw new UsageError("usage: mpo-extension wait --request <uuid> [--timeout <1-55>]");
	}
	if (!UUID_RE.test(requestId) || !Number.isInteger(timeout) || timeout < 1 || timeout > ASK_WAITER_MAX_TIMEOUT_SECONDS) {
		throw new UsageError("usage: mpo-extension wait --request <uuid> [--timeout <1-55>]");
	}
	const envelope = await waitForTerminalRequest(process.env, requestId, timeout * 1000);
	if (envelope) process.stdout.write(`${canonicalJson(envelope)}\n`);
}

const verb = process.argv[2] ?? "";
let protocolRequestId = "sha256:" + "0".repeat(64);
try {
	if (verb === "wait") {
		await plainWait(process.argv.slice(3));
	} else if (verb === "handshake") {
		const request = await readInput();
		if (typeof request?.request_id === "string") protocolRequestId = request.request_id;
		handshake(request);
	} else if (verb === "invoke") {
		const request = await readInput();
		if (typeof request?.request_id === "string") protocolRequestId = request.request_id;
		await invoke(request);
	} else {
		throw new UsageError("usage: mpo-extension wait|handshake|invoke");
	}
} catch (error) {
	if (verb === "invoke") {
		if (error instanceof AskRequestRefusalError) failure(protocolRequestId, "conflict", false);
		else if (error instanceof AskRequestNotFoundError || error instanceof InvalidRequestError) failure(protocolRequestId, "invalid-request", false);
		else failure(protocolRequestId, "internal", true);
	} else {
		process.stderr.write(`${error instanceof Error ? error.message : "internal failure"}\n`);
		process.exitCode = error instanceof AskRequestRefusalError
			? 3
			: error instanceof AskRequestNotFoundError || error instanceof UsageError ? 2 : 4;
	}
}
