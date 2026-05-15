# openai-claw

A Claude-Code-style CLI agent powered by **OpenAI's `gpt-5-nano`** (or any chat-completions-compatible model). Built in TypeScript with the official `openai` SDK.

It mirrors most of Claude Code's surface area: tool-calling agent loop, REPL, slash commands, permission prompts, subagents, plan mode, hooks, skills, persistent memory, and context compaction.

---

## Features

- **Interactive UI** — ink-based TUI by default; pass `--no-tui` for the readline REPL fallback. Streaming output, `Ctrl-C` to abort a turn.
- **Core tools** — `Read`, `Write`, `Edit`, `Bash`, `Grep` (ripgrep), `Glob`, `LS`, `WebFetch`, `WebSearch`, `Task`, `TodoWrite`, plus background-shell `BashOutput` / `KillShell`
- **Permission system** — `ask` / `acceptEdits` / `bypassPermissions` / `plan` modes; allowlist + denylist via `settings.json`. "Always" / "save" answers scope to the described key (e.g. `Bash(npm:*)`) rather than the bare tool name.
- **Subagents** — `Task` tool spawns an isolated agent. Built-in `general-purpose` / `explore` plus a frontmatter-driven registry under `~/.openai-claw/agents/`. Optional `isolation: "worktree"` runs the subagent in a temp git worktree and returns a sanitized diff (sensitive paths like `.env`, `*.pem`, `id_rsa` are redacted).
- **Plan mode** — read-only investigation, no mutations until approved
- **Hooks** — `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PreCompact` / `SubagentStop` / `Notification` shell hooks (exit 2 = block)
- **Project trust gate** — the first time you open a repo whose `.claw/settings.json` defines hooks or MCP servers, claw prompts before honoring them and remembers your answer in `~/.openai-claw/settings.json` under `trustedProjects`. Non-interactive runs default to deny.
- **Skills** — Markdown skill files with frontmatter, invoked as `/skill-name`
- **Persistent memory** — `MEMORY.md` index + per-entry frontmatter files (user / feedback / project / reference)
- **Sessions** — every run is saved under `~/.openai-claw/projects/<slug>/sessions/`; `--continue`, `/sessions`, `/fork` restore or branch them
- **Context compaction** — older turns are summarized when the conversation approaches the model's context window
- **Semantic index (RAG)** — `/index` embeds the working tree with `text-embedding-3-small`; the agent can query it via the `SemanticSearch` tool
- **Cost tracking** — per-turn cost is logged to `cost.log` and surfaced via `/cost` and the optional dashboard
- **MCP** — stdio and streamable-HTTP MCP clients; remote tools wrapped as `mcp__<server>__<tool>`
- **Plugins** — `claw install <git-url>` / `claw uninstall <name>` / `claw plugins [list|search]`; bundles skills, subagents, and MCP servers
- **Auto-PR** — `claw pr "<task>"` runs the agent in a worktree and opens a PR with the result
- **Dashboard** — `claw dashboard` serves a local web UI for cost, sessions, and evals
- **Notifications** — desktop notifications for long-running tools and session completion (configurable)
- **Self-review** — `/review` asks the agent to critique the current branch's diff
- **Evals** — `npm run eval` runs scenario-based regression tests against the agent
- **Slash commands** — `/help`, `/clear`, `/model`, `/mode`, `/plan`, `/memory`, `/remember`, `/cost`, `/config`, `/init`, `/exit`, `/vim`, `/sessions`, `/fork`, `/index`, `/review`, `/hooks`, …
- **Shell escape** — prefix any input with `!` to run it directly in the shell
- **One-shot mode** — `claw -p "your prompt"` runs once and prints the answer
- **Attested execution (experimental)** — opt in with `claw attest init` to generate a post-quantum (NIST FIPS-204 ML-DSA-65) keypair. Every run — one-shot (`-p`), REPL, and TUI — then writes a signed `<id>.attest.json` sidecar containing a Merkle root over the session's user prompts, assistant replies, tool calls, tool results, permission decisions, compaction events, and errors. `claw verify <id>` checks the signature, recomputes the root, and cross-references it against the session file. Powered by `@smartledger/crypto`; auditors can install the standalone `@smartledger.technology/openai-claw-verify` package (~11 kB) to verify sidecars without pulling claw itself. Resumed sessions (`--continue`) currently skip attestation and preserve the existing sidecar.
- **Bitcoin anchoring (experimental)** — `claw attest anchor <session-id>` (or `--all`) submits the attestation's header digest to public OpenTimestamps calendars (alice, bob, finney by default) in parallel. The calendars' pending proofs are saved into the sidecar's `anchor` field and become Bitcoin-confirmed within ~3 hours via the calendars' aggregation tree. `claw attest export-ots <session-id>` then writes one standards-compliant `.ots` file per calendar, ready for `ots verify` (after `ots upgrade` pulls the Bitcoin block attestation). The verifier reports anchor presence and confirms the anchored digest matches the header; full chain verification is delegated to the standard `ots` tooling.

