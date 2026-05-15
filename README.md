# openai-claw

> **An auditable AI agent CLI.** Every tool action is recorded, signed with a post-quantum (NIST FIPS-204 ML-DSA-65) key, hashed into a deterministic Merkle tree, and optionally Bitcoin-timestamped via OpenTimestamps — independently verifiable by anyone with a small standalone audit-side package (~11 kB) and standards-compliant tooling (`ots verify`). No trust required in the runtime agent, the model provider, or the operator.

A Claude-Code-style TypeScript CLI agent powered by OpenAI's `gpt-5-nano` (or any chat-completions-compatible model) — but the audit story is the actual product.

```
$ claw audit verify session.attest.json --proofs ./proofs
Claw audit verification

  Cryptography
    ✓ format                ✓ leafContinuity       ✓ merkleRoot
    ✓ ML-DSA-65 signature   ✓ sessionAlignment     ✓ anchorDigest

  Identity
    publicKeyId:   TSR2Wtuvy-3Ls1Ov
    suiteId:       ml-dsa-65
    leafCount:     6
    merkleRoot:    545fde095bf6ee9a682a602f69212d1feaf5169cc0cff9aa200e78511c3dbbdf

  OpenTimestamps proofs
    ✓ sample-session.alice.ots   v1 sha256, 237 bytes, pending
    ✓ sample-session.bob.ots     v1 sha256, 235 bytes, pending
    ✓ sample-session.finney.ots  v1 sha256, 256 bytes, pending

  Result
    ✓ Claw-side audit trail is valid
    ✓ OpenTimestamps proofs are well-formed
```

---

## Audit quickstart

The audit story is reproducible in five commands. The full reproducible demo (with committed fixtures) lives in [`examples/audit-demo`](./examples/audit-demo/). The protocol and threat model are described in the whitepaper, [No Trust in the Agent](./WHITEPAPER.md).

```bash
npm install -g @smartledger.technology/openai-claw
claw attest init                                     # one-time: generate a PQ keypair
claw -p "write a hello world script"                 # session is signed automatically
claw attest anchor <session-id>                      # submit digest to OpenTimestamps
claw attest export-ots <session-id> --out ./proofs   # standards-compliant .ots files
claw audit verify <session-id> --proofs ./proofs     # one beautiful command
```

For independent verification with no claw runtime:

```bash
npm install @smartledger.technology/openai-claw-verify   # ~11 kB
# then call verifyAttestation() against any sidecar
ots verify proofs/*.ots                              # standard Python OTS tool
```

---

## What is proven

1. **The session existed at or before a Bitcoin block time.** The sha256 of the signed attestation header is submitted to three independent OpenTimestamps calendars and becomes Bitcoin-anchored within ~3 hours.
2. **The leaves match the deterministic Merkle root.** Recomputing the root from the leaves matches the value the signature was made over.
3. **The Merkle root was signed by the local ML-DSA-65 identity.** Post-quantum (NIST FIPS-204) signature verifies under the public key embedded in the sidecar.
4. **The `.ots` files are independently parseable** by the standard OpenTimestamps tool — claw is not in the verification path.
5. **The audit-side package verifies without trusting the runtime agent.** `@smartledger.technology/openai-claw-verify` has zero dependency on claw, OpenAI, or the model.

## What is not proven

This honesty is what makes the project defensible:

1. **The AI's answer was correct.** Verification proves the agent acted as the sidecar says. It does not prove the text was true.
2. **The user intended every action the AI took.** Verification proves what happened, not what was wanted.
3. **The terminal environment was clean.** If the local machine was compromised at the time of the session, the attestor could have been fed false data — the signature would still verify.
4. **The model was honest internally.** Verification covers the I/O boundary. It says nothing about model alignment, hallucination, or intent.
5. **The Bitcoin block has confirmed yet.** Initial OTS proofs are pending. Run `ots upgrade` after ~3 hours to fetch the upgraded proof, then `ots verify`.

---

## Comparison

| Capability                 | Claude Code | OpenAI Codex-style tools | Aider | openai-claw |
| -------------------------- | :---------: | :----------------------: | :---: | :---------: |
| Agent CLI                  |     yes     |           yes            |  yes  |     yes     |
| Tool use                   |     yes     |           yes            |  yes  |     yes     |
| Persistent session log     |     yes     |        partial           |  yes  |     yes     |
| **Signed session log**     |     no      |            no            |  no   |     yes     |
| **Deterministic Merkle root** |  no      |            no            |  no   |     yes     |
| **Post-quantum signature** |     no      |            no            |  no   |     yes     |
| **OpenTimestamps export**  |     no      |            no            |  no   |     yes     |
| **Bitcoin-verifiable**     |     no      |            no            |  no   |     yes     |

> To our knowledge, this is the first npm-published AI agent CLI with signed Merkle session attestations and standards-compliant OpenTimestamps export. Please open an issue if you have a counter-example — we'd genuinely like to hear about it.

---

## Audit architecture

