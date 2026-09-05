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
/**
 * Repair a conversation so OpenAI's strict tool-call contract is satisfied.
 *
 * OpenAI rejects any request where a tool message's `tool_call_id` does not
 * appear in the `tool_calls` of the immediately preceding assistant. The
 * contract is positional, not "valid somewhere in the history". Conversations
 * drift out of compliance via:
 *   1. A thrown hook / aborted permission prompt kills the dispatch loop
 *      between "assistant pushed" and "tool messages pushed" → orphan
 *      assistant with no responses.
 *   2. Two assistant turns get appended back-to-back with their tool messages
 *      pushed after both — so each tool ends up in the wrong slot.
 *   3. Compaction trims the message window in a way that splits a tool-call
 *      from its responses.
 *
 * All three produce the same family of 400 errors (`did not have response
 * messages` OR `not found in tool_calls of previous message`). Once stuck,
 * every retry hits the same error.
 *
 * This function rebuilds the conversation in canonical order: tool messages
 * are pulled out, then re-inserted immediately after the assistant that
 * declared their `tool_call_id`. Missing responses get a placeholder; tool
 * messages whose id doesn't match any assistant tool_call are dropped.
 *
 * Mutates `messages` in place. Returns counters for logging/tests.
 */
export function sanitizeMessages(messages) {
    let injected = 0;
    let dropped = 0;
    let reordered = 0;
    // Index every tool message by its tool_call_id (first occurrence wins),
    // and remember each tool message's original index for reorder detection.
    const toolByCallId = new Map();
    const originalToolIdx = new Map();
    const allToolMsgs = [];
    messages.forEach((m, i) => {
        if (m.role !== "tool")
            return;
        allToolMsgs.push(m);
        originalToolIdx.set(m, i);
        const id = m.tool_call_id;
        if (id && !toolByCallId.has(id))
            toolByCallId.set(id, m);
    });
    // Rebuild: keep every non-tool message in order, and after each assistant
    // with tool_calls, append its tool responses in declaration order.
    const rebuilt = [];
    const placedIds = new Set();
    for (const m of messages) {
        if (m.role === "tool")
            continue; // tool messages re-emitted below
        rebuilt.push(m);
        if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            for (const tc of m.tool_calls) {
                if (!tc?.id)
                    continue;
                const responder = toolByCallId.get(tc.id);
                if (responder) {
                    rebuilt.push(responder);
                    placedIds.add(tc.id);
                }
                else {
                    rebuilt.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        name: tc.function?.name,
                        content: `(no response captured — tool dispatch did not complete; treat as no-op and retry if needed)`,
                    });
                    injected++;
                }
            }
        }
    }
    // dropped = tool messages whose id never matched any assistant tool_call.
    for (const t of allToolMsgs) {
        const id = t.tool_call_id;
        if (!id || !placedIds.has(id))
            dropped++;
    }
    // reordered = tool messages that ended up at a different absolute index.
    rebuilt.forEach((m, i) => {
        if (m.role !== "tool")
            return;
        const old = originalToolIdx.get(m);
        if (old !== undefined && old !== i)
            reordered++;
    });
    if (rebuilt.length !== messages.length || injected || dropped || reordered) {
        messages.length = 0;
        messages.push(...rebuilt);
    }
    return { injected, dropped, reordered };
}
/**
 * Walk a parsed tool-call input and replace `null` with `undefined` so tools
 * written against the original (non-strict) schema don't have to special-case
 * the nullable values strict mode forces the model to emit for optional fields.
 * Mutates and returns the input.
 */
export function normalizeNulls(input) {
    if (input == null || typeof input !== "object")
        return input;
    if (Array.isArray(input)) {
        for (let i = 0; i < input.length; i++) {
            if (input[i] === null)
                input[i] = undefined;
            else
                normalizeNulls(input[i]);
        }
        return input;
    }
    for (const k of Object.keys(input)) {
        if (input[k] === null)
            input[k] = undefined;
        else
            normalizeNulls(input[k]);
    }
    return input;
}
/**
 * Validate parsed tool input against the tool's JSON schema. Catches missing
 * required fields and empty required strings BEFORE they reach the tool's run()
 * body (where they would otherwise crash inside Node internals like
 * `path.resolve(undefined)` or `undefined.replace(...)`).
 *
 * Must be called BEFORE normalizeNulls — strict-mode optional fields are sent
 * as `null` (an intentional "absent" marker), distinct from a truly missing
 * key. We treat the schema's `required` list as "key must be present"; the
 * non-nullable subset additionally must not be null or an empty string.
 *
 * Returns null on success or a directive error message the model can act on.
 */
