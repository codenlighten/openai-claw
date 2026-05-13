import { OpenAIClient, type ChatMessage, type ContentPart, type CompletionResult, type ToolCall } from "./client.js";
import type { Tool, ToolContext } from "./tools/types.js";
import type { ClawConfig } from "./config.js";
import { buildSystemPrompt } from "./prompts/system.js";
import { compactIfNeeded, estimateTokens } from "./memory/compaction.js";
import { computeCostUSD } from "./cost.js";

export interface AgentEvent {
  type:
    | "thinking"
    | "text_delta"
    | "text"
    | "tool_call"
    | "tool_progress"
    | "tool_result"
    | "usage"
    | "error"
    | "done";
  data?: any;
}

export type AgentEventHandler = (event: AgentEvent) => void;

/** Minimal interface the Agent needs from a model client. Lets tests inject a mock. */
export interface AgentClient {
  complete(
    messages: ChatMessage[],
    tools: Tool[],
    opts?: { abortSignal?: AbortSignal; stream?: boolean; onDelta?: (text: string) => void }
  ): Promise<CompletionResult>;
}

export interface AgentOptions {
  config: ClawConfig;
  tools: Tool[];
  permissionCheck: ToolContext["permissionCheck"];
  spawnSubagent?: ToolContext["spawnSubagent"];
  systemPromptExtras?: string[];
  /** Inject a custom client (mainly for tests). Defaults to a real OpenAIClient. */
  client?: AgentClient;
}

export class Agent {
  private client: AgentClient;
  private messages: ChatMessage[] = [];
  private toolsByName: Map<string, Tool>;
  private totalTokens = 0;
  private totalCostUSD = 0;

  constructor(private opts: AgentOptions) {
    this.client = opts.client ?? new OpenAIClient(opts.config);
    this.toolsByName = new Map(opts.tools.map((t) => [t.name, t]));

    const sys = buildSystemPrompt({
      config: opts.config,
      tools: opts.tools,
      extras: opts.systemPromptExtras ?? [],
    });
    this.messages.push({ role: "system", content: sys });
  }

  get conversation(): ChatMessage[] {
    return this.messages;
  }

  replaceConversation(messages: ChatMessage[]): void {
    // Keep our current system prompt; the resumed session's system prompt may be stale.
    const sys = this.messages[0];
    const incoming = messages.filter((m) => m.role !== "system");
    this.messages = [sys, ...incoming];
  }

  get usage() {
    return { totalTokens: this.totalTokens, totalCostUSD: this.totalCostUSD };
  }

  pushUser(content: string | ContentPart[]): void {
    this.messages.push({ role: "user", content });
  }

  clear(keepSystem = true): void {
    if (keepSystem && this.messages[0]?.role === "system") {
      this.messages = [this.messages[0]];
    } else {
      this.messages = [];
    }
  }

  /**
   * Run the agent loop until the model stops requesting tools or the abort signal fires.
   */
  async run(handler: AgentEventHandler, abortSignal?: AbortSignal): Promise<void> {
    const ctx: ToolContext = {
      config: this.opts.config,
      abortSignal,
      permissionCheck: this.opts.permissionCheck,
      spawnSubagent: this.opts.spawnSubagent,
    };

    while (true) {
      if (abortSignal?.aborted) {
        handler({ type: "error", data: "aborted" });
        return;
      }

      // Compact context if approaching limit.
      const compacted = await compactIfNeeded(this.messages, this.opts.config, this.client);
      if (compacted) this.messages = compacted;

      let completion;
      try {
        completion = await this.client.complete(this.messages, this.opts.tools, {
          abortSignal,
          stream: true,
          onDelta: (text) => handler({ type: "text_delta", data: text }),
        });
      } catch (e: any) {
        handler({ type: "error", data: e?.message ?? String(e) });
        return;
      }

      if (completion.usage) {
        this.totalTokens += completion.usage.total_tokens;
        this.totalCostUSD += computeCostUSD(
          this.opts.config.model,
          completion.usage.prompt_tokens,
          completion.usage.completion_tokens
        );
        handler({ type: "usage", data: { ...completion.usage, totalCostUSD: this.totalCostUSD } });
      }

      // Append assistant turn (with any tool calls) to the conversation.
      this.messages.push({
        role: "assistant",
        content: completion.content,
        tool_calls: completion.tool_calls.length > 0 ? completion.tool_calls : undefined,
      });

      if (completion.content) {
        handler({ type: "text", data: completion.content });
      }

      if (completion.tool_calls.length === 0) {
        handler({ type: "done" });
        return;
      }

      // Execute all tool calls.
      for (const call of completion.tool_calls) {
        const result = await this.executeTool(call, ctx, handler);
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: result,
        });
      }
    }
  }

  private async executeTool(
    call: ToolCall,
    ctx: ToolContext,
    handler: AgentEventHandler
  ): Promise<string> {
    const tool = this.toolsByName.get(call.function.name);
    if (!tool) {
      const msg = `Tool not found: ${call.function.name}`;
      handler({ type: "tool_result", data: { name: call.function.name, content: msg, isError: true } });
      return msg;
    }

    let parsedInput: any;
    try {
      parsedInput = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch (e: any) {
      const msg = `Invalid JSON arguments for ${tool.name}: ${e?.message ?? String(e)}`;
      handler({ type: "tool_result", data: { name: tool.name, content: msg, isError: true } });
      return msg;
    }

    handler({
      type: "tool_call",
      data: { name: tool.name, input: parsedInput, preview: tool.preview?.(parsedInput), callId: call.id },
    });

    // Permission check.
    if (tool.needsPermission) {
      const decision = await ctx.permissionCheck(tool.name, parsedInput);
      if (!decision.allow) {
        const msg = `Permission denied for ${tool.name}: ${decision.reason}`;
        handler({ type: "tool_result", data: { name: tool.name, content: msg, isError: true } });
        return msg;
      }
    }

    try {
      const runCtx: ToolContext = {
        ...ctx,
        callId: call.id,
        onProgress: (chunk: string) =>
          handler({ type: "tool_progress", data: { callId: call.id, name: tool.name, chunk } }),
      };
      const result = await tool.run(parsedInput, runCtx);
      handler({
        type: "tool_result",
        data: { name: tool.name, content: result.content, isError: result.isError, display: result.display, callId: call.id },
      });
      return result.content;
    } catch (e: any) {
      const msg = `Error in ${tool.name}: ${e?.message ?? String(e)}`;
      handler({ type: "tool_result", data: { name: tool.name, content: msg, isError: true } });
      return msg;
    }
  }
}