```
            user prompts   tool calls   tool results   assistant text
                  \           |              |               /
                   +---------- leaves ------+-+-------------+
                                  |
                                  v
                          deterministic Merkle root
                                  |
                                  v
                  ML-DSA-65 (NIST FIPS-204, post-quantum)
                                  |
                                  v
                       sha256(canonical-JSON(header))
                                  |
                  +---------------+--------------+
                  v               v              v
              alice.btc        bob.btc       finney
              calendar         calendar     calendar
                  \               |              /
                   +--- daily merge into Bitcoin ----+
                                  |
                                  v
                            Bitcoin block
                          (~3 hours later)
```

The runtime agent (claw) and the audit-side verifier (`@smartledger.technology/openai-claw-verify`) are deliberately separate packages so an auditor never installs the thing they're auditing.

| Surface | Package | Size | Job |
|---|---|---|---|
| Runtime agent | [`@smartledger.technology/openai-claw`](https://www.npmjs.com/package/@smartledger.technology/openai-claw) | ~111 kB | Run the agent, produce signed sidecars |
| Audit-side verifier | [`@smartledger.technology/openai-claw-verify`](https://www.npmjs.com/package/@smartledger.technology/openai-claw-verify) | ~11 kB | Recompute Merkle, verify signature, check anchor digest |
| Crypto primitives | [`@smartledger/crypto`](https://www.npmjs.com/package/@smartledger/crypto) | ~484 kB | ML-DSA-44/65/87, dual-stack ECDSA |
| OTS chain proof | `opentimestamps-client` (Python) | external | Pull the Bitcoin block attestation, prove inclusion |

---

## Attestation commands

```
claw attest init                          generate a fresh ML-DSA-65 keypair
claw attest status                        suite, key id, file path
claw attest pubkey                        print the base64 public key
claw attest anchor <id> [--all]           submit header digest to OTS calendars
claw attest export-ots <id> [--out=DIR]   write standards-compliant .ots files
claw verify <id> [--strict]               verify a single session by id
claw audit verify <sidecar|id> [--proofs=DIR]
                                          unified report: crypto + anchor + .ots

claw identity show                        fingerprint, suite, file path
claw identity fingerprint                 just the fingerprint
claw identity export-public               base64 public key
```

The private key lives in `~/.openai-claw/keys/attestor.json` at mode `0600`. Treat it like `~/.ssh/id_ed25519` — it is your signing identity and is not recoverable from the public key. Back it up off-machine.

Resumed sessions (`--continue`) currently skip attestation and preserve any existing sidecar; see the roadmap below.

---

## Features (other)

- **Interactive UI** — ink-based TUI by default; pass `--no-tui` for the readline REPL fallback. Streaming output, `Ctrl-C` to abort a turn.
- **Core tools** — `Read`, `Write`, `Edit`, `Bash`, `Grep` (ripgrep), `Glob`, `LS`, `WebFetch`, `WebSearch`, `Task`, `TodoWrite`, plus background-shell `BashOutput` / `KillShell`
- **Permission system** — `ask` / `acceptEdits` / `bypassPermissions` / `plan` modes; allowlist + denylist via `settings.json`. "Always" / "save" answers scope to the described key (e.g. `Bash(npm:*)`) rather than the bare tool name.
- **Subagents** — `Task` tool spawns an isolated agent. Built-in `general-purpose` / `explore` plus a frontmatter-driven registry. Optional `isolation: "worktree"` runs the subagent in a temp git worktree and returns a sanitized diff (sensitive paths like `.env`, `*.pem`, `id_rsa` are redacted).
- **Plan mode** — read-only investigation, no mutations until approved
- **Hooks** — `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PreCompact` / `SubagentStop` / `Notification` shell hooks (exit 2 = block)
- **Project trust gate** — the first time you open a repo whose `.claw/settings.json` defines hooks or MCP servers, claw prompts before honoring them and remembers your answer.
- **Skills** — Markdown skill files with frontmatter, invoked as `/skill-name`
- **Persistent memory** — `MEMORY.md` index + per-entry frontmatter files
- **Sessions** — every run is saved under `~/.openai-claw/projects/<slug>/sessions/`; `--continue`, `/sessions`, `/fork` restore or branch them
- **Context compaction** — older turns are summarized as the conversation approaches the model's context window
- **Semantic index (RAG)** — `/index` embeds the working tree with `text-embedding-3-small`; the agent can query via the `SemanticSearch` tool
- **Cost tracking** — per-turn cost is logged to `cost.log` and surfaced via `/cost` and the optional dashboard
- **MCP** — stdio and streamable-HTTP MCP clients; remote tools wrapped as `mcp__<server>__<tool>`
- **Plugins** — `claw install <git-url>` / `claw uninstall <name>` / `claw plugins [list|search]`
- **Auto-PR** — `claw pr "<task>"` runs the agent in a worktree and opens a PR
- **Dashboard** — `claw dashboard` serves a local web UI for cost, sessions, evals
- **Notifications** — desktop notifications for long-running tools and session completion
- **Self-review** — `/review` asks the agent to critique the current branch's diff
- **Evals** — `npm run eval` runs scenario-based regression tests against the agent
- **Shell escape** — prefix any input with `!` to run it directly in the shell
- **One-shot mode** — `claw -p "your prompt"` runs once and prints the answer

---

## Install

```bash
npm install -g @smartledger.technology/openai-claw
```

You'll also want `ripgrep` for the `Grep` tool:

```bash
sudo apt install ripgrep      # Debian/Ubuntu
brew install ripgrep          # macOS
```

For audit verification with the standard OTS tool:

```bash
pipx install opentimestamps-client
# or:
python3 -m venv /tmp/ots-venv && /tmp/ots-venv/bin/pip install opentimestamps-client
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
| `OPENAI_BASE_URL` | Alternative API base (Azure, vLLM, OpenRouter, …) |
| `OPENAI_CLAW_SEARCH_PROVIDER` | `duckduckgo` (default) or `tavily` |
| `TAVILY_API_KEY` | API key for Tavily web search |

Persistent settings live in `~/.openai-claw/settings.json` and (per project) `<workdir>/.claw/settings.json`. Project settings win.

## Use

Start the TUI in any project directory:

```bash
cd ~/some-project
claw
```

One-shot:

```bash
claw -p "summarize what this repo does in one paragraph"
```

If `claw attest init` has been run, every session — one-shot, REPL, or TUI — writes a signed sidecar automatically.

---

## Project layout

```
src/
├── index.ts              CLI entry (run, install, pr, dashboard, attest, verify, audit, identity)
├── agent.ts              tool-calling loop + streaming
├── client.ts             OpenAI SDK wrapper (retry, error classification)
├── config.ts             config loading + settings.json merging + file lock
├── trust.ts              per-project trust prompt for hooks/MCP
├── session.ts            save/load/list/fork sessions
├── cost.ts               model pricing + cost.log writer/reader
├── subagent.ts           Task tool runner + worktree isolation + diff redaction
├── attest/               attestation surface
│   ├── identity.ts       ML-DSA-65 keypair, on-disk mode 0600
│   ├── attestor.ts       live event collection + signing
│   ├── anchor.ts         OpenTimestamps calendar HTTP client
│   ├── ots-file.ts       spec-compliant .ots serialization
│   ├── runtime.ts        SessionAttestor — UI-agnostic wrapper
│   └── index.ts          facade re-exporting from openai-claw-verify
├── tools/                Read, Write, Edit, Bash (fg+bg), Grep, Glob, LS,
│                         WebFetch, WebSearch, Task, TodoWrite, SemanticSearch
├── permissions/          ask/allow/deny + interactive prompt
├── memory/               listMemories/writeMemory + compaction.ts
├── hooks/                shell hooks driven by settings.json
├── skills/               SKILL.md loader
├── commands/             /slash commands
├── mcp/                  stdio + streamable-HTTP MCP clients
├── rag/                  embeddings-based semantic index
├── plugins/              plugin installer + registry
├── autopr/               `claw pr` orchestrator
├── self-review/          `/review` skill
├── notifications/        desktop notifications
├── eval/                 evals harness
├── web/                  `claw dashboard` HTTP server
└── ui/                   tui/ (ink) + repl.ts (readline)

packages/openai-claw-verify/   audit-side verifier (separately published)
├── src/leaf.ts                canonical JSON, sha256
├── src/merkle.ts              deterministic binary Merkle tree
├── src/verify.ts              signature + Merkle + anchor checks
└── src/types.ts               Attestation, AnchorProof, VerifyReport
```

---

## Roadmap

| Version | Theme | Highlights |
|---|---|---|
| **0.5.0** | Auditor Experience | `claw audit verify`, `claw identity`, reproducible demo fixtures, this README |
| 0.6.0 | Automation | auto-anchor batching, anchor-on-save, retry queue, configurable calendars |
| 0.7.0 | SmartLedger Interop | GDAF envelope wrapping, ChainSimple alternate anchor, Legal Token Protocol metadata, optional BSV publication |

---

## Differences from Claude Code

- Powered by OpenAI's API, not Anthropic's — so no anthropic-prompt-caching, no extended thinking. Prompt caching is approximated via cache-friendly system prompts and tracked in cost accounting.
- Web search defaults to scraping DuckDuckGo HTML (rate-limited and fragile); set `OPENAI_CLAW_SEARCH_PROVIDER=tavily` for production use.
- Permission model is simplified — allowlist patterns support `Tool` or `Bash(prefix:*)`, but not full glob semantics.
- **Auditability is the differentiator.** Claude Code logs to disk; openai-claw signs, Merkle-hashes, and Bitcoin-anchors.

---

## Author

**Gregory J. Ward**, CTO, [SmartLedger.Technology](https://smartledger.technology)

## License

MIT — see [LICENSE](./LICENSE).
