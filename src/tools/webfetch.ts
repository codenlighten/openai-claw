import { type Tool, ok, err } from "./types.js";

export const webFetchTool: Tool<{ url: string; prompt: string }> = {
  name: "WebFetch",
  description:
    "Fetch a URL and extract its content as markdown. The `prompt` argument is a question or instruction; the page text is included in the returned content so the calling model can answer it.",
  needsPermission: true,
  mutates: false,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Fully-qualified URL to fetch" },
      prompt: { type: "string", description: "What you're trying to learn from the page" },
    },
    required: ["url", "prompt"],
  },
  async run(input) {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return err(`Invalid URL: ${input.url}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return err(`Only http(s) URLs are supported: ${input.url}`);
    }
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": "openai-claw/0.1" },
      });
      if (!res.ok) return err(`HTTP ${res.status} ${res.statusText} for ${url}`);
      const text = await res.text();
      const stripped = htmlToText(text).slice(0, 100_000);
      return ok(
        `URL: ${url}\nPrompt: ${input.prompt}\n\n--- BEGIN CONTENT ---\n${stripped}\n--- END CONTENT ---`
      );
    } catch (e: any) {
      return err(`Fetch failed: ${e?.message ?? String(e)}`);
    }
  },
  preview: (input) => `WebFetch ${input.url}`,
};

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+\n/g, "\n\n")
    .trim();
}
