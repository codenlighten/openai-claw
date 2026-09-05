import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeMemory } from "../src/memory/index.js";
import { Agent, normalizeNulls, sanitizeMessages, validateToolInput, type AgentClient, type AgentEvent } from "../src/agent.js";
import { makeStrictSchema } from "../src/client.js";
import type { CompletionResult, ChatMessage } from "../src/client.js";
import type { Tool } from "../src/tools/types.js";
import type { ClawConfig } from "../src/config.js";

function cfg(overrides: Partial<ClawConfig> = {}): ClawConfig {
  return {
    workdir: "/tmp",
    homeDir: "/tmp",
    projectDir: "/tmp",
    memoryDir: "/tmp",
    model: "test",
    apiKey: "x",
    allowedTools: [],
    deniedTools: [],
    contextWindow: 1_000_000,
    compactThreshold: 1,
    permissionMode: "bypassPermissions",
    maxTurns: 50,
    maxToolResultChars: 50_000,
    models: {},
    ...overrides,
  };
}

/** Scripted client that returns a queue of pre-baked completions, one per call. */
class ScriptedClient implements AgentClient {
  public calls: ChatMessage[][] = [];
  constructor(private queue: CompletionResult[]) {}
  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    const next = this.queue.shift();
    if (!next) throw new Error("ScriptedClient: queue exhausted");
    return next;
  }
}

function textOnly(content: string): CompletionResult {
  return {
    content,
    tool_calls: [],
    finish_reason: "stop",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 0 },
  };
}

function withToolCalls(calls: { id: string; name: string; arguments: any }[]): CompletionResult {
  return {
    content: null,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
    })),
    finish_reason: "tool_calls",
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, cached_tokens: 0 },
  };
}

const dummyTool = (overrides: Partial<Tool> = {}): Tool => ({
  name: "echo",
  description: "echo",
  needsPermission: false,
  mutates: false,
  parameters: { type: "object", properties: {} },
  async run(input: any) {
    return { content: `echoed: ${JSON.stringify(input)}` };
  },
  ...overrides,
});

function collect(): { events: AgentEvent[]; handler: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, handler: (e) => events.push(e) };
}

