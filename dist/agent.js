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
 * OpenAI rejects any request where an assistant message with `tool_calls`
 * isn't immediately followed by `role: "tool"` messages responding to every
 * `tool_call_id`. Conversations can drift out of compliance for two reasons:
 *   1. A thrown hook / aborted permission prompt kills the dispatch loop
 *      between "assistant pushed" and "tool messages pushed".
 *   2. Compaction trims the message window in a way that splits a tool-call
 *      from its responses.
 *
 * Both manifest as `400 Bad Request: tool_call_ids did not have response
 * messages: …`. Once the conversation is in this state it stays broken
 * forever — every retry hits the same error.
 *
 * This function mutates `messages` in place:
 *   - For each assistant message with tool_calls, ensures every id has a
 *     matching subsequent tool message before the next assistant/user turn.
 *     Missing ones get a placeholder tool message inserted right after.
 *   - Drops tool messages whose tool_call_id has no preceding assistant.
 *
 * Returns the count of injections + drops (useful for logging / tests).
 */
export function sanitizeMessages(messages) {
    let injected = 0;
    let dropped = 0;
    // Pass 1: collect every valid tool_call_id from assistant messages.
    const validIds = new Set();
    for (const m of messages) {
        if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                if (tc?.id)
                    validIds.add(tc.id);
            }
        }
    }
    // Pass 2: drop orphaned tool messages (no matching assistant tool_call).
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "tool" && (!m.tool_call_id || !validIds.has(m.tool_call_id))) {
            messages.splice(i, 1);
            dropped++;
        }
    }
    // Pass 3: walk forward; after each assistant-with-tool_calls, inject a
    // placeholder tool message for any id not already responded to before the
    // next non-tool message.
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role !== "assistant" || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0)
            continue;
        const needed = new Set(m.tool_calls.map((tc) => tc.id).filter(Boolean));
        let j = i + 1;
        while (j < messages.length && messages[j].role === "tool") {
            const id = messages[j].tool_call_id;
            if (id)
                needed.delete(id);
            j++;
        }
        if (needed.size === 0)
            continue;
        const placeholders = [];
        for (const tc of m.tool_calls) {
            if (!tc?.id || !needed.has(tc.id))
                continue;
            placeholders.push({
                role: "tool",
                tool_call_id: tc.id,
                name: tc.function?.name,
                content: `(no response captured — tool dispatch failed before completing; treat as no-op and retry if needed)`,
            });
            injected++;
        }
        messages.splice(j, 0, ...placeholders);
        // Skip past the placeholders we just inserted.
        i = j + placeholders.length - 1;
    }
    return { injected, dropped };
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
            // Heal any orphaned tool_call_ids before sending. Compaction, thrown
            // hooks, or aborted dispatches can leave the conversation with an
            // assistant tool_call that has no matching tool response, which OpenAI
            // rejects with a 400 that persists across retries until repaired.
            const sanitize = sanitizeMessages(this.messages);
            if ((sanitize.injected || sanitize.dropped) && process.env.CLAW_DEBUG) {
                console.error(`[claw] sanitized conversation: injected=${sanitize.injected} dropped=${sanitize.dropped}`);
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
                decision = await ctx.permissionCheck(tool.name, parsedInput);
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