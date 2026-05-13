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
import { loadMcpServerSpecs } from "../mcp/index.js";
import { prepareUserMessage } from "../input.js";

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
        console.log(`${s.name}: ${s.config.command} ${(s.config.args ?? []).join(" ")}`);
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
];

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
