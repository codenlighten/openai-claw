# openai-claw — project instructions

When working inside this repo, follow these conventions and shortcuts. (This file is auto-loaded by `claw` when it starts in this directory.)

## What this project is

A TypeScript reimplementation of Anthropic's Claude Code, but powered by OpenAI's chat-completions API (`gpt-5-nano` by default, configurable). Mirrors most of Claude Code's surface: agent loop, tool calls, REPL, ink TUI, permission prompts, subagents, plan mode, hooks, skills, persistent memory, session save/resume, MCP support, image input.

## Codebase layout

- `src/index.ts` — CLI entry. Loads `.env`, parses argv, wires Agent + tools + permissions + UI.
- `src/agent.ts` — Tool-calling loop. The load-bearing orchestrator. Tested in `test/agent.test.ts`.
- `src/client.ts` — OpenAI SDK wrapper. Friendly error classification + retry-with-backoff for 429/5xx.
- `src/tools/` — Built-in tools. Each is a `Tool` with name, description, JSON-schema parameters, `run()`. Image refusal lives in `read.ts`.
- `src/permissions/` — Allow/deny/ask logic with `Bash(prefix:*)` pattern matching.
- `src/ui/tui/` — ink-based React TUI (default). `App.tsx` is the root.
- `src/ui/repl.ts` — Readline fallback (`--no-tui`).
- `src/mcp/` — Stdio MCP client. Wraps remote tools as local `Tool` objects with `mcp__<server>__<tool>` names.
- `src/memory/` — Persistent memory (`MEMORY.md` index + per-entry frontmatter files) + context compaction.
- `src/skills/`, `src/hooks/`, `src/commands/` — Frontmatter-based skill loader, settings-driven shell hooks, slash command registry.

## Conventions

- **Language:** TypeScript with `"module": "ESNext"`. All imports use `.js` extensions (TS source, compiled paths).
- **No comments restating WHAT.** Only WHY-comments for non-obvious decisions.
- **Don't add framework-default error handling at internal boundaries.** Validate only at system boundaries (user input, OpenAI API, MCP transport, filesystem).
- **Prefer Edit over Write** for existing files; when bulk-rewriting, use Write.
- **Sequential Edits to the same file.** Multiple parallel Edits with overlapping `old_string` will fail after the first one mutates the file.
- **Tests use Vitest** in `test/`. Mock the OpenAI client with the `AgentClient` interface — see `test/agent.test.ts`.

## Common tasks

| Task | How |
| --- | --- |
| Add a new tool | New file in `src/tools/`, register in `src/tools/index.ts`. Set `needsPermission` and `mutates` honestly. |
| Add a slash command | Append to `builtinCommands` in `src/commands/index.ts`. |
| Add a hook event | Extend `HookEvent` union in `src/hooks/index.ts` and fire from wherever the event occurs. |
| Update model pricing | `src/cost.ts` — keep `MODEL_PRICES` current. |
| Add a system-prompt directive | `src/prompts/system.ts`. |
| Run tests | `npm test` |
| Build | `npm run build` |
| Try interactively | `npm run dev` (uses tsx) or `node dist/index.js` |

## Build / typecheck before claiming a task is done

Always run `npm run typecheck` and `npm test` before reporting completion of any change that touches `src/`. If the typecheck fails, fix it — never silence with `as any` unless interfacing with an untyped third-party module.

## Configuration files

- `.env` — `OPENAI_API_KEY`, optional `OPENAI_CLAW_MODEL`. Also loaded from `~/.openai-claw/.env`.
- `~/.openai-claw/settings.json` — user-level defaults (model, permissionMode, allowedTools/deniedTools, mcpServers, hooks).
- `<workdir>/.claw/settings.json` — per-project overrides (same shape, wins over user-level).

## What I am

A `gpt-5-nano`-powered assistant working on a project that reimplements an Anthropic-powered assistant. When the user asks for features that exist in real Claude Code, they want them reimplemented here in TypeScript — not just described.
