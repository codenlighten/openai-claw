# openai-claw

A Claude-Code-style CLI agent powered by **OpenAI's `gpt-5-nano`** (or any chat-completions-compatible model). Built in TypeScript with the official `openai` SDK.

It mirrors most of Claude Code's surface area: tool-calling agent loop, REPL, slash commands, permission prompts, subagents, plan mode, hooks, skills, persistent memory, and context compaction.

---

## Features

- **Interactive REPL** — readline-based, streaming output, `Ctrl-C` to abort a turn
- **Core tools** — `Read`, `Write`, `Edit`, `Bash`, `Grep` (ripgrep), `Glob`, `LS`, `WebFetch`, `WebSearch`, `Task`, `TodoWrite`
- **Permission system** — `ask` / `acceptEdits` / `bypassPermissions` / `plan` modes; allowlist + denylist via `settings.json`
- **Subagents** — `Task` tool spawns an isolated agent (`general-purpose` or `explore`)
- **Plan mode** — read-only investigation, no mutations until approved
- **Hooks** — `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` shell hooks (exit 2 = block)
- **Skills** — Markdown skill files with frontmatter, invoked as `/skill-name`
- **Persistent memory** — `MEMORY.md` index + per-entry frontmatter files (user / feedback / project / reference)
- **Context compaction** — older turns are summarized when the conversation approaches the model's context window
- **Slash commands** — `/help`, `/clear`, `/model`, `/mode`, `/plan`, `/memory`, `/remember`, `/cost`, `/config`, `/init`, `/exit`
- **Shell escape** — prefix any input with `!` to run it directly in the shell
- **One-shot mode** — `claw -p "your prompt"` runs once and prints the answer

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
├── index.ts              # CLI entry
├── agent.ts              # tool-calling loop + streaming
├── client.ts             # OpenAI SDK wrapper
├── config.ts             # config loading + settings.json merging
├── subagent.ts           # Task tool runner
├── planmode.ts           # plan-mode helpers
├── prompts/system.ts     # system prompt builder
├── tools/                # Read, Write, Edit, Bash, Grep, Glob, LS, WebFetch, WebSearch, Task, TodoWrite
├── permissions/          # ask/allow/deny + interactive prompt
├── memory/               # listMemories/writeMemory + compaction.ts
├── hooks/                # shell hooks driven by settings.json
├── skills/               # SKILL.md loader
├── commands/             # /slash commands
└── ui/repl.ts            # interactive REPL
```

## Differences from Claude Code

- Powered by OpenAI's API, not Anthropic's — so no anthropic-prompt-caching, no extended thinking, no native MCP servers.
- No fancy ink-based TUI yet; plain readline + chalk.
- Web search defaults to scraping DuckDuckGo HTML (rate-limited and fragile); set `OPENAI_CLAW_SEARCH_PROVIDER=tavily` for production use.
- Permission model is simplified — allowlist patterns support `Tool` or `Bash(prefix:*)`, but not full glob semantics.

## License

MIT