export function validateToolInput(input, schema) {
    const required = schema.required ?? [];
    const properties = schema.properties ?? {};
    const missing = [];
    const empty = [];
    for (const key of required) {
        if (input == null || !(key in input)) {
            missing.push(key);
            continue;
        }
        const val = input[key];
        const propType = properties[key]?.type;
        const nullable = Array.isArray(propType) && propType.includes("null");
        // For non-nullable required fields, null/undefined is "missing".
        if (!nullable && val == null) {
            missing.push(key);
            continue;
        }
        const isString = propType === "string" || (Array.isArray(propType) && propType.includes("string"));
        if (isString && typeof val === "string" && val.length === 0) {
            empty.push(key);
        }
    }
    if (missing.length === 0 && empty.length === 0)
        return null;
    const parts = [];
    if (missing.length) {
        parts.push(`missing required field(s): ${missing.join(", ")}`);
    }
    if (empty.length) {
        parts.push(`required field(s) must not be empty: ${empty.join(", ")}`);
    }
    return `Invalid arguments — ${parts.join("; ")}. Re-issue the call with all required fields filled in.`;
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
    /**
     * prompt_tokens the API reported for the most recent request — the exact size
     * of the conversation as the model saw it. Cleared after a compaction, when
     * it no longer describes the messages we hold.
     */
    lastPromptTokens;
    /** Role for every turn of this agent unless a one-shot override is pending. */
    modelRole = "default";
    /** Override for the very next turn only. null when nothing is pending. */
    nextModelRole = null;
    constructor(opts) {
        this.opts = opts;
        this.client = opts.client ?? new OpenAIClient(opts.config);
        this.toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
        if (opts.modelRole)
            this.modelRole = opts.modelRole;
        this.messages.push({ role: "system", content: this.renderSystemPrompt() });
    }
    renderSystemPrompt() {
        return buildSystemPrompt({
            config: this.opts.config,
            tools: this.opts.tools,
            extras: this.opts.systemPromptExtras ?? [],
            variant: this.opts.systemPromptVariant,
        });
    }
    /**
     * Rebuild the system prompt in place. The prompt embeds persistent memory and
     * project instructions, and it was built once in the constructor — so a
     * memory saved with /remember did not reach the model until the next restart.
     * The prompt's stable-prefix-first layout means only the tail changes, so the
     * provider's prefix cache survives this.
     */
    refreshSystemPrompt() {
        const sys = this.renderSystemPrompt();
        if (this.messages[0]?.role === "system")
            this.messages[0] = { role: "system", content: sys };
        else
            this.messages.unshift({ role: "system", content: sys });
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
    /** Use `role` for the next turn only, then revert to the standing role. */
    setNextRole(role) {
        this.nextModelRole = role;
    }
    /** Force a compaction pass right now, regardless of threshold. Returns [before, after] tokens or null. */
    async forceCompact() {
        const before = this.lastPromptTokens ?? estimateTokens(this.messages);
        const compacted = await compactIfNeeded(this.messages, this.opts.config, this.client, true, this.lastPromptTokens);
        if (!compacted)
            return null;
        this.messages = compacted;
        this.lastPromptTokens = undefined;
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
            const before = this.lastPromptTokens ?? estimateTokens(this.messages);
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
            const compacted = await compactIfNeeded(this.messages, this.opts.config, this.client, false, this.lastPromptTokens, abortSignal);
            if (compacted) {
                const after = estimateTokens(compacted);
                this.messages = compacted;
                this.lastPromptTokens = undefined;
                handler({ type: "compaction", data: { beforeTokens: before, afterTokens: after } });
            }
            if (abortSignal?.aborted) {
                handler({ type: "error", data: "aborted" });
                return;
            }
            // Heal any orphaned tool_call_ids before sending. Compaction, thrown
            // hooks, or aborted dispatches can leave the conversation with an
            // assistant tool_call that has no matching tool response, which OpenAI
            // rejects with a 400 that persists across retries until repaired.
            const sanitize = sanitizeMessages(this.messages);
            if ((sanitize.injected || sanitize.dropped || sanitize.reordered) && process.env.CLAW_DEBUG) {
                console.error(`[claw] sanitized conversation: injected=${sanitize.injected} dropped=${sanitize.dropped} reordered=${sanitize.reordered}`);
            }
            const role = this.nextModelRole ?? this.modelRole;
            this.nextModelRole = null;
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
                this.lastPromptTokens = completion.usage.prompt_tokens;
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
            // finish_reason "length" means the model was cut off mid-output. With no
            // tool calls the loop would otherwise emit `done` and the truncated text
            // would read as a finished answer. A truncated tool call is worse: its
            // arguments fail to parse and the call is dropped, so the turn looks like
            // a plain text reply.
            if (completion.finish_reason === "length") {
                handler({
                    type: "warning",
                    data: `response hit the output token limit and was cut off${this.opts.config.maxTokens ? ` (maxTokens=${this.opts.config.maxTokens})` : ""}. Treat it as incomplete — raise maxTokens or ask for a smaller piece of work.`,
                });
            }
            if (completion.tool_calls.length === 0) {
                handler({ type: "done", data: { finishReason: completion.finish_reason } });
                return;
            }
            // Execute all tool calls in parallel; preserve original order when appending tool messages.
            // Use allSettled so that even if executeTool throws unexpectedly (despite its own
            // try/catch), every assistant tool_call still gets a paired tool message — otherwise
            // OpenAI rejects subsequent requests with "tool_call_ids did not have response messages".
            const settled = await Promise.allSettled(completion.tool_calls.map((call) => this.executeTool(call, ctx, handler)));
            for (let i = 0; i < completion.tool_calls.length; i++) {
                const call = completion.tool_calls[i];
                const outcome = settled[i];
                const content = outcome.status === "fulfilled"
                    ? outcome.value
                    : `Error in ${call.function.name}: ${outcome.reason?.message ?? String(outcome.reason)}`;
                this.messages.push({
                    role: "tool",
                    tool_call_id: call.id,
                    name: call.function.name,
                    content: truncateForModel(content, this.opts.config.maxToolResultChars),
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
        // Validate against the tool's schema BEFORE calling run(). Missing required
        // fields previously crashed inside Node internals (e.g. path.resolve(undefined))
        // and surfaced as confusing errors like 'paths[0] must be of type string'.
        // Validation must run BEFORE null-normalization — strict-mode optional fields
        // arrive as legitimate nulls that we must NOT confuse with truly-missing keys.
        const validationError = validateToolInput(parsedInput, tool.parameters);
        if (validationError) {
            const msg = `${tool.name}: ${validationError}`;
            handler({ type: "tool_result", data: { name: tool.name, content: msg, isError: true, callId: call.id } });
            return msg;
        }
        // Strict-mode schemas force optional fields to be present (often as null).
        // Tools were written against the non-strict shape, so collapse nulls back
        // to undefined before dispatch.
        normalizeNulls(parsedInput);
        handler({
            type: "tool_call",
            data: { name: tool.name, input: parsedInput, preview: tool.preview?.(parsedInput), callId: call.id },
        });
        // PreToolUse hook — exit code 2 vetoes the call entirely. A throwing
        // hook must NOT crash the dispatch loop; treat it as "not blocked".
        if (this.opts.runHook) {
            try {
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
            catch (e) {
                handler({
                    type: "tool_result",
                    data: { name: tool.name, content: `PreToolUse hook crashed (ignored): ${e?.message ?? String(e)}`, isError: false, callId: call.id },
                });
            }
        }
        // Permission check — a throwing check (user aborted prompt, etc.) must not
        // leak; treat as a denial so the conversation stays coherent.
        if (tool.needsPermission) {
            let decision;
            try {
                decision = await ctx.permissionCheck(tool.name, parsedInput, { mutates: tool.mutates });
            }
            catch (e) {
                decision = { allow: false, reason: `permission check failed: ${e?.message ?? String(e)}` };
            }
            if (!decision.allow) {
                const msg = `Permission denied for ${tool.name}: ${decision.reason ?? "(no reason)"}`;
                handler({ type: "tool_result", data: { name: tool.name, content: msg, isError: true, callId: call.id } });
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
            handler({ type: "tool_result", data: { name: tool.name, content: resultContent, isError: true, callId: call.id } });
        }
        // PostToolUse hook — same hardening: a thrown hook must not orphan this tool_call.
        if (this.opts.runHook) {
            try {
                await this.opts.runHook("PostToolUse", {
                    tool_name: tool.name,
                    tool_input: parsedInput,
                    tool_output: resultContent,
                    is_error: resultIsError,
                });
            }
            catch (e) {
                // Surface to the UI but don't propagate — the tool already ran and we
                // owe the model a tool message no matter what.
                handler({
                    type: "tool_result",
                    data: { name: tool.name, content: `PostToolUse hook crashed (ignored): ${e?.message ?? String(e)}`, isError: false, callId: call.id },
                });
            }
        }
        return resultContent;
    }
}
//# sourceMappingURL=agent.js.map