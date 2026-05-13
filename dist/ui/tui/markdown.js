import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
let configured = false;
function configure() {
    if (configured)
        return;
    marked.use(markedTerminal({ width: process.stdout.columns ?? 100 }));
    configured = true;
}
/**
 * Render markdown to ANSI-styled text. Ink's <Text> will display ANSI codes
 * directly. We trim trailing newlines so the box doesn't have a giant gap.
 */
export function renderMarkdown(md) {
    if (!md)
        return "";
    configure();
    try {
        const out = marked.parse(md);
        return out.trimEnd();
    }
    catch {
        return md;
    }
}
/**
 * Render a partial markdown stream. If the buffer contains an unmatched ``` we
 * render everything before the open fence as full markdown, and append the
 * still-open code block as raw text (no styling) so we don't fight marked over
 * unfinished syntax. This keeps prose visually polished as it streams in while
 * keeping in-progress code blocks legible.
 */
export function renderStreamingMarkdown(md) {
    if (!md)
        return "";
    const fenceMatches = md.match(/```/g) ?? [];
    if (fenceMatches.length % 2 === 0) {
        // All fences closed — safe to render as full markdown.
        return renderMarkdown(md);
    }
    const openIdx = md.lastIndexOf("```");
    const before = md.slice(0, openIdx);
    const open = md.slice(openIdx);
    return `${renderMarkdown(before)}\n${open}`;
}
//# sourceMappingURL=markdown.js.map