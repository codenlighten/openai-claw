import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import type { Agent } from "../agent.js";
import type { ClawConfig } from "../config.js";
import { saveUserSetting } from "../config.js";
import { listMemories, writeMemory, deleteMemory } from "../memory/index.js";
import { listSkills, findSkill } from "../skills/index.js";
import { setPlanMode, planModeExtra } from "../planmode.js";
import type { PermissionManager } from "../permissions/index.js";
import { loadSession, saveSession } from "../session.js";
import { loadMcpServerSpecs, getMcpDirectory } from "../mcp/index.js";
import { prepareUserMessage } from "../input.js";
import { HookRunner } from "../hooks/index.js";
import { spawnSync } from "node:child_process";

export interface CommandContext {
  agent: Agent;
  config: ClawConfig;
  permissions: PermissionManager;
  exit: () => void;
}

export interface SlashCommand {
  name: string;
  description: string;
  run(args: string, ctx: CommandContext): Promise<void> | void;
}

export const builtinCommands: SlashCommand[] = [
  {
    name: "help",
    description: "Show available commands",
    run(_args, ctx) {
      const lines = builtinCommands.map((c) => `  /${c.name.padEnd(12)} ${c.description}`);
      const skills = listSkills(ctx.config);
      const skillLines = skills.length
        ? ["", chalk.bold("Skills:"), ...skills.map((s) => `  /${s.name.padEnd(12)} ${s.description}`)]
        : [];
      console.log(
        [chalk.bold("Slash commands:"), ...lines, ...skillLines, "", chalk.dim("Type a message to talk to openai-claw, or /exit to quit.")].join("\n")
      );
    },
  },
  {
    name: "clear",
    description: "Clear the conversation (keep system prompt)",
    run(_args, ctx) {
      ctx.agent.clear(true);
      console.log(chalk.dim("conversation cleared"));
    },
  },
  {
    name: "exit",
    description: "Quit openai-claw",
    run(_args, ctx) {
      ctx.exit();
    },
  },
  {
    name: "quit",
    description: "Quit openai-claw",
    run(_args, ctx) {
      ctx.exit();
    },
  },
  {
    name: "model",
    description: "Show or set the model (e.g. /model gpt-5-nano)",
    run(args, ctx) {
      const arg = args.trim();
      if (!arg) {
        console.log(`current model: ${ctx.config.model}`);
        return;
      }
      ctx.config.model = arg;
      saveUserSetting(ctx.config, "model", arg);
      console.log(chalk.dim(`model set to ${arg} (saved)`));
    },
  },
  {
    name: "mode",
    description: "Show or set permission mode (ask | acceptEdits | bypassPermissions | plan)",
    run(args, ctx) {
      const arg = args.trim() as ClawConfig["permissionMode"];
      if (!arg) {
        console.log(`permission mode: ${ctx.config.permissionMode}`);
        return;
      }
      if (!["ask", "acceptEdits", "bypassPermissions", "plan"].includes(arg)) {
        console.log(chalk.red(`unknown mode: ${arg}`));
        return;
      }
      ctx.permissions.setMode(arg);
      console.log(chalk.dim(`permission mode set to ${arg}`));
    },
  },
  {
    name: "plan",
    description: "Toggle plan mode",
    run(_args, ctx) {
      const enabled = ctx.config.permissionMode !== "plan";
      setPlanMode(ctx.config, enabled);
      if (enabled) {
        ctx.agent.pushUser(`<system>${planModeExtra()}</system>`);
        console.log(chalk.cyan("plan mode ON — read-only investigation, no mutations"));
      } else {
        console.log(chalk.cyan("plan mode OFF"));
      }
    },
  },
  {
    name: "cost",
    description: "Show token usage and estimated cost",
    run(_args, ctx) {
      const u = ctx.agent.usage;
      const cost = u.totalCostUSD > 0 ? ` (≈ $${u.totalCostUSD.toFixed(4)})` : " (no price table for this model)";
      console.log(`tokens: ${u.totalTokens}${cost}`);
    },
  },
  {
    name: "memory",
    description: "Manage memory: /memory list | /memory show <name> | /memory rm <name>",
    run(args, ctx) {
      const [sub, ...rest] = args.trim().split(/\s+/);
      if (!sub || sub === "list") {
        const entries = listMemories(ctx.config);
        if (entries.length === 0) {
          console.log(chalk.dim("(no memories)"));
          return;
        }
        for (const e of entries) console.log(`  ${e.name} [${e.type}] — ${e.description}`);
        return;
      }
      if (sub === "show") {
        const e = listMemories(ctx.config).find((m) => m.name === rest.join(" "));
        if (!e) return console.log(chalk.red("not found"));
        console.log(`# ${e.name} [${e.type}]\n${e.description}\n\n${e.body}`);
        return;
      }
      if (sub === "rm") {
        const ok = deleteMemory(ctx.config, rest.join(" "));
        console.log(ok ? chalk.dim("deleted") : chalk.red("not found"));
        return;
      }
      console.log(chalk.red("usage: /memory [list|show <name>|rm <name>]"));
    },
  },
  {
    name: "remember",
    description: "Save a memory: /remember <type> <name> :: <description> :: <body>",
    run(args, ctx) {
      const parts = args.split("::").map((s) => s.trim());
      if (parts.length < 3) {
        console.log(chalk.red("usage: /remember <type> <name> :: <description> :: <body>"));
        return;
      }
      const [head, description, body] = parts;
      const [type, ...nameParts] = head.split(/\s+/);
      if (!["user", "feedback", "project", "reference"].includes(type)) {
        console.log(chalk.red(`unknown type: ${type}`));
        return;
      }
      const name = nameParts.join("-").toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const file = writeMemory(ctx.config, {
        name,
        description,
        type: type as any,
        body,
      });
      console.log(chalk.dim(`saved ${file}`));
    },
  },
  {
    name: "init",
    description: "Create a CLAUDE.md / CLAW.md project instruction file",
    run(_args, ctx) {
      const file = path.join(ctx.config.workdir, "CLAW.md");
      if (fs.existsSync(file)) {
        console.log(chalk.dim(`${file} already exists`));
        return;
      }
      fs.writeFileSync(
        file,
        `# Project instructions for openai-claw\n\n_(Describe the project, conventions, and anything the assistant should know about working here.)_\n`
      );
      console.log(chalk.dim(`created ${file}`));
    },
  },
  {
    name: "img",
    description: "Attach an image to the next message: /img <path> [prompt]",
    run(args, ctx) {
      const trimmed = args.trim();
      if (!trimmed) {
        console.log(chalk.red("usage: /img <path> [prompt]"));
        return;
      }
      const [imgPath, ...promptParts] = trimmed.split(/\s+/);
      const promptText = promptParts.join(" ") || "(image attached — describe it)";
      const synth = `${promptText} @${imgPath}`;
      const prep = prepareUserMessage(synth, ctx.config);
      if (prep.attachments.length === 0) {
        console.log(chalk.red(`could not attach: ${imgPath}`));
        return;
      }
      ctx.agent.pushUser(prep.content);
      console.log(chalk.dim(`queued: ${prep.attachments.join(", ")} — send any message (or just press Enter) to dispatch`));
    },
  },
  {
    name: "last",
    description: "Print the full content of the most recent tool result",
    run(_args, ctx) {
      const msgs = ctx.agent.conversation;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === "tool") {
          console.log(`# ${m.name ?? "(tool)"}`);
          console.log(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
          return;
        }
      }
      console.log(chalk.dim("(no tool results yet)"));
    },
  },
  {
    name: "resume",
    description: "Resume the last saved session in this project",
    run(_args, ctx) {
      const data = loadSession(ctx.config);
      if (!data) {
        console.log(chalk.dim("(no saved session)"));
        return;
      }
      ctx.agent.replaceConversation(data.messages);
      console.log(
        chalk.dim(`resumed ${data.messages.length} message(s) from ${data.savedAt}`)
      );
    },
  },
  {
    name: "save",
    description: "Force-save the current session",
    run(_args, ctx) {
      const file = saveSession(ctx.config, ctx.agent.conversation);
      console.log(chalk.dim(`saved → ${file}`));
    },
  },
  {
    name: "mcp",
    description: "List configured MCP servers and their loaded tools",
    run(_args, ctx) {
      const specs = loadMcpServerSpecs(ctx.config);
      if (specs.length === 0) {
        console.log(chalk.dim("(no MCP servers configured — add `mcpServers` to settings.json)"));
        return;
      }
      for (const s of specs) {
        if (s.config.type === "http") {
          console.log(`${s.name}: http ${s.config.url}`);
        } else {
          console.log(`${s.name}: ${s.config.command} ${(s.config.args ?? []).join(" ")}`);
        }
      }
    },
  },
  {
    name: "config",
    description: "Print effective configuration",
    run(_args, ctx) {
      const { apiKey: _apiKey, ...rest } = ctx.config;
      console.log(JSON.stringify(rest, null, 2));
    },
  },
  {
    name: "compact",
    description: "Force a compaction pass on the current conversation",
    async run(_args, ctx) {
      const r = await ctx.agent.forceCompact();
      if (!r) {
        console.log(chalk.dim("(nothing to compact)"));
      } else {
        console.log(chalk.dim(`compacted ${r.before}→${r.after} tokens`));
      }
    },
  },
  {
    name: "agents",
    description: "List available subagent types",
    run() {
      console.log("  general-purpose — full tools, used for open-ended multi-step tasks");
      console.log("  explore         — read-only (Read/Grep/Glob/LS/WebFetch/WebSearch)");
    },
  },
  {
    name: "hooks",
    description: "List configured hooks",
    run(_args, ctx) {
      const hooks = new HookRunner(ctx.config);
      // HookRunner stores hooks privately; reflect via a probe by reading settings.
      const userSettings = readJsonOr(path.join(ctx.config.homeDir, "settings.json"), {});
      const projSettings = readJsonOr(path.join(ctx.config.workdir, ".claw", "settings.json"), {});
      const all = [...(userSettings.hooks ? entriesOf(userSettings.hooks) : []), ...(projSettings.hooks ? entriesOf(projSettings.hooks) : [])];
      if (all.length === 0) {
        console.log(chalk.dim("(no hooks configured — add `hooks` to settings.json)"));
        return;
      }
      for (const [event, defs] of all) {
        for (const d of defs) {
          console.log(`  [${event}] ${d.matcher ? `matcher=${d.matcher} ` : ""}${d.command}`);
        }
      }
      void hooks;
    },
  },
  {
    name: "vim",
    description: "Compose the next prompt in $EDITOR (defaults to vim)",
    run(_args, ctx) {
      const editor = process.env.EDITOR || process.env.VISUAL || "vim";
      const tmp = path.join(ctx.config.projectDir, ".claw-compose.txt");
      try {
        fs.writeFileSync(tmp, "");
        const res = spawnSync(editor, [tmp], { stdio: "inherit" });
        if (res.status !== 0) {
          console.log(chalk.red(`editor exited ${res.status}`));
          return;
        }
        const body = fs.readFileSync(tmp, "utf8").trim();
        fs.unlinkSync(tmp);
        if (!body) {
          console.log(chalk.dim("(empty — discarded)"));
          return;
        }
        ctx.agent.pushUser(body);
        console.log(chalk.dim(`queued ${body.length} chars — press Enter to send`));
      } catch (e: any) {
        console.log(chalk.red(`/vim failed: ${e?.message ?? e}`));
      }
    },
  },
  {
    name: "review",
    description: "Ask the agent to review the current branch's changes",
    run(_args, ctx) {
      ctx.agent.pushUser(
        "Review the pending changes on the current branch. Run `git diff` and `git status`, then evaluate correctness, edge cases, tests, and security. Report a concise punch list."
      );
      console.log(chalk.dim("(review prompt queued — press Enter to send)"));
    },
  },
  {
    name: "mcp-resources",
    description: "List resources exposed by connected MCP servers",
    run() {
      const dir = getMcpDirectory();
      if (dir.resources.length === 0) {
        console.log(chalk.dim("(no MCP resources)"));
        return;
      }
      for (const r of dir.resources) {
        console.log(`  [${r.server}] ${r.uri}${r.description ? ` — ${r.description}` : ""}`);
      }
    },
  },
];

function readJsonOr(p: string, fallback: any): any {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function entriesOf(hooks: any): [string, { matcher?: string; command: string }[]][] {
  return Object.entries(hooks).map(([event, defs]) => [event, Array.isArray(defs) ? defs : []]);
}

export function findCommand(name: string, config: ClawConfig): SlashCommand | undefined {
  const builtin = builtinCommands.find((c) => c.name === name);
  if (builtin) return builtin;
  const skill = findSkill(config, name);
  if (skill) {
    return {
      name: skill.name,
      description: skill.description,
      run(args, ctx) {
        ctx.agent.pushUser(
          `<skill name="${skill.name}">\n${skill.body}\n${args ? `\nArguments: ${args}` : ""}\n</skill>`
        );
        console.log(chalk.dim(`[skill loaded: ${skill.name}]`));
      },
    };
  }
  return undefined;
}
