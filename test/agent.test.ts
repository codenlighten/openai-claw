import { describe, it, expect } from "vitest";
import { Agent, type AgentClient, type AgentEvent } from "../src/agent.js";
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
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
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
});
