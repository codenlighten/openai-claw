const TOK_PER_CHAR = 0.25; // rough heuristic — 4 chars ≈ 1 token
export function estimateTokens(messages) {
    let n = 0;
    for (const m of messages) {
        if (typeof m.content === "string") {
            n += m.content.length;
        }
        else if (Array.isArray(m.content)) {
            for (const part of m.content) {
                if (part.type === "text")
                    n += part.text.length;
                else if (part.type === "image_url") {
                    // Rough constant for an image (varies with size; ~1.5k tokens at "auto" detail).
                    n += 6_000;
                }
            }
        }
        if (m.tool_calls)
            for (const c of m.tool_calls)
                n += (c.function.arguments?.length ?? 0) + (c.function.name?.length ?? 0);
    }
    return Math.ceil(n * TOK_PER_CHAR);
}
const KEEP_TAIL = 8;
const SUMMARY_OPEN = "<conversation-summary>";
/**
 * The task statement, pulled from the first real user message. Compaction that
 * drops it leaves the model working from a recap of the middle of the job with
 * no statement of what the job is. Re-compaction reads it back out of the
 * previous summary, since the original message is gone by then.
 */
function originalRequest(messages) {
    for (const m of messages) {
        if (m.role !== "user")
            continue;
        const text = messageText(m);
        if (!text)
            continue;
        if (text.startsWith(SUMMARY_OPEN)) {
            const carried = text.match(/^Original request: (.*)$/m);
            if (carried)
                return carried[1];
            continue;
        }
        // Collapsed to one line: it is written back as a single "Original request:"
        // line, and a multi-line request would lose everything after the first
        // newline on the next compaction's round-trip.
        return text.replace(/\s+/g, " ").trim().slice(0, 1000);
    }
    return "";
}
/** The most recent TodoWrite result — the plan the agent is working through. */
function latestTodoState(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "tool" && m.name === "TodoWrite")
            return messageText(m).slice(0, 1500);
    }
    return "";
}
function messageText(m) {
    if (typeof m.content === "string")
        return m.content;
    if (Array.isArray(m.content)) {
        return m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join(" ");
    }
    return "";
}
/**
 * Index of the first message to retain verbatim. Walks back off a `tool`
 * message so the retained window never starts in the middle of a tool group —
 * an orphaned tool response is dropped by sanitizeMessages, which silently
 * costs the model the result of work it can see itself requesting.
 */
function tailStartIndex(messages) {
    let start = Math.max(1, messages.length - KEEP_TAIL);
    while (start > 1 && messages[start]?.role === "tool")
        start--;
    return start;
}
/**
 * If the conversation is approaching the context window, summarize older turns
 * into one synthetic user message and keep recent turns intact.
 *
 * `observedTokens` is the prompt_tokens the API reported for the last request —
 * the true count. estimateTokens is a 4-chars-per-token guess that runs light
 * on code and ignores per-message overhead, so it is only the fallback for the
 * first turn (and immediately after a compaction, when the observation is
 * stale).
 */
export async function compactIfNeeded(messages, config, client, force = false, observedTokens, abortSignal) {
    const tokens = observedTokens ?? estimateTokens(messages);
    const limit = Math.floor(config.contextWindow * config.compactThreshold);
    if (!force && tokens < limit)
        return null;
    const sys = messages[0];
    const start = tailStartIndex(messages);
    const tail = messages.slice(start);
    const middle = messages.slice(1, start);
    if (middle.length === 0)
        return null;
    const request = originalRequest(messages);
    const todos = latestTodoState(messages);
    // Long tool outputs would otherwise dominate the summary input; cap each
    // message at config.maxToolResultChars so verbose results don't crowd
    // out the conversational signal compaction is meant to preserve.
    const perMsgCap = Math.max(500, config.maxToolResultChars);
    const transcript = middle
        .map((m) => {
        const tag = m.role.toUpperCase();
        let body = "";
        if (typeof m.content === "string")
            body = m.content;
        else if (Array.isArray(m.content)) {
            body = m.content
                .map((p) => (p.type === "text" ? p.text : "[image]"))
                .join(" ");
        }
        else
            body = "(tool call)";
        return `[${tag}] ${body.slice(0, perMsgCap)}`;
    })
        .join("\n\n");
    const summaryReq = [
        {
            role: "system",
            content: "You compress conversation transcripts into a dense recap so the next turn can continue without losing context. Capture: user intent, decisions made, files touched, blockers, and what's next. No conversational filler.",
        },
        { role: "user", content: `Summarize:\n\n${transcript}` },
    ];
    // Summarization is a full model call. Without the signal, Ctrl-C during a
    // compaction waits for it to finish before anything notices.
    const res = await client.complete(summaryReq, [], { abortSignal });
    const summary = res.content ?? "(compaction failed)";
    const pinned = [
        request ? `Original request: ${request}` : "",
        todos ? `Plan in progress:\n${todos}` : "",
    ]
        .filter(Boolean)
        .join("\n\n");
    const body = pinned ? `${pinned}\n\nRecap:\n${summary}` : summary;
    return [
        sys,
        { role: "user", content: `${SUMMARY_OPEN}\n${body}\n</conversation-summary>` },
        ...tail,
    ];
}
//# sourceMappingURL=compaction.js.map