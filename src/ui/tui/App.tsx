import React, { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Agent, AgentEvent } from "../../agent.js";
import type { ClawConfig } from "../../config.js";
import type { PermissionManager } from "../../permissions/index.js";
import { findCommand } from "../../commands/index.js";
import { HookRunner } from "../../hooks/index.js";
import { prepareUserMessage } from "../../input.js";
import { saveSession } from "../../session.js";
import { MessageView } from "./MessageView.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import { StatusBar } from "./StatusBar.js";
import { SlashSuggest, firstMatch } from "./SlashSuggest.js";
import type { ChatItem, PendingPermission } from "./types.js";

export interface AppProps {
  agent: Agent;
  config: ClawConfig;
  permissions: PermissionManager;
  hooks: HookRunner;
}

let idCounter = 0;
const nextId = () => `id-${++idCounter}`;

export function App({ agent, config, permissions, hooks }: AppProps) {
  const { exit } = useApp();
  const [history, setHistory] = useState<ChatItem[]>([
    { kind: "system", id: nextId(), text: `workdir: ${config.workdir}` },
    { kind: "system", id: nextId(), text: "type /help for commands, /exit to quit, Ctrl-C to abort" },
  ]);
  const [streamingItem, setStreamingItem] = useState<ChatItem | null>(null);
  const [liveTool, setLiveTool] = useState<ChatItem | null>(null);
  const liveToolRef = useRef<ChatItem | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [totalTokens, setTotalTokens] = useState(0);
  const [totalCostUSD, setTotalCostUSD] = useState(0);
  const aborterRef = useRef<AbortController | null>(null);

  // Wire the permission manager to prompt us via state.
  useEffect(() => {
    permissions.setPrompter(
      (req) =>
        new Promise((resolve) => {
          setPending({ ...req, resolve: (answer) => { setPending(null); resolve(answer); } });
        })
    );
  }, [permissions]);

  useInput((inputChar, key) => {
    if (pending) return; // PermissionPrompt owns input while open
    if (key.ctrl && inputChar === "c") {
      if (aborterRef.current) {
        aborterRef.current.abort();
        push({ kind: "error", id: nextId(), text: "aborted" });
      } else {
        exit();
      }
      return;
    }
    if (key.tab && input.startsWith("/")) {
      const match = firstMatch(input, config);
      if (match) setInput("/" + match + " ");
    }
  });

  function push(item: ChatItem) {
    setHistory((h) => [...h, item]);
  }

  async function submit(text: string) {
    setInput("");
    if (!text.trim()) return;

    if (text.startsWith("/")) {
      const [head, ...rest] = text.slice(1).split(/\s+/);
      const args = rest.join(" ");
      const cmd = findCommand(head, config);
      if (!cmd) {
        push({ kind: "error", id: nextId(), text: `unknown command: /${head}` });
        return;
      }
      // Capture console.log output from slash commands.
      const buf: string[] = [];
      const original = console.log;
      console.log = (...a: any[]) => buf.push(a.map(String).join(" "));
      try {
        await cmd.run(args, { agent, config, permissions, exit });
      } finally {
        console.log = original;
      }
      if (buf.length) push({ kind: "system", id: nextId(), text: buf.join("\n") });
      return;
    }

    if (text.startsWith("!")) {
      const cmd = text.slice(1).trim();
      const { spawnSync } = await import("node:child_process");
      const res = spawnSync("bash", ["-c", cmd], { cwd: config.workdir, encoding: "utf8" });
      push({ kind: "system", id: nextId(), text: `$ ${cmd}` });
      push({
        kind: "tool_result",
        id: nextId(),
        tool: "shell",
        content: (res.stdout ?? "") + (res.stderr ? "\n[stderr]\n" + res.stderr : ""),
        isError: res.status !== 0,
      });
      return;
    }

    const hookOutcomes = await hooks.run("UserPromptSubmit", { user_prompt: text });
    const blocked = hookOutcomes.find((h) => h.blocked);
    if (blocked) {
      push({ kind: "error", id: nextId(), text: `[blocked by hook] ${blocked.stderr.trim()}` });
      return;
    }

    const prepared = prepareUserMessage(text, config);
    const userLine = prepared.attachments.length
      ? `${text}\n  attached: ${prepared.attachments.join(", ")}`
      : text;
    push({ kind: "user", id: nextId(), text: userLine });
    agent.pushUser(prepared.content);

    setBusy(true);
    aborterRef.current = new AbortController();
    let streamBuffer = "";
    const streamId = nextId();

    const handler = (evt: AgentEvent) => {
      switch (evt.type) {
        case "text_delta":
          streamBuffer += evt.data as string;
          setStreamingItem({ kind: "assistant", id: streamId, text: streamBuffer, streaming: true });
          break;
        case "text":
          if (streamBuffer) {
            push({ kind: "assistant", id: streamId, text: streamBuffer });
            streamBuffer = "";
            setStreamingItem(null);
          } else {
            push({ kind: "assistant", id: nextId(), text: evt.data as string });
          }
          break;
        case "tool_call": {
          if (streamBuffer) {
            push({ kind: "assistant", id: streamId, text: streamBuffer });
            streamBuffer = "";
            setStreamingItem(null);
          }
          const d = evt.data as { name: string; input: any; preview?: string; callId?: string };
          const item: ChatItem = {
            kind: "tool_call",
            id: nextId(),
            tool: d.name,
            preview: d.preview ?? d.name,
            callId: d.callId,
            progress: "",
          };
          push(item);
          liveToolRef.current = item;
          setLiveTool(null);
          break;
        }
        case "tool_progress": {
          const d = evt.data as { callId: string; chunk: string };
          const live = liveToolRef.current;
          if (live && live.kind === "tool_call" && live.callId === d.callId) {
            live.progress = ((live.progress ?? "") + d.chunk).slice(-4000);
            setLiveTool({ ...live });
          }
          break;
        }
        case "tool_result": {
          const d = evt.data as { name: string; content: string; isError?: boolean; display?: string; callId?: string };
          liveToolRef.current = null;
          setLiveTool(null);
          push({
            kind: "tool_result",
            id: nextId(),
            tool: d.name,
            content: d.content,
            isError: !!d.isError,
            display: d.display,
          });
          break;
        }
        case "usage": {
          const u = evt.data as { total_tokens: number; totalCostUSD?: number };
          setTotalTokens((t) => t + u.total_tokens);
          if (typeof u.totalCostUSD === "number") setTotalCostUSD(u.totalCostUSD);
          break;
        }
        case "compaction": {
          const d = evt.data as { beforeTokens?: number; afterTokens?: number; skipped?: string };
          const text = d.skipped
            ? `▼ compaction skipped: ${d.skipped}`
            : `▼ context compacted ${d.beforeTokens}→${d.afterTokens} tokens`;
          push({ kind: "system", id: nextId(), text });
          break;
        }
        case "error":
          push({ kind: "error", id: nextId(), text: String(evt.data) });
          break;
        case "done":
          hooks.run("Stop", {});
          break;
      }
    };

    try {
      await agent.run(handler, aborterRef.current.signal);
    } catch (e: any) {
      push({ kind: "error", id: nextId(), text: e?.message ?? String(e) });
    } finally {
      if (streamBuffer) push({ kind: "assistant", id: streamId, text: streamBuffer });
      setStreamingItem(null);
      aborterRef.current = null;
      setBusy(false);
      try { saveSession(config, agent.conversation); } catch {}
    }
  }

  return (
    <Box flexDirection="column">
      <Static items={history}>{(item) => <MessageView key={item.id} item={item} />}</Static>
      {liveTool && <MessageView item={liveTool} />}
      {streamingItem && <MessageView item={streamingItem} />}
      {pending && <PermissionPrompt pending={pending} />}
      <SlashSuggest input={input} config={config} />
      <StatusBar config={config} busy={busy} totalTokens={totalTokens} totalCostUSD={totalCostUSD} />
      <Box marginTop={1}>
        <Text color="cyan" bold>{"❯ "}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={submit}
          placeholder={busy ? "(thinking… input queues)" : "ask anything or /help"}
        />
      </Box>
    </Box>
  );
}
