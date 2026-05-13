import { convert as htmlToTextConvert } from "html-to-text";
import { type Tool, ok, err } from "./types.js";

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { content: string; fetchedAt: number }>();

export const webFetchTool: Tool<{ url: string; prompt: string }> = {
  name: "WebFetch",
  description:
    "Fetch a URL and extract its content as plain text. The `prompt` argument is a question or instruction; the page text is included in the returned content so the calling model can answer it. Responses are cached per-URL for 15 minutes.",
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

    const key = url.toString();
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return ok(
        `URL: ${key}\nPrompt: ${input.prompt}\nCache: hit (age ${Math.round((now - cached.fetchedAt) / 1000)}s)\n\n--- BEGIN CONTENT ---\n${cached.content}\n--- END CONTENT ---`
      );
    }

    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": "openai-claw/0.1" },
      });
      if (!res.ok) return err(`HTTP ${res.status} ${res.statusText} for ${url}`);
      const text = await res.text();
      const stripped = htmlToTextConvert(text, {
        wordwrap: false,
        selectors: [
          { selector: "script", format: "skip" },
          { selector: "style", format: "skip" },
          { selector: "noscript", format: "skip" },
          { selector: "a", options: { ignoreHref: true } },
          { selector: "img", format: "skip" },
        ],
      }).slice(0, 100_000);

      cache.set(key, { content: stripped, fetchedAt: now });

      return ok(
        `URL: ${key}\nPrompt: ${input.prompt}\nCache: miss\n\n--- BEGIN CONTENT ---\n${stripped}\n--- END CONTENT ---`
      );
    } catch (e: any) {
      return err(`Fetch failed: ${e?.message ?? String(e)}`);
    }
  },
  preview: (input) => `WebFetch ${input.url}`,
};