---

## Install

```bash
git clone <this repo> openai-claw
cd openai-claw
npm install
npm run build
npm link        # makes `claw` available globally
```

You'll also want `ripgrep` installed for the `Grep` tool:

```bash
sudo apt install ripgrep      # Debian/Ubuntu
brew install ripgrep          # macOS
```

## Configure

The only required setting is your OpenAI API key:

```bash
export OPENAI_API_KEY=sk-...
```

Optional environment overrides:

| Variable | Purpose |
| -------- | ------- |
| `OPENAI_CLAW_MODEL` | Model to use (default `gpt-5-nano`) |
| `OPENAI_BASE_URL` | Alternative API base (e.g. Azure, vLLM, OpenRouter) |
| `OPENAI_CLAW_SEARCH_PROVIDER` | `duckduckgo` (default, no key) or `tavily` |
| `TAVILY_API_KEY` | API key when using Tavily for web search |

Persistent settings live in `~/.openai-claw/settings.json` and (per project) `<workdir>/.claw/settings.json`. Project settings win.

Example `settings.json`:

```json
{
  "model": "gpt-5-nano",
  "permissionMode": "acceptEdits",
  "allowedTools": ["Read", "Grep", "Glob", "LS", "Bash(npm:*)", "Bash(git:*)"],
  "deniedTools": ["Bash(rm:*)"],
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "command": "echo $(date) ran bash >> ~/.openai-claw/audit.log" }
    ]
  }
}
```

## Use

Start the REPL in any project directory:

```bash
cd ~/some-project
claw
```

```
openai-claw  v0.1.0  •  model=gpt-5-nano  •  mode=ask
workdir: /home/you/some-project
type /help for commands, /exit to quit, ! <cmd> for one-shot shell

> add a CLI flag --verbose to src/main.ts and wire it through to the logger
```

One-shot:

```bash
claw -p "summarize what this repo does in one paragraph"
```

## Project layout

```
src/
├── index.ts              # CLI entry (claw / claw install / claw pr / claw dashboard)
├── agent.ts              # tool-calling loop + streaming
├── client.ts             # OpenAI SDK wrapper (retry, error classification)
├── config.ts             # config loading + settings.json merging + file lock
├── trust.ts              # per-project trust prompt for hooks/MCP
├── session.ts            # save/load/list/fork sessions
├── cost.ts               # model pricing + cost.log writer/reader
├── subagent.ts           # Task tool runner + worktree isolation + diff redaction
├── subagents/            # frontmatter-driven subagent registry
├── planmode.ts           # plan-mode helpers
├── input.ts              # @file / image-url ingestion
├── prompts/system.ts     # system prompt builder
├── tools/                # Read, Write, Edit, Bash (fg+bg), Grep, Glob, LS,
│                         # WebFetch, WebSearch, Task, TodoWrite, SemanticSearch
├── permissions/          # ask/allow/deny + interactive prompt
├── memory/               # listMemories/writeMemory + compaction.ts
├── hooks/                # shell hooks driven by settings.json
├── skills/               # SKILL.md loader
├── commands/             # /slash commands
├── mcp/                  # stdio + streamable-HTTP MCP clients
├── rag/                  # embeddings-based semantic index
├── plugins/              # plugin installer + registry
├── autopr/               # `claw pr` orchestrator
├── self-review/          # `/review` skill
├── notifications/        # desktop notifications
├── eval/                 # evals harness
├── web/                  # `claw dashboard` HTTP server
└── ui/                   # tui/ (ink) + repl.ts (readline)
```

## Differences from Claude Code

- Powered by OpenAI's API, not Anthropic's — so no anthropic-prompt-caching, no extended thinking. Prompt caching is approximated via cache-friendly system prompts and tracked in cost accounting.
- Web search defaults to scraping DuckDuckGo HTML (rate-limited and fragile); set `OPENAI_CLAW_SEARCH_PROVIDER=tavily` for production use.
- Permission model is simplified — allowlist patterns support `Tool` or `Bash(prefix:*)`, but not full glob semantics.

## Author

**Gregory J. Ward**, CTO, [SmartLedger.Technology](https://smartledger.technology)

## License

MIT — see [LICENSE](./LICENSE).
