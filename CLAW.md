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
| Change how a tool's permission key is built | `describeKeys()` in `src/permissions/index.ts`. A key ending in `:*` is a REUSABLE prefix — only mint one when a single approval can safely stand for the whole class. |
| Add a slash command | Append to `builtinCommands` in `src/commands/index.ts`. |
| Add a hook event | Extend `HookEvent` union in `src/hooks/index.ts` and fire from wherever the event occurs. |
| Update model pricing | `src/cost.ts` — keep `MODEL_PRICES` current. |
| Add a system-prompt directive | `src/prompts/system.ts`. |
| Run tests | `npm test` (claw) — the verify package has its own: `npm test -w @smartledger.technology/openai-claw-verify` |
| Add an eval case | A JSON file in `test/evals/`. Shape is `EvalCase` in `src/eval/index.ts`; `test/eval.test.ts` verifies every case's `setup` runs and that its expectations reference real files. Run the suite with `npm run eval` — it makes real model calls and costs money. |
| Build | `npm run build` (builds workspaces first — the verify package is symlinked and resolved via its `dist/`, so a src-only change there is invisible to claw until rebuilt) |
| Try interactively | `npm run dev` (uses tsx) or `node dist/index.js` |

## Build / typecheck before claiming a task is done

Always run `npm run typecheck` and `npm test` before reporting completion of any change that touches `src/`. If the typecheck fails, fix it — never silence with `as any` unless interfacing with an untyped third-party module.

## Configuration files

- `.env` — `OPENAI_API_KEY`, optional `OPENAI_CLAW_MODEL`. Also loaded from `~/.openai-claw/.env`.
- `~/.openai-claw/settings.json` — user-level defaults (model, permissionMode, allowedTools/deniedTools, mcpServers, hooks, `trustedProjects`).
- `<workdir>/.claw/settings.json` — per-project overrides (same shape, wins over user-level, including `model` and `baseURL`). **Hooks and MCP servers defined here require explicit trust** — the first run prompts and persists the workdir into `trustedProjects`. Non-interactive runs, and a settings file that fails to parse, default to deny.

## Security invariants — don't regress these

- **A `:*` permission key is a reusable grant.** `describeKeys()` may only mint one for a command that cannot run a second program. Anything with a shell operator gets an exact `Bash(chain:…)` key.
- **Deny rules are checked against every command in a chain**, not just the first.
- **MCP servers get a filtered environment** (`buildServerEnv` in `src/mcp/fingerprint.ts`). Never hand a subprocess `process.env`.
- **Plugin MCP servers are not registered on install.** They land in *user* settings, which no project trust gate covers, so they need `claw plugins trust <name>`.
- **The dashboard binds 127.0.0.1.** It has no authentication.
- **`claw pr` runs in a worktree, never the user's checkout.** In-place `checkout -b` plus `git add -A` swept uncommitted work into an agent commit and pushed it. Every top-level subcommand that runs an agent must also pass the project trust gate itself — `main()`'s gate is dispatched past.
- **The verifier must not overclaim.** `mcpProvenance` is a structural check over leaf kinds; leaves carry payload hashes, so it cannot read consent values. Say so wherever it is reported.

## Agent-loop invariants

- **Every assistant `tool_call` must get a paired tool message.** Dispatch uses `Promise.allSettled` for exactly this reason, `sanitizeMessages` repairs history that drifted anyway, and `test/evals/permission-denied-recovery.json` + `parallel-reads.json` are the end-to-end regressions. A 400 saying "did not have response messages" means one of the three broke.
- **Compaction decides on `usage.prompt_tokens`,** not the char estimate; the estimate is the fallback for the first turn and immediately after a compaction. Anything that keeps a stale count around will compact on every turn.
- **Compaction pins the original request and the live todo list.** Dropping the task statement leaves the model with a recap and no goal.
- **The retained window never starts on a `tool` message** — an orphaned tool response is dropped, silently costing the model work it can see itself requesting.
- **`finish_reason === "length"` is not success.** Surface it; a truncated turn otherwise reads as a finished answer.

## What I am

A `gpt-5-nano`-powered assistant working on a project that reimplements an Anthropic-powered assistant. When the user asks for features that exist in real Claude Code, they want them reimplemented here in TypeScript — not just described.
