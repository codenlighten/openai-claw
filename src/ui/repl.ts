import readline from "node:readline";
import chalk from "chalk";
import type { Agent, AgentEvent } from "../agent.js";
import type { ClawConfig } from "../config.js";
import type { PermissionManager } from "../permissions/index.js";
import { findCommand, builtinCommands } from "../commands/index.js";
import { HookRunner } from "../hooks/index.js";
import { prepareUserMessage } from "../input.js";
import { saveSession } from "../session.js";

export interface ReplOptions {
  agent: Agent;
  config: ClawConfig;
  permissions: PermissionManager;
}

export async function startRepl({ agent, config, permissions }: ReplOptions): Promise<void> {
  const completer = (line: string): [string[], string] => {
    if (!line.startsWith("/")) return [[], line];
    const prefix = line.slice(1).split(/\s+/)[0] ?? "";
    const matches = builtinCommands
      .map((c) => `/${c.name}`)
      .filter((n) => n.slice(1).startsWith(prefix));
    return [matches, line];
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 500,
    completer,
  });

  // Multi-line input: a single trailing backslash on a line continues to the next.
  let multilineBuffer: string[] | null = null;

  const hooks = new HookRunner(config);
  const sessionRef: { current?: string } = {};
  await hooks.run("SessionStart", { workdir: config.workdir });

  banner(config);

  let aborter: AbortController | null = null;
  let exiting = false;

  const exit = () => {
    if (exiting) return;
    exiting = true;
    hooks.run("SessionEnd", {}).finally(() => {
      rl.close();
      process.exit(0);
    });
  };

  rl.on("SIGINT", () => {
    if (aborter) {
      aborter.abort();
      console.log(chalk.yellow("\n[aborted]"));
    } else {
      console.log(chalk.dim("\n(press Ctrl-C again or type /exit to quit)"));
      let next = false;
      rl.once("SIGINT", () => {
        if (!next) exit();
      });
      setTimeout(() => (next = true), 1000);
    }
  });

  const prompt = () => {
    rl.setPrompt(chalk.cyan("> "));
    rl.prompt();
  };

  prompt();

  for await (const line of rl) {
    if (exiting) break;
    // Multi-line continuation: a trailing backslash means "more lines follow".
    if (multilineBuffer || line.endsWith("\\")) {
      const trimmed = line.endsWith("\\") ? line.slice(0, -1) : line;
      if (!multilineBuffer) multilineBuffer = [];
      multilineBuffer.push(trimmed);
      if (line.endsWith("\\")) {
        rl.setPrompt(chalk.cyan("» "));
        rl.prompt();
        continue;
      }
    }
    const input = (multilineBuffer ? multilineBuffer.join("\n") : line).trim();
    multilineBuffer = null;
    if (!input) {
      prompt();
      continue;
    }

    if (input.startsWith("/")) {
      const [head, ...rest] = input.slice(1).split(/\s+/);
      const args = rest.join(" ");
      const cmd = findCommand(head, config);
      if (!cmd) {
        console.log(chalk.red(`unknown command: /${head}`));
      } else {
        await cmd.run(args, { agent, config, permissions, exit, sessionRef });
      }
      prompt();
      continue;
    }

    if (input.startsWith("!")) {
      // Shell escape (one-shot)
      const cmd = input.slice(1).trim();
      console.log(chalk.dim(`$ ${cmd}`));
      const { spawnSync } = await import("node:child_process");
      const res = spawnSync("bash", ["-c", cmd], { stdio: "inherit", cwd: config.workdir });
      if (res.status !== 0) console.log(chalk.red(`[exit ${res.status}]`));
      prompt();
      continue;
    }

    // UserPromptSubmit hooks
    const hookResults = await hooks.run("UserPromptSubmit", { user_prompt: input });
    const blocked = hookResults.find((h) => h.blocked);
    if (blocked) {
      console.log(chalk.red(`[blocked by hook] ${blocked.stderr.trim()}`));
      prompt();
      continue;
    }

    const prepared = prepareUserMessage(input, config);
    if (prepared.attachments.length) {
      console.log(chalk.dim(`  attached: ${prepared.attachments.join(", ")}`));
    }
    agent.pushUser(prepared.content);
    aborter = new AbortController();
    const handler = makeEventHandler(hooks);
    try {
      await agent.run(handler, aborter.signal);
    } catch (e: any) {
      console.log(chalk.red(`error: ${e?.message ?? String(e)}`));
    } finally {
      aborter = null;
      try {
        const { id } = saveSession(config, agent.conversation, sessionRef.current);
        sessionRef.current = id;
      } catch {}
    }
    process.stdout.write("\n");
    prompt();
  }

  exit();
}

function banner(config: ClawConfig) {
  console.log(
    chalk.bold.cyan("openai-claw") +
      chalk.dim(`  v0.1.0  •  model=${config.model}  •  mode=${config.permissionMode}`)
  );
  console.log(chalk.dim(`workdir: ${config.workdir}`));
  console.log(chalk.dim('type /help for commands, /exit to quit, ! <cmd> for one-shot shell\n'));
}

function makeEventHandler(hooks: HookRunner) {
  let textBuffered = false;
  return (evt: AgentEvent) => {
    switch (evt.type) {
      case "text_delta":
        if (!textBuffered) {
          process.stdout.write(chalk.dim("\n"));
          textBuffered = true;
        }
        process.stdout.write(evt.data as string);
        break;
      case "text":
        if (!textBuffered) process.stdout.write(evt.data as string);
        textBuffered = false;
        break;
      case "tool_call": {
        const d = evt.data as { name: string; input: any; preview?: string };
        process.stdout.write("\n" + chalk.blue(`▸ ${d.preview ?? d.name}`) + "\n");
        break;
      }
      case "tool_result": {
        const d = evt.data as { name: string; content: string; isError?: boolean };
        const head = d.content.split("\n").slice(0, 8).join("\n");
        const tail = d.content.split("\n").length > 8 ? chalk.dim("\n  …") : "";
        const color = d.isError ? chalk.red : chalk.dim;
        process.stdout.write(color("  " + head.split("\n").join("\n  ")) + tail + "\n");
        break;
      }
      case "compaction": {
        const d = evt.data as { beforeTokens?: number; afterTokens?: number; skipped?: string };
        if (d.skipped) {
          process.stdout.write("\n" + chalk.dim(`▼ compaction skipped: ${d.skipped}`) + "\n");
        } else {
          process.stdout.write(
            "\n" + chalk.dim(`▼ context compacted ${d.beforeTokens}→${d.afterTokens} tokens`) + "\n"
          );
        }
        break;
      }
      case "error":
        process.stdout.write("\n" + chalk.red(`error: ${evt.data}`) + "\n");
        break;
      case "done":
        hooks.run("Stop", {});
        break;
    }
  };
}
