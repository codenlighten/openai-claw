import { OpenAIClient } from "./client.js";
import { buildSystemPrompt } from "./prompts/system.js";
import { compactIfNeeded, estimateTokens } from "./memory/compaction.js";
import { computeCostUSD, appendCostLog } from "./cost.js";
import { resolveModel } from "./client.js";
function truncateForModel(s, cap) {
    if (s.length <= cap)
        return s;
    const dropped = s.length - cap;
    return s.slice(0, cap) + `\n[truncated: ${dropped} chars dropped — re-run with narrower args]`;
}
export class Agent {
    opts;
    client;
    messages = [];
    toolsByName;
    totalTokens = 0;
    totalCachedTokens = 0;
    totalPromptTokens = 0;
    totalCompletionTokens = 0;
    totalCostUSD = 0;
    /** Override the default model role for the very next turn (consumed once). */
    nextModelRole = "default";
    constructor(opts) {
        this.opts = opts;
        this.client = opts.client ?? new OpenAIClient(opts.config);
        this.toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
        const sys = buildSystemPrompt({
            config: opts.config,
            tools: opts.tools,
            extras: opts.systemPromptExtras ?? [],
        });
        this.messages.push({ role: "system", content: sys });
    }
    get conversation() {
        return this.messages;
    }
    replaceConversation(messages) {
        // Keep our current system prompt; the resumed session's system prompt may be stale.
        const sys = this.messages[0];
        const incoming = messages.filter((m) => m.role !== "system");
        this.messages = [sys, ...incoming];
    }
    get usage() {
        return {
            totalTokens: this.totalTokens,
            totalCachedTokens: this.totalCachedTokens,
            totalPromptTokens: this.totalPromptTokens,
            totalCompletionTokens: this.totalCompletionTokens,
            totalCostUSD: this.totalCostUSD,
            cacheHitRate: this.totalPromptTokens > 0 ? this.totalCachedTokens / this.totalPromptTokens : 0,
        };
    }
    pushUser(content) {
        this.messages.push({ role: "user", content });
    }
    /** Set the role used for the next agent turn. Reset to "default" automatically. */
    setNextRole(role) {
        this.nextModelRole = role;
    }
    /** Force a compaction pass right now, regardless of threshold. Returns [before, after] tokens or null. */
    async forceCompact() {
        const before = estimateTokens(this.messages);
        const compacted = await compactIfNeeded(this.messages, this.opts.config, this.client, true);
        if (!compacted)
            return null;
        this.messages = compacted;
        return { before, after: estimateTokens(this.messages) };
    }
    clear(keepSystem = true) {
        if (keepSystem && this.messages[0]?.role === "system") {
            this.messages = [this.messages[0]];
        }
        else {
            this.messages = [];
        }
    }
    /**
     * Run the agent loop until the model stops requesting tools or the abort signal fires.
     */
    async run(handler, abortSignal) {
        const ctx = {
            config: this.opts.config,
            abortSignal,
            permissionCheck: this.opts.permissionCheck,
            spawnSubagent: this.opts.spawnSubagent,
        };
        const maxTurns = this.opts.config.maxTurns;
        let turn = 0;
        while (true) {
            if (abortSignal?.aborted) {
                handler({ type: "error", data: "aborted" });
                return;
            }
            if (turn >= maxTurns) {
                handler({
                    type: "error",
                    data: `max turns reached (${maxTurns}). Use /config or settings.json to raise the limit.`,
                });
                return;
            }
            turn++;
            // Compact context if approaching limit. PreCompact hook may veto.
            const before = estimateTokens(this.messages);
            if (this.opts.runHook) {
                const outcomes = await this.opts.runHook("PreCompact", {
                    tokens: before,
                    limit: Math.floor(this.opts.config.contextWindow * this.opts.config.compactThreshold),
                });
                const blocked = outcomes.some((o) => o.blocked);
                if (blocked) {
                    handler({ type: "compaction", data: { skipped: "blocked by PreCompact hook" } });
                }
            }
            const compacted = await compactIfNeeded(this.messages, this.opts.config, this.client);
            if (compacted) {
                const after = estimateTokens(compacted);
                this.messages = compacted;
                handler({ type: "compaction", data: { beforeTokens: before, afterTokens: after } });
            }
            const role = this.nextModelRole;
            this.nextModelRole = "default";
            const turnModel = resolveModel(this.opts.config, role);
            let completion;
            try {
                completion = await this.client.complete(this.messages, this.opts.tools, {
                    abortSignal,
                    stream: true,
                    modelRole: role,
                    onDelta: (text) => handler({ type: "text_delta", data: text }),
                });
            }
            catch (e) {
                handler({ type: "error", data: e?.message ?? String(e) });
                return;
            }
            if (completion.usage) {
                this.totalTokens += completion.usage.total_tokens;
                this.totalPromptTokens += completion.usage.prompt_tokens;
                this.totalCompletionTokens += completion.usage.completion_tokens;
                this.totalCachedTokens += completion.usage.cached_tokens;
                const turnCost = computeCostUSD(turnModel, completion.usage.prompt_tokens, completion.usage.completion_tokens, completion.usage.cached_tokens);
                this.totalCostUSD += turnCost;
                appendCostLog(this.opts.config, {
                    model: turnModel,
                    role,
                    prompt_tokens: completion.usage.prompt_tokens,
                    cached_tokens: completion.usage.cached_tokens,
                    completion_tokens: completion.usage.completion_tokens,
                    costUSD: turnCost,
                });
                handler({
                    type: "usage",
                    data: {
                        ...completion.usage,
                        totalCostUSD: this.totalCostUSD,
                        model: turnModel,
                        role,
                    },
                });
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
            // Execute all tool calls in parallel; preserve original order when appending tool messages.
            const results = await Promise.all(completion.tool_calls.map((call) => this.executeTool(call, ctx, handler)));
            for (let i = 0; i < completion.tool_calls.length; i++) {
                const call = completion.tool_calls[i];
                this.messages.push({
                    role: "tool",
                    tool_call_id: call.id,
                    name: call.function.name,
                    content: truncateForModel(results[i], this.opts.config.maxToolResultChars),
                });
            }
        }
    }
    async executeTool(call, ctx, handler) {
        const tool = this.toolsByName.get(call.function.name);
        if (!tool) {
            const msg = `Tool not found: ${call.function.name}`;
            handler({ type: "tool_result", data: { name: call.function.name, content: msg, isError: true } });
            return msg;
        }
        let parsedInput;
        try {
            parsedInput = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        }
        catch (e) {
            const msg = `Invalid JSON arguments for ${tool.name}: ${e?.message ?? String(e)}`;
            handler({ type: "tool_result", data: { name: tool.name, content: msg, isError: true } });
            return msg;
        }
        handler({
            type: "tool_call",
            data: { name: tool.name, input: parsedInput, preview: tool.preview?.(parsedInput), callId: call.id },
        });
        // PreToolUse hook — exit code 2 vetoes the call entirely.
        if (this.opts.runHook) {
            const outcomes = await this.opts.runHook("PreToolUse", {
                tool_name: tool.name,
                tool_input: parsedInput,
            });
            const blocked = outcomes.find((o) => o.blocked);
            if (blocked) {
                const msg = `Blocked by PreToolUse hook: ${blocked.stderr.trim() || "(no message)"}`;
                handler({ type: "tool_result", data: { name: tool.name, content: msg, isError: true, callId: call.id } });
                return msg;
            }
        }
        // Permission check.
        if (tool.needsPermission) {
            const decision = await ctx.permissionCheck(tool.name, parsedInput);
            if (!decision.allow) {
                const msg = `Permission denied for ${tool.name}: ${decision.reason}`;
                handler({ type: "tool_result", data: { name: tool.name, content: msg, isError: true } });
                return msg;
            }
        }
        let resultContent = "";
        let resultIsError = false;
        try {
            const runCtx = {
                ...ctx,
                callId: call.id,
                onProgress: (chunk) => handler({ type: "tool_progress", data: { callId: call.id, name: tool.name, chunk } }),
            };
            const result = await tool.run(parsedInput, runCtx);
            resultContent = result.content;
            resultIsError = !!result.isError;
            handler({
                type: "tool_result",
                data: { name: tool.name, content: result.content, isError: result.isError, display: result.display, callId: call.id },
            });
        }
        catch (e) {
            resultContent = `Error in ${tool.name}: ${e?.message ?? String(e)}`;
            resultIsError = true;
            handler({ type: "tool_result", data: { name: tool.name, content: resultContent, isError: true } });
        }
        if (this.opts.runHook) {
            await this.opts.runHook("PostToolUse", {
                tool_name: tool.name,
                tool_input: parsedInput,
                tool_output: resultContent,
                is_error: resultIsError,
            });
        }
        return resultContent;
    }
}
//# sourceMappingURL=agent.js.map