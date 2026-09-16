import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

export type PiToolExecutionContext = Pick<ExtensionContext, "cwd">;

export type PiToolDefinition<TParams extends TSchema, TDetails extends object> =
	Omit<ToolDefinition<TParams, TDetails, never>, "execute"> & {
		execute(
			toolCallId: string,
			params: Static<TParams>,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
			context: PiToolExecutionContext,
		): Promise<AgentToolResult<TDetails>>;
	};

/** The only Pi capability needed by modules that register tools. */
export interface PiToolRegistrar {
	registerTool<TParams extends TSchema, TDetails extends object = object>(
		tool: PiToolDefinition<TParams, TDetails>,
	): void;
}
