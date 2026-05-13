import OpenAI from "openai";
export function resolveModel(config, role = "default") {
    return config.models?.[role] ?? config.model;
}
export class FriendlyApiError extends Error {
    retryable;
    constructor(message, retryable) {
        super(message);
        this.retryable = retryable;
        this.name = "FriendlyApiError";
    }
}
function classifyError(e) {
    const status = e?.status ?? e?.response?.status;
    const code = e?.code;
    const msg = e?.message ?? String(e);
    if (status === 401) {
        return new FriendlyApiError("OpenAI rejected the API key (401). Check OPENAI_API_KEY in your .env or environment.", false);
    }
    if (status === 404) {
        return new FriendlyApiError(`Model not found (404). Check that the model name is correct: ${msg}`, false);
    }
    if (status === 429) {
        return new FriendlyApiError(`Rate limited (429). ${msg}`, true);
    }
    if (status === 400) {
        return new FriendlyApiError(`Bad request (400): ${msg}`, false);
    }
    if (status === 403) {
        return new FriendlyApiError(`Forbidden (403). Your account may not have access to this model: ${msg}`, false);
    }
    if (status && status >= 500) {
        return new FriendlyApiError(`OpenAI server error (${status}). ${msg}`, true);
    }
    if (code === "ECONNRESET" || code === "ENOTFOUND" || code === "ETIMEDOUT" || code === "EAI_AGAIN") {
        return new FriendlyApiError(`Network error (${code}). Check your connection.`, true);
    }
    if (e?.name === "AbortError" || msg.includes("aborted")) {
        return new FriendlyApiError("Request aborted.", false);
    }
    return new FriendlyApiError(msg, false);
}
async function withRetry(fn, opts = {}) {
    const maxAttempts = opts.maxAttempts ?? 4;
    const baseDelay = opts.baseDelayMs ?? 750;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (e) {
            const friendly = e instanceof FriendlyApiError ? e : classifyError(e);
            lastErr = friendly;
            if (!friendly.retryable || attempt === maxAttempts)
                throw friendly;
            const jitter = Math.random() * 200;
            const delay = baseDelay * Math.pow(2, attempt - 1) + jitter;
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastErr ?? new FriendlyApiError("unknown error", false);
}
export class OpenAIClient {
    config;
    client;
    constructor(config) {
        this.config = config;
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
        });
    }
    async complete(messages, tools, opts = {}) {
        const toolDefs = tools.map((t) => ({
            type: "function",
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            },
        }));
        const model = opts.model ?? resolveModel(this.config, opts.modelRole);
        const body = {
            model,
            messages: messages,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
            tool_choice: toolDefs.length > 0 ? "auto" : undefined,
        };
        if (this.config.temperature !== undefined)
            body.temperature = this.config.temperature;
        if (this.config.maxTokens !== undefined)
            body.max_completion_tokens = this.config.maxTokens;
        if (process.env.CLAW_DEBUG_REQUESTS) {
            const sample = body.messages.map((m) => ({
                role: m.role,
                content: typeof m.content === "string"
                    ? m.content.slice(0, 80)
                    : Array.isArray(m.content)
                        ? m.content.map((p) => p.type === "image_url" ? "[image]" : (p.text ?? "").slice(0, 80))
                        : null,
                tool_calls: m.tool_calls?.map((t) => t.function?.name),
            }));
            console.error("[claw-debug] messages:", JSON.stringify(sample, null, 2));
        }
        if (opts.stream) {
            return this.completeStreaming(body, opts);
        }
        const response = await withRetry(() => this.client.chat.completions.create(body, { signal: opts.abortSignal }));
        const choice = response.choices[0];
        return {
            content: choice.message.content ?? null,
            tool_calls: (choice.message.tool_calls ?? []),
            finish_reason: choice.finish_reason ?? "stop",
            usage: response.usage
                ? {
                    prompt_tokens: response.usage.prompt_tokens,
                    completion_tokens: response.usage.completion_tokens,
                    total_tokens: response.usage.total_tokens,
                    cached_tokens: response.usage.prompt_tokens_details?.cached_tokens ?? 0,
                }
                : undefined,
        };
    }
    async completeStreaming(body, opts) {
        body.stream = true;
        body.stream_options = { include_usage: true };
        const stream = await withRetry(() => this.client.chat.completions.create(body, { signal: opts.abortSignal }));
        let content = "";
        const toolCalls = new Map();
        let finishReason = "stop";
        let usage;
        try {
            for await (const chunk of stream) {
                const choice = chunk.choices?.[0];
                if (!choice) {
                    if (chunk.usage) {
                        usage = {
                            prompt_tokens: chunk.usage.prompt_tokens,
                            completion_tokens: chunk.usage.completion_tokens,
                            total_tokens: chunk.usage.total_tokens,
                            cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
                        };
                    }
                    continue;
                }
                const delta = choice.delta;
                if (delta?.content) {
                    content += delta.content;
                    opts.onDelta?.(delta.content);
                }
                if (delta?.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? 0;
                        const existing = toolCalls.get(idx) ?? {
                            id: tc.id ?? "",
                            type: "function",
                            function: { name: "", arguments: "" },
                        };
                        if (tc.id)
                            existing.id = tc.id;
                        if (tc.function?.name)
                            existing.function.name += tc.function.name;
                        if (tc.function?.arguments)
                            existing.function.arguments += tc.function.arguments;
                        toolCalls.set(idx, existing);
                    }
                }
                if (choice.finish_reason)
                    finishReason = choice.finish_reason;
            }
        }
        catch (e) {
            throw e instanceof FriendlyApiError ? e : classifyError(e);
        }
        // Validate assembled tool calls — discard malformed ones rather than letting
        // the agent reply "Tool not found" or crash on JSON.parse downstream.
        const validTools = [];
        for (const tc of toolCalls.values()) {
            if (!tc.function.name)
                continue;
            if (tc.function.arguments) {
                try {
                    JSON.parse(tc.function.arguments);
                }
                catch {
                    continue;
                }
            }
            validTools.push(tc);
        }
        return {
            content: content || null,
            tool_calls: validTools,
            finish_reason: finishReason,
            usage,
        };
    }
}
//# sourceMappingURL=client.js.map