describe("Agent.run", () => {
  it("terminates after a text-only response", async () => {
    const client = new ScriptedClient([textOnly("hello!")]);
    const agent = new Agent({
      config: cfg(),
      tools: [],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    agent.pushUser("hi");
    const { events, handler } = collect();
    await agent.run(handler);
    expect(events.map((e) => e.type)).toContain("done");
    expect(events.find((e) => e.type === "text")?.data).toBe("hello!");
    expect(client.calls.length).toBe(1);
  });

  it("executes a tool call and loops back for the final answer", async () => {
    const client = new ScriptedClient([
      withToolCalls([{ id: "c1", name: "echo", arguments: { msg: "hi" } }]),
      textOnly("got it"),
    ]);
    const agent = new Agent({
      config: cfg(),
      tools: [dummyTool()],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    agent.pushUser("do the thing");
    const { events, handler } = collect();
    await agent.run(handler);

    const types = events.map((e) => e.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types[types.length - 1]).toBe("done");
    expect(client.calls.length).toBe(2);
    // Second call should include the tool result message.
    const lastMsgs = client.calls[1];
    expect(lastMsgs.some((m) => m.role === "tool" && /echoed/.test(String(m.content)))).toBe(true);
  });

  it("runs multiple parallel tool calls in a single turn", async () => {
    const client = new ScriptedClient([
      withToolCalls([
        { id: "c1", name: "echo", arguments: { i: 1 } },
        { id: "c2", name: "echo", arguments: { i: 2 } },
        { id: "c3", name: "echo", arguments: { i: 3 } },
      ]),
      textOnly("done"),
    ]);
    const agent = new Agent({
      config: cfg(),
      tools: [dummyTool()],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    agent.pushUser("go");
    const { events, handler } = collect();
    await agent.run(handler);

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(3);
    expect(toolResults[0].data.content).toMatch(/i":1/);
    expect(toolResults[1].data.content).toMatch(/i":2/);
    expect(toolResults[2].data.content).toMatch(/i":3/);
  });

  it("converts tool errors into a tool message without crashing", async () => {
    const client = new ScriptedClient([
      withToolCalls([{ id: "c1", name: "boom", arguments: {} }]),
      textOnly("recovered"),
    ]);
    const agent = new Agent({
      config: cfg(),
      tools: [
        dummyTool({
          name: "boom",
          async run() {
            throw new Error("kaboom");
          },
        }),
      ],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    agent.pushUser("trigger error");
    const { events, handler } = collect();
    await agent.run(handler);
    const errResult = events.find(
      (e) => e.type === "tool_result" && e.data.isError === true
    );
    expect(errResult?.data.content).toMatch(/kaboom/);
    expect(events[events.length - 1].type).toBe("done");
  });

  it("returns a permission-denied message back to the model and continues", async () => {
    const client = new ScriptedClient([
      withToolCalls([{ id: "c1", name: "echo", arguments: {} }]),
      textOnly("ok then"),
    ]);
    const agent = new Agent({
      config: cfg(),
      tools: [dummyTool({ needsPermission: true })],
      permissionCheck: async () => ({ allow: false, reason: "user denied" }),
      client,
    });
    agent.pushUser("try");
    const { events, handler } = collect();
    await agent.run(handler);
    const tr = events.find((e) => e.type === "tool_result");
    expect(tr?.data.isError).toBe(true);
    expect(tr?.data.content).toMatch(/Permission denied/i);
  });

  it("aborts mid-loop when the signal fires", async () => {
    const client = new ScriptedClient([
      withToolCalls([{ id: "c1", name: "echo", arguments: {} }]),
      textOnly("never reached"),
    ]);
    const aborter = new AbortController();
    const agent = new Agent({
      config: cfg(),
      tools: [
        dummyTool({
          async run() {
            aborter.abort();
            return { content: "done before abort took effect" };
          },
        }),
      ],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    agent.pushUser("go");
    const { events, handler } = collect();
    await agent.run(handler, aborter.signal);
    const errEvent = events.find((e) => e.type === "error");
    expect(errEvent?.data).toBe("aborted");
  });

  it("returns helpful message when model calls an unknown tool", async () => {
    const client = new ScriptedClient([
      withToolCalls([{ id: "c1", name: "ghost-tool", arguments: {} }]),
      textOnly("oh well"),
    ]);
    const agent = new Agent({
      config: cfg(),
      tools: [dummyTool()],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    agent.pushUser("call ghost");
    const { events, handler } = collect();
    await agent.run(handler);
    const tr = events.find((e) => e.type === "tool_result");
    expect(tr?.data.isError).toBe(true);
    expect(tr?.data.content).toMatch(/Tool not found/);
  });

  it("tracks running cost from usage events", async () => {
    const client = new ScriptedClient([textOnly("hi")]);
    const agent = new Agent({
      config: { ...cfg(), model: "gpt-5-nano" },
      tools: [],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    agent.pushUser("hi");
    const { handler } = collect();
    await agent.run(handler);
    // 10 prompt + 5 completion → cost ~= (10/1e6)*0.05 + (5/1e6)*0.40 = 5e-7 + 2e-6 = 2.5e-6
    expect(agent.usage.totalTokens).toBe(15);
    expect(agent.usage.totalCostUSD).toBeGreaterThan(0);
    expect(agent.usage.totalCostUSD).toBeLessThan(0.001);
  });

  it("routes the next turn through the requested model role", async () => {
    const seen: (string | undefined)[] = [];
    const client: AgentClient = {
      async complete(_msgs, _tools, opts) {
        seen.push(opts?.modelRole);
        return textOnly("ok");
      },
    };
    const agent = new Agent({
      config: cfg({ model: "x", models: { default: "x", reasoning: "y" } }),
      tools: [],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    agent.setNextRole("reasoning");
    agent.pushUser("hard one");
    const { handler } = collect();
    await agent.run(handler);
    agent.pushUser("ordinary");
    await agent.run(handler);
    expect(seen).toEqual(["reasoning", "default"]);
  });

  it("tracks cached-token hit rate across turns", async () => {
    const turn1 = {
      content: "first",
      tool_calls: [],
      finish_reason: "stop",
      usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, cached_tokens: 0 },
    };
    const turn2 = {
      content: "second",
      tool_calls: [],
      finish_reason: "stop",
      usage: { prompt_tokens: 1100, completion_tokens: 10, total_tokens: 1110, cached_tokens: 900 },
    };
    const client = new ScriptedClient([turn1, turn2]);
    const agent = new Agent({
      config: cfg(),
      tools: [],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    agent.pushUser("a");
    const { handler } = collect();
    await agent.run(handler);
    agent.pushUser("b");
    await agent.run(handler);
    expect(agent.usage.totalCachedTokens).toBe(900);
    expect(agent.usage.cacheHitRate).toBeCloseTo(900 / 2100, 2);
  });

  it("preserves tool-call order when running tools in parallel", async () => {
    const order: number[] = [];
    const slowTool: Tool = dummyTool({
      name: "slow",
      async run(input: any) {
        // Larger i resolves first to prove ordering isn't accidental.
        await new Promise((r) => setTimeout(r, Math.max(0, 30 - input.i * 10)));
        order.push(input.i);
        return { content: `i=${input.i}` };
      },
    });
    const client = new ScriptedClient([
      withToolCalls([
        { id: "a", name: "slow", arguments: { i: 1 } },
        { id: "b", name: "slow", arguments: { i: 2 } },
        { id: "c", name: "slow", arguments: { i: 3 } },
      ]),
      textOnly("done"),
    ]);
    const agent = new Agent({
      config: cfg(),
      tools: [slowTool],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    agent.pushUser("go");
    const { handler } = collect();
    await agent.run(handler);

    // Tools ran concurrently (resolved in reverse-ish order)…
    expect(order).not.toEqual([1, 2, 3]);
    // …but tool messages were appended in the call order.
    const toolMsgs = client.calls[1].filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.content)).toEqual(["i=1", "i=2", "i=3"]);
  });

  it("stops after maxTurns and emits an error", async () => {
    // 4 turns of tool calls; maxTurns=3 should cut it short.
    const client = new ScriptedClient([
      withToolCalls([{ id: "1", name: "echo", arguments: {} }]),
      withToolCalls([{ id: "2", name: "echo", arguments: {} }]),
      withToolCalls([{ id: "3", name: "echo", arguments: {} }]),
      withToolCalls([{ id: "4", name: "echo", arguments: {} }]),
    ]);
    const agent = new Agent({
      config: cfg({ maxTurns: 3 }),
      tools: [dummyTool()],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    agent.pushUser("loop");
    const { events, handler } = collect();
    await agent.run(handler);
    const errEvent = events.find((e) => e.type === "error");
    expect(errEvent?.data).toMatch(/max turns reached/);
    expect(client.calls.length).toBeLessThanOrEqual(3);
  });

  it("truncates oversized tool results sent back to the model", async () => {
    const huge = "x".repeat(200);
    const client = new ScriptedClient([
      withToolCalls([{ id: "c1", name: "huge", arguments: {} }]),
      textOnly("ok"),
    ]);
    const agent = new Agent({
      config: cfg({ maxToolResultChars: 100 }),
      tools: [dummyTool({ name: "huge", async run() { return { content: huge }; } })],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    agent.pushUser("trigger");
    const { handler } = collect();
    await agent.run(handler);
    const toolMsg = client.calls[1].find((m) => m.role === "tool");
    expect(String(toolMsg?.content).length).toBeLessThan(huge.length);
    expect(String(toolMsg?.content)).toMatch(/truncated/);
  });

  it("fires PreCompact hook and emits a compaction event", async () => {
    const calls: string[] = [];
    // First completion services compactIfNeeded's summary call; second is the real turn.
    const client = new ScriptedClient([textOnly("SUMMARY"), textOnly("hello")]);
    const agent = new Agent({
      config: cfg({ contextWindow: 10, compactThreshold: 0.01 }),
      tools: [],
      permissionCheck: async () => ({ allow: true }),
      client,
      runHook: async (event) => {
        calls.push(event);
        return [];
      },
    });
    for (let i = 0; i < 10; i++) {
      agent.pushUser("filler ".repeat(50));
    }
    const { events, handler } = collect();
    await agent.run(handler);
    expect(calls).toContain("PreCompact");
    expect(events.some((e) => e.type === "compaction")).toBe(true);
  });

  it("replaceConversation preserves the system message", () => {
    const client = new ScriptedClient([]);
    const agent = new Agent({
      config: cfg(),
      tools: [],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    const origSys = agent.conversation[0];
    agent.replaceConversation([
      { role: "system", content: "different system" },
      { role: "user", content: "old msg" },
    ]);
    expect(agent.conversation[0]).toBe(origSys);
    expect(agent.conversation[1].content).toBe("old msg");
  });

  it("validates required fields and short-circuits the bad call", async () => {
    // The model used to crash inside tool internals when a required field was
    // missing (e.g. path.resolve(undefined)). Now the dispatch layer rejects
    // the call up front with a directive message.
    const client = new ScriptedClient([
      withToolCalls([{ id: "c1", name: "needsFile", arguments: {} }]),
      textOnly("ok"),
    ]);
    let runCalled = false;
    const tool: Tool = {
      name: "needsFile",
      description: "needs a file_path",
      needsPermission: false,
      mutates: false,
      parameters: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
      },
      async run() {
        runCalled = true;
        return { content: "ran" };
      },
    };
    const agent = new Agent({
      config: cfg(),
      tools: [tool],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    agent.pushUser("go");
    const { events, handler } = collect();
    await agent.run(handler);
    expect(runCalled).toBe(false);
    const err = events.find((e) => e.type === "tool_result" && e.data.isError === true);
    expect(err?.data.content).toMatch(/missing required field/);
  });

  it("normalizes null values from strict-mode optional fields to undefined", async () => {
    // Strict mode forces the model to emit nulls for omitted optional fields.
    // Tools were written against the non-strict shape, so the dispatch layer
    // collapses nulls back to undefined before calling run().
    const client = new ScriptedClient([
      withToolCalls([
        { id: "c1", name: "opt", arguments: { needed: "x", optional: null } },
      ]),
      textOnly("done"),
    ]);
    let seenInput: any = null;
    const tool: Tool = {
      name: "opt",
      description: "has an optional field",
      needsPermission: false,
      mutates: false,
      parameters: {
        type: "object",
        properties: {
          needed: { type: "string" },
          optional: { type: ["string", "null"] },
        },
        required: ["needed", "optional"],
      },
      async run(input) {
        seenInput = input;
        return { content: "ok" };
      },
    };
    const agent = new Agent({
      config: cfg(),
      tools: [tool],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    agent.pushUser("go");
    const { events, handler } = collect();
    await agent.run(handler);
    expect(seenInput).toEqual({ needed: "x", optional: undefined });
  });
});

describe("normalizeNulls", () => {
  it("replaces null with undefined recursively but leaves other values alone", () => {
    const input = { a: null, b: "ok", c: { d: null, e: 1 }, f: [null, "x", { g: null }] };
    normalizeNulls(input);
    expect(input).toEqual({ a: undefined, b: "ok", c: { d: undefined, e: 1 }, f: [undefined, "x", { g: undefined }] });
  });

  it("returns scalars and nulls unchanged when passed at the top level", () => {
    expect(normalizeNulls(null)).toBe(null);
    expect(normalizeNulls(undefined)).toBe(undefined);
    expect(normalizeNulls(5)).toBe(5);
    expect(normalizeNulls("x")).toBe("x");
  });
});

describe("validateToolInput", () => {
  const schema = {
    properties: {
      file_path: { type: "string" },
      offset: { type: "number" },
    },
    required: ["file_path"],
  };

  it("returns null when required fields are present and non-empty", () => {
    expect(validateToolInput({ file_path: "/x" }, schema)).toBeNull();
    expect(validateToolInput({ file_path: "/x", offset: 10 }, schema)).toBeNull();
  });

  it("flags missing required fields with a directive message", () => {
    const msg = validateToolInput({}, schema);
    expect(msg).toMatch(/missing required field/);
    expect(msg).toMatch(/file_path/);
  });

  it("flags empty required strings", () => {
    const msg = validateToolInput({ file_path: "" }, schema);
    expect(msg).toMatch(/must not be empty/);
    expect(msg).toMatch(/file_path/);
  });
});

describe("makeStrictSchema", () => {
  it("adds every property to required and marks optional ones nullable", () => {
    const result = makeStrictSchema({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "number" },
      },
      required: ["a"],
    });
    expect(result.required).toEqual(["a", "b"]);
    expect(result.additionalProperties).toBe(false);
    expect(result.properties.a.type).toBe("string");
    expect(result.properties.b.type).toEqual(["number", "null"]);
  });

  it("recurses into nested objects and array items", () => {
    const result = makeStrictSchema({
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              activeForm: { type: "string" },
            },
            required: ["content"],
          },
        },
      },
      required: ["todos"],
    });
    expect(result.properties.todos.type).toBe("array");
    expect(result.properties.todos.items.required).toEqual(["content", "activeForm"]);
    expect(result.properties.todos.items.additionalProperties).toBe(false);
    expect(result.properties.todos.items.properties.activeForm.type).toEqual(["string", "null"]);
  });

  it("adds null to enums when the field becomes nullable", () => {
    const result = makeStrictSchema({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["a", "b"] },
      },
      required: [],
    });
    expect(result.properties.mode.type).toEqual(["string", "null"]);
    expect(result.properties.mode.enum).toEqual(["a", "b", null]);
  });
});

describe("sanitizeMessages", () => {
  function asst(tool_calls: { id: string; name: string }[]): ChatMessage {
    return {
      role: "assistant",
      content: null,
      tool_calls: tool_calls.map((t) => ({
        id: t.id,
        type: "function",
        function: { name: t.name, arguments: "{}" },
      })),
    } as ChatMessage;
  }
  function toolMsg(id: string, content = "ok"): ChatMessage {
    return { role: "tool", tool_call_id: id, content } as ChatMessage;
  }

  it("passes a well-formed conversation through unchanged", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "you are a bot" },
      { role: "user", content: "hi" },
      asst([{ id: "c1", name: "Bash" }]),
      toolMsg("c1", "result"),
      { role: "assistant", content: "done" },
    ];
    const before = JSON.stringify(msgs);
    const { injected, dropped, reordered } = sanitizeMessages(msgs);
    expect(injected).toBe(0);
    expect(dropped).toBe(0);
    expect(reordered).toBe(0);
    expect(JSON.stringify(msgs)).toBe(before);
  });

  it("injects a placeholder for an orphaned tool_call_id", () => {
    // assistant has tool_calls but the next message is a user turn — no tool response.
    const msgs: ChatMessage[] = [
      asst([{ id: "c-leak", name: "Bash" }]),
      { role: "user", content: "continue" },
    ];
    const { injected, dropped } = sanitizeMessages(msgs);
    expect(injected).toBe(1);
    expect(dropped).toBe(0);
    expect(msgs).toHaveLength(3);
    expect(msgs[1].role).toBe("tool");
    expect((msgs[1] as any).tool_call_id).toBe("c-leak");
    expect(msgs[2].role).toBe("user");
  });

  it("injects placeholders only for missing ids in a partially-responded multi-call", () => {
    const msgs: ChatMessage[] = [
      asst([
        { id: "c1", name: "Read" },
        { id: "c2", name: "Read" },
        { id: "c3", name: "Read" },
      ]),
      toolMsg("c1"),
      toolMsg("c3"),
      { role: "user", content: "what now" },
    ];
    const { injected, dropped } = sanitizeMessages(msgs);
    expect(injected).toBe(1);
    expect(dropped).toBe(0);
    // Canonical order: c1, c2 (placeholder), c3 — each in declaration order.
    const toolIds = msgs.filter((m) => m.role === "tool").map((m) => (m as any).tool_call_id);
    expect(toolIds).toEqual(["c1", "c2", "c3"]);
  });

  it("drops tool messages whose tool_call_id has no matching assistant", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "hi" },
      toolMsg("ghost"),
      { role: "assistant", content: "hello" },
    ];
    const { injected, dropped } = sanitizeMessages(msgs);
    expect(injected).toBe(0);
    expect(dropped).toBe(1);
    expect(msgs).toHaveLength(2);
    expect(msgs.some((m) => m.role === "tool")).toBe(false);
  });

  it("repairs back-to-back assistants with separated tool responses (the prod corruption)", () => {
    // Exact saved-session shape: two assistant tool_calls in a row, then both
    // responses. OpenAI rejects this because each tool's "previous message"
    // doesn't include its tool_call_id. Sanitize must reorder.
    const msgs: ChatMessage[] = [
      asst([{ id: "call_8CurbYA6gtHx4RuiJFB6CXUG", name: "Bash" }]),
      asst([{ id: "call_yRVKzo34WlaTO6YmghjlHNb6", name: "Bash" }]),
      toolMsg("call_8CurbYA6gtHx4RuiJFB6CXUG", "DONE"),
      toolMsg("call_yRVKzo34WlaTO6YmghjlHNb6", "Reinitialized…"),
      { role: "user", content: "continue" },
    ];
    const { injected, dropped, reordered } = sanitizeMessages(msgs);
    expect(injected).toBe(0);
    expect(dropped).toBe(0);
    expect(reordered).toBeGreaterThan(0);
    expect(msgs).toHaveLength(5);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[1].role).toBe("tool");
    expect((msgs[1] as any).tool_call_id).toBe("call_8CurbYA6gtHx4RuiJFB6CXUG");
    expect(msgs[2].role).toBe("assistant");
    expect(msgs[3].role).toBe("tool");
    expect((msgs[3] as any).tool_call_id).toBe("call_yRVKzo34WlaTO6YmghjlHNb6");
    expect(msgs[4].role).toBe("user");
  });

  it("handles orphan asst with no response anywhere (worst case)", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      asst([{ id: "call_orphan", name: "Bash" }]),
      { role: "user", content: "continue" },
    ];
    const { injected } = sanitizeMessages(msgs);
    expect(injected).toBe(1);
    expect(msgs[2].role).toBe("tool");
    expect(String(msgs[2].content)).toMatch(/no response captured/);
  });
});

describe("dispatch resilience (hooks must not orphan tool_call_ids)", () => {
  it("paired tool message is pushed even when PostToolUse hook throws", async () => {
    const client = new ScriptedClient([
      withToolCalls([{ id: "c-hook", name: "echo", arguments: { msg: "hi" } }]),
      textOnly("done"),
    ]);
    const agent = new Agent({
      config: cfg(),
      tools: [dummyTool()],
      permissionCheck: async () => ({ allow: true }),
      client,
      runHook: async (event) => {
        if (event === "PostToolUse") throw new Error("hook crashed");
        return [];
      },
    });
    agent.pushUser("go");
    const { events, handler } = collect();
    await agent.run(handler);

    // The conversation must contain a tool message for c-hook — otherwise the
    // next API call would 400 with the exact bug from the user report.
    const toolMsgs = agent.conversation.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
    expect((toolMsgs[0] as any).tool_call_id).toBe("c-hook");
    expect(events[events.length - 1].type).toBe("done");
  });

  it("paired tool message is pushed even when permissionCheck throws", async () => {
    const client = new ScriptedClient([
      withToolCalls([{ id: "c-perm", name: "echo", arguments: {} }]),
      textOnly("ok then"),
    ]);
    const agent = new Agent({
      config: cfg(),
      tools: [dummyTool({ needsPermission: true })],
      permissionCheck: async () => {
        throw new Error("user aborted prompt");
      },
      client,
    });
    agent.pushUser("try");
    const { events, handler } = collect();
    await agent.run(handler);
    const toolMsgs = agent.conversation.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
    expect((toolMsgs[0] as any).tool_call_id).toBe("c-perm");
    expect(String(toolMsgs[0].content)).toMatch(/Permission denied/);
  });
});

describe("truncated completions", () => {
  it("warns when the model hits the output token limit", async () => {
    const truncated: CompletionResult = {
      content: "here is the first half of the answ",
      tool_calls: [],
      finish_reason: "length",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 0 },
    };
    const agent = new Agent({
      config: cfg({ maxTokens: 64 }),
      tools: [],
      permissionCheck: async () => ({ allow: true }),
      client: new ScriptedClient([truncated]),
    });
    agent.pushUser("write something long");
    const { events, handler } = collect();
    await agent.run(handler);
    const warning = events.find((e) => e.type === "warning");
    expect(warning).toBeTruthy();
    expect(String(warning!.data)).toContain("cut off");
    expect(String(warning!.data)).toContain("64");
  });

  it("reports the finish reason on the done event", async () => {
    const agent = new Agent({
      config: cfg(),
      tools: [],
      permissionCheck: async () => ({ allow: true }),
      client: new ScriptedClient([textOnly("all done")]),
    });
    agent.pushUser("hi");
    const { events, handler } = collect();
    await agent.run(handler);
    expect(events.find((e) => e.type === "warning")).toBeUndefined();
    expect(events.find((e) => e.type === "done")?.data).toEqual({ finishReason: "stop" });
  });
});

describe("model role", () => {
  it("a standing role applies to every turn of a run", async () => {
    // A subagent declared `modelRole: reasoning` used to get the reasoning model
    // for its first API call only, then silently drop back to the default.
    const seen: (string | undefined)[] = [];
    const client: AgentClient = {
      async complete(_msgs, _tools, opts) {
        seen.push(opts?.modelRole);
        return seen.length < 3
          ? withToolCalls([{ id: `c${seen.length}`, name: "echo", arguments: {} }])
          : textOnly("done");
      },
    };
    const agent = new Agent({
      config: cfg({ models: { default: "x", reasoning: "y" } }),
      tools: [dummyTool()],
      permissionCheck: async () => ({ allow: true }),
      client,
      modelRole: "reasoning",
    });
    agent.pushUser("think hard");
    const { handler } = collect();
    await agent.run(handler);
    expect(seen).toEqual(["reasoning", "reasoning", "reasoning"]);
  });

  it("a one-shot override wins for one turn, then the standing role resumes", async () => {
    const seen: (string | undefined)[] = [];
    const client: AgentClient = {
      async complete(_msgs, _tools, opts) {
        seen.push(opts?.modelRole);
        return textOnly("ok");
      },
    };
    const agent = new Agent({
      config: cfg({ models: { default: "x", cheap: "z", reasoning: "y" } }),
      tools: [],
      permissionCheck: async () => ({ allow: true }),
      client,
      modelRole: "cheap",
    });
    agent.setNextRole("reasoning");
    agent.pushUser("a");
    const { handler } = collect();
    await agent.run(handler);
    agent.pushUser("b");
    await agent.run(handler);
    expect(seen).toEqual(["reasoning", "cheap"]);
  });
});

describe("compaction inputs", () => {
  const bigTurn = (promptTokens: number): CompletionResult => ({
    content: "ok",
    tool_calls: [],
    finish_reason: "stop",
    usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5, cached_tokens: 0 },
  });

  /** A history long enough that compaction has a middle to summarize. */
  const history = (): ChatMessage[] =>
    Array.from({ length: 14 }, (_, i) =>
      i % 2 === 0
        ? ({ role: "user", content: `turn ${i}` } as ChatMessage)
        : ({ role: "assistant", content: `reply ${i}` } as ChatMessage)
    );

  it("compacts on the API's reported prompt_tokens, not the char estimate", async () => {
    // Short messages: the 4-chars-per-token estimate is nowhere near the limit,
    // but the API says the real prompt was 3000 tokens against a 4000 window.
    const client = new ScriptedClient([bigTurn(3000), textOnly("SUMMARY"), textOnly("second")]);
    const agent = new Agent({
      config: cfg({ contextWindow: 4000, compactThreshold: 0.5 }),
      tools: [],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    agent.replaceConversation(history());
    agent.pushUser("a");
    const { events, handler } = collect();
    await agent.run(handler);
    expect(events.find((e) => e.type === "compaction")).toBeUndefined();
    agent.pushUser("b");
    await agent.run(handler);
    const compaction = events.find((e) => e.type === "compaction");
    expect(compaction).toBeTruthy();
    expect(compaction!.data.beforeTokens).toBe(3000);
  });

  it("does not reuse a stale token count after compacting", async () => {
    const client = new ScriptedClient([bigTurn(3000), textOnly("SUMMARY"), textOnly("x"), textOnly("y")]);
    const agent = new Agent({
      config: cfg({ contextWindow: 4000, compactThreshold: 0.5 }),
      tools: [],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    agent.replaceConversation(history());
    agent.pushUser("a");
    const { events, handler } = collect();
    await agent.run(handler);
    agent.pushUser("b");
    await agent.run(handler);
    agent.pushUser("c");
    await agent.run(handler);
    // Exactly one compaction: the 3000 was consumed, not re-applied every turn.
    expect(events.filter((e) => e.type === "compaction")).toHaveLength(1);
  });

  it("keeps the original request and the live todo list through a compaction", async () => {
    const client = new ScriptedClient([bigTurn(3000), textOnly("SUMMARY"), textOnly("next")]);
    const agent = new Agent({
      config: cfg({ contextWindow: 4000, compactThreshold: 0.5 }),
      tools: [],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    // Both the request and the todo list sit in the region that gets
    // summarized away, so only pinning can carry them forward.
    agent.replaceConversation([
      { role: "user", content: "migrate the billing module to the new API" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "TodoWrite", arguments: "{}" } }],
      } as ChatMessage,
      {
        role: "tool",
        tool_call_id: "t1",
        name: "TodoWrite",
        content: "Todos updated:\n[x] 1. read the old client\n[~] 2. port the calls",
      } as ChatMessage,
      ...history(),
    ]);
    agent.pushUser("a");
    const { handler } = collect();
    await agent.run(handler);
    agent.pushUser("b");
    await agent.run(handler);
    const summary = agent.conversation.find(
      (m) => typeof m.content === "string" && m.content.startsWith("<conversation-summary>")
    );
    expect(String(summary?.content)).toContain("migrate the billing module");
    expect(String(summary?.content)).toContain("port the calls");
  });

  it("does not start the retained window inside a tool group", async () => {
    const client = new ScriptedClient([bigTurn(3000), textOnly("SUMMARY"), textOnly("next")]);
    const agent = new Agent({
      config: cfg({ contextWindow: 4000, compactThreshold: 0.5 }),
      tools: [],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    const withToolGroup: ChatMessage[] = [
      ...history(),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "a1", type: "function", function: { name: "echo", arguments: "{}" } },
          { id: "a2", type: "function", function: { name: "echo", arguments: "{}" } },
        ],
      } as ChatMessage,
      { role: "tool", tool_call_id: "a1", name: "echo", content: "first result" } as ChatMessage,
      { role: "tool", tool_call_id: "a2", name: "echo", content: "second result" } as ChatMessage,
    ];
    agent.replaceConversation(withToolGroup);
    agent.pushUser("a");
    const { handler } = collect();
    await agent.run(handler);
    agent.pushUser("b");
    await agent.run(handler);
    // Both results survive: a window starting mid-group would orphan them and
    // sanitizeMessages would then drop them entirely.
    const kept = agent.conversation.filter((m) => m.role === "tool").map((m) => m.content);
    expect(kept).toContain("first result");
    expect(kept).toContain("second result");
  });
});

describe("system prompt lifecycle", () => {
  it("refreshSystemPrompt picks up memory written mid-session", async () => {
    const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-sysprompt-"));
    try {
      const config = cfg({ memoryDir: memDir });
      const agent = new Agent({
        config,
        tools: [],
        permissionCheck: async () => ({ allow: true }),
        client: new ScriptedClient([textOnly("ok")]),
      });
      const before = String(agent.conversation[0].content);
      expect(before).not.toContain("prefers-tabs-over-spaces");

      writeMemory(config, {
        name: "prefers-tabs-over-spaces",
        description: "indentation preference",
        type: "feedback",
        body: "Use tabs.",
      });
      // Nothing changes until the prompt is rebuilt — that was the bug.
      expect(String(agent.conversation[0].content)).toBe(before);

      agent.refreshSystemPrompt();
      expect(String(agent.conversation[0].content)).toContain("prefers-tabs-over-spaces");
      expect(agent.conversation[0].role).toBe("system");
      expect(agent.conversation).toHaveLength(1);
    } finally {
      fs.rmSync(memDir, { recursive: true, force: true });
    }
  });

  it("keeps the subagent variant when the prompt is rebuilt", () => {
    const agent = new Agent({
      config: cfg(),
      tools: [],
      permissionCheck: async () => ({ allow: true }),
      systemPromptVariant: "subagent-explore",
      client: new ScriptedClient([]),
    });
    expect(String(agent.conversation[0].content)).toContain("read-only");
    agent.refreshSystemPrompt();
    expect(String(agent.conversation[0].content)).toContain("read-only");
  });
});

describe("compaction carries the task statement forward", () => {
  it("survives a second compaction, including a multi-line request", async () => {
    const bigTurn = (n: number): CompletionResult => ({
      content: "ok",
      tool_calls: [],
      finish_reason: "stop",
      usage: { prompt_tokens: n, completion_tokens: 5, total_tokens: n + 5, cached_tokens: 0 },
    });
    const filler = (): ChatMessage[] =>
      Array.from({ length: 14 }, (_, i) =>
        i % 2 === 0
          ? ({ role: "user", content: `turn ${i}` } as ChatMessage)
          : ({ role: "assistant", content: `reply ${i}` } as ChatMessage)
      );
    const client = new ScriptedClient([
      bigTurn(3000),
      textOnly("SUMMARY ONE"),
      bigTurn(3000),
      textOnly("SUMMARY TWO"),
      textOnly("final"),
    ]);
    const agent = new Agent({
      config: cfg({ contextWindow: 4000, compactThreshold: 0.5 }),
      tools: [],
      permissionCheck: async () => ({ allow: true }),
      client,
    });
    agent.replaceConversation([
      { role: "user", content: "port the billing module\nto the new API\nand keep the tests green" },
      ...filler(),
    ]);
    const { handler } = collect();
    for (const p of ["a", "b", "c"]) {
      agent.pushUser(p);
      await agent.run(handler);
    }
    const summary = agent.conversation.find(
      (m) => typeof m.content === "string" && m.content.startsWith("<conversation-summary>")
    );
    expect(String(summary?.content)).toContain("port the billing module");
    expect(String(summary?.content)).toContain("keep the tests green");
  });
});
