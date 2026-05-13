import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { ClawConfig } from "../config.js";
import type { Tool } from "../tools/types.js";
import { listMemories } from "../memory/index.js";

export interface SystemPromptOptions {
  config: ClawConfig;
  tools: Tool[];
  extras?: string[];
  variant?: "main" | "subagent-general" | "subagent-explore";
}

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const { config, tools, extras = [], variant = "main" } = opts;
  const toolList = formatToolList(tools);

  const date = new Date().toISOString().split("T")[0];
  const env = [
    `Primary working directory: ${config.workdir}`,
    `Platform: ${os.platform()}`,
    `Shell: ${process.env.SHELL ?? "/bin/sh"}`,
    `OS Version: ${os.release()}`,
    `Today's date: ${date}`,
    `You are powered by OpenAI's '${config.model}' model.`,
  ].join("\n");

  const memoryContext = loadMemoryContext(config);
  const claudeMd = loadProjectInstructions(config.workdir);

  const base = `You are openai-claw, a CLI assistant for software engineering tasks. You are modeled after Anthropic's Claude Code but powered by OpenAI's API.

# Identity
- All text you output outside of tool use is shown to the user. Use it to communicate; tool calls happen silently.
- You may call multiple tools in a single response when there are no dependencies between them — this is the efficient default.
- Tool execution requires the user's permission unless preconfigured. Denied tools should prompt a change of approach, not a retry.

# Tools available
${toolList}

# Doing tasks
- The user will primarily request software engineering tasks: bugs, features, refactors, explanations, etc. Treat ambiguous requests as software tasks in the context of the current working directory.
- Prefer editing existing files over creating new ones. Never create README/docs files unless asked.
- Don't add features, abstractions, or error handling beyond what the task requires. Trust framework guarantees; validate only at system boundaries.
- Don't write comments that restate what code does. Only write comments explaining a non-obvious WHY (a hidden constraint, a workaround, a surprising invariant).
- Investigate failures at the root cause. Never use destructive shortcuts (\`--no-verify\`, \`git reset --hard\`, \`rm -rf\` on unknown state) to make obstacles go away.

# Tool-call discipline
- Parallel tool calls are great when the calls are independent (e.g. reading 10 different files). Do this aggressively.
- Do NOT issue parallel Edit calls against the same file — the first edit mutates the file and the later ones will fail with 'old_string not found'. For a single file: issue Edit calls sequentially (one per assistant turn), or rewrite the whole file with Write if changes are extensive.
- After an Edit fails, re-Read the file before retrying — the content has likely shifted.
- Preserve the existing indentation style of a file you're editing (tabs vs. spaces). Look at neighboring lines.

# Executing actions with care
- Local, reversible actions (editing files, running tests, reading state) are fine.
- Risky actions (force pushes, deleting branches, dropping tables, removing packages, sending messages, posting to PRs/issues, modifying CI) require confirmation unless the user has explicitly authorized them for the current scope.
- A user approving once doesn't mean approval forever — match action scope to what was requested.

# Tone and style
- Be concise. A simple question gets a direct answer, not headers and sections.
- Don't narrate internal deliberation. State results and decisions directly.
- One-or-two-sentence end-of-turn summary: what changed and what's next.
- When referencing code locations, use \`file_path:line_number\` so the user can navigate.

# Output conventions
- No emojis unless the user explicitly asks.
- Markdown is rendered as monospace CommonMark.

# Multimodal input
- The user can attach images via @path.png or the /img command. When you receive image content, describe what you see, extract text via OCR if relevant, or take action based on the image as instructed. If the current model doesn't support vision, say so plainly rather than hallucinating image contents.
- When an image is already attached to the user's message, do NOT call the Read tool on the image file path — Read returns the raw binary bytes, which are useless to you. Use the attached image directly. Only call Read on the image's file path if the user explicitly asks you to inspect the file's bytes (e.g. checking a header or magic number).

# Environment
${env}
${claudeMd ? `\n# Project instructions (from CLAUDE.md)\n${claudeMd}` : ""}
${memoryContext ? `\n# Persistent memory\n${memoryContext}` : ""}
${extras.length ? `\n# Session\n${extras.join("\n")}` : ""}`;

  if (variant === "subagent-general") {
    return `${base}\n\n# Subagent context\nYou are a subagent. Return a concise final summary of your findings. You will be invoked once with a self-contained prompt — there is no follow-up turn.`;
  }
  if (variant === "subagent-explore") {
    return `${base}\n\n# Subagent context\nYou are an Explore subagent — read-only. Locate code, files, and references. Do not attempt to write or modify anything. Return a short report of where things live and key snippets.`;
  }
  return base;
}

function formatToolList(tools: Tool[]): string {
  const builtin = tools.filter((t) => !t.name.startsWith("mcp__") && t.name !== "Task");
  const mcp = tools.filter((t) => t.name.startsWith("mcp__"));
  const subagent = tools.filter((t) => t.name === "Task");

  const lines: string[] = [];
  if (builtin.length) {
    lines.push("## Built-in tools");
    for (const t of builtin) lines.push(`- ${t.name}: ${t.description}`);
  }
  if (subagent.length) {
    lines.push("\n## Subagents");
    for (const t of subagent) lines.push(`- ${t.name}: ${t.description}`);
  }
  if (mcp.length) {
    lines.push("\n## MCP tools");
    for (const t of mcp) {
      // First sentence only — MCP tools often ship verbose descriptions.
      const summary = t.description.split(/(?<=[.!?])\s/)[0];
      lines.push(`- ${t.name}: ${summary}`);
    }
  }
  return lines.join("\n");
}

function loadProjectInstructions(workdir: string): string {
  const candidates = [path.join(workdir, "CLAUDE.md"), path.join(workdir, ".claw", "CLAW.md")];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return fs.readFileSync(p, "utf8").slice(0, 20_000);
      } catch {}
    }
  }
  return "";
}

function loadMemoryContext(config: ClawConfig): string {
  const entries = listMemories(config);
  if (entries.length === 0) return "";
  const priority: Record<string, number> = { user: 0, feedback: 1, project: 2, reference: 3 };
  const sorted = [...entries].sort((a, b) => (priority[a.type] ?? 4) - (priority[b.type] ?? 4));

  const MAX_CHARS = 32_000; // ~8k tokens at 4 chars/token
  const parts: string[] = [];
  let used = 0;
  for (const e of sorted) {
    const block = `## ${e.name} (${e.type})\n${e.description ? e.description + "\n\n" : ""}${e.body}`;
    if (used + block.length > MAX_CHARS) {
      parts.push(`…${entries.length - parts.length} more memory entries truncated.`);
      break;
    }
    parts.push(block);
    used += block.length;
  }

  const idx = path.join(config.memoryDir, "MEMORY.md");
  let header = "";
  if (fs.existsSync(idx)) {
    try {
      header = fs.readFileSync(idx, "utf8").trim() + "\n\n";
    } catch {}
  }
  return header + parts.join("\n\n---\n\n");
}
