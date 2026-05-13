import readline from "node:readline";
import chalk from "chalk";
import type { Agent, AgentEvent } from "../agent.js";
import type { ClawConfig } from "../config.js";
import type { PermissionManager } from "../permissions/index.js";
import { findCommand } from "../commands/index.js";
import { HookRunner } from "../hooks/index.js";
import { prepareUserMessage } from "../input.js";
import { saveSession } from "../session.js";

export interface ReplOptions {
  agent: Agent;
  config: ClawConfig;
  permissions: PermissionManager;
}

export async function startRepl({ agent, config, permissions }: ReplOptions): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 500,
  });

  const hooks = new HookRunner(config);
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
    const input = line.trim();
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
        await cmd.run(args, { agent, config, permissions, exit });
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
      try { saveSession(config, agent.conversation); } catch {}
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
        hooks.run("PreToolUse", { tool_name: d.name, tool_input: d.input });
        break;
      }
      case "tool_result": {
        const d = evt.data as { name: string; content: string; isError?: boolean };
        const head = d.content.split("\n").slice(0, 8).join("\n");
        const tail = d.content.split("\n").length > 8 ? chalk.dim("\n  …") : "";
        const color = d.isError ? chalk.red : chalk.dim;
        process.stdout.write(color("  " + head.split("\n").join("\n  ")) + tail + "\n");
        hooks.run("PostToolUse", {
          tool_name: d.name,
          tool_output: d.content,
          is_error: d.isError ?? false,
        });
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
