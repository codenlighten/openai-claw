import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

let configured = false;
function configure() {
  if (configured) return;
  marked.use(markedTerminal({ width: process.stdout.columns ?? 100 }) as any);
  configured = true;
}

/**
 * Render markdown to ANSI-styled text. Ink's <Text> will display ANSI codes
 * directly. We trim trailing newlines so the box doesn't have a giant gap.
 */
export function renderMarkdown(md: string): string {
  if (!md) return "";
  configure();
  try {
    const out = marked.parse(md) as string;
    return out.trimEnd();
  } catch {
    return md;
  }
}
