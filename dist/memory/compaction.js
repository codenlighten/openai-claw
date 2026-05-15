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
/**
 * If the conversation is approaching the context window, summarize older turns
 * into one synthetic assistant message and keep recent turns intact.
 */
export async function compactIfNeeded(messages, config, client, force = false) {
    const tokens = estimateTokens(messages);
    const limit = Math.floor(config.contextWindow * config.compactThreshold);
    if (!force && tokens < limit)
        return null;
    // Keep system + last 8 messages; summarize the middle.
    const sys = messages[0];
    const tail = messages.slice(-8);
    const middle = messages.slice(1, -8);
    if (middle.length === 0)
        return null;
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
    const res = await client.complete(summaryReq, []);
    const summary = res.content ?? "(compaction failed)";
    return [
        sys,
        { role: "user", content: `<conversation-summary>\n${summary}\n</conversation-summary>` },
        ...tail,
    ];
}
//# sourceMappingURL=compaction.js.map