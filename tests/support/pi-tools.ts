import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Assert } from "typebox/value";
import type { PiToolRegistrar } from "../../src/pi-tool.ts";

type ToolResult = AgentToolResult<object>;
type ToolInvocation = <TParams extends object>(params: TParams, signal?: AbortSignal) => Promise<ToolResult>;

export interface PiToolHarness {
	registrar: PiToolRegistrar;
	registeredNames(): string[];
	invoke<TParams extends object>(name: string, params: TParams, signal?: AbortSignal): Promise<ToolResult>;
}

/** Registers real tool definitions while retaining each schema in its invocation closure. */
export function createPiToolHarness(cwd: string): PiToolHarness {
	const invocations = new Map<string, ToolInvocation>();
	const registrar: PiToolRegistrar = {
		registerTool(tool) {
			const invoke: ToolInvocation = async (params, signal) => {
				Assert(tool.parameters, params);
				return tool.execute("test-call", params, signal, undefined, { cwd });
			};
			invocations.set(tool.name, invoke);
		},
	};

	return {
		registrar,
		registeredNames() {
			return [...invocations.keys()];
		},
		async invoke(name, params, signal) {
			const registered = invocations.get(name);
			assert.ok(registered, `tool was not registered: ${name}`);
			return registered(params, signal);
		},
	};
}
