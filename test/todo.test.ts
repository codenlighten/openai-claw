import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  todoWriteTool,
  createSubagentTodoTool,
  getTodos,
  loadTodos,
  _resetTodos,
} from "../src/tools/todo.js";
import { getSubagentTools } from "../src/tools/index.js";
import type { ToolContext } from "../src/tools/types.js";

let tmp: string;
const ctx = (): ToolContext => ({
  config: {
    workdir: tmp,
    homeDir: tmp,
    projectDir: tmp,
    memoryDir: tmp,
    model: "x",
    apiKey: "x",
    allowedTools: [],
    deniedTools: [],
    contextWindow: 0,
    compactThreshold: 1,
    permissionMode: "ask",
    maxTurns: 50,
    maxToolResultChars: 50_000,
    models: {},
  },
  permissionCheck: async () => ({ allow: true }),
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-todo-"));
  _resetTodos();
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const item = (content: string) => ({ content, status: "pending" as const });

describe("TodoWrite", () => {
  it("records and formats the list", async () => {
    const r = await todoWriteTool.run({ todos: [item("first"), item("second")] }, ctx());
    expect(r.content).toContain("[ ] 1. first");
    expect(r.content).toContain("[ ] 2. second");
    expect(getTodos()).toHaveLength(2);
  });

  it("persists the main agent's list across a reload", async () => {
    await todoWriteTool.run({ todos: [item("survive me")] }, ctx());
    _resetTodos();
    expect(getTodos()).toHaveLength(0);
    loadTodos(tmp);
    expect(getTodos()[0].content).toBe("survive me");
  });
});

describe("subagent todo isolation", () => {
  it("a subagent's list does not replace the parent's", async () => {
    await todoWriteTool.run({ todos: [item("parent step 1"), item("parent step 2")] }, ctx());
    const subTool = createSubagentTodoTool();
    await subTool.run({ todos: [item("subagent scratch")] }, ctx());
    // The bug: one module-level array meant this overwrote the parent's plan.
    expect(getTodos().map((t) => t.content)).toEqual(["parent step 1", "parent step 2"]);
  });

  it("a subagent's list does not reach the shared todos file", async () => {
    await todoWriteTool.run({ todos: [item("parent step")] }, ctx());
    const subTool = createSubagentTodoTool();
    await subTool.run({ todos: [item("subagent scratch")] }, ctx());
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, "todos.json"), "utf8"));
    expect(onDisk.map((t: any) => t.content)).toEqual(["parent step"]);
  });

  it("two subagents keep separate lists", async () => {
    const a = createSubagentTodoTool();
    const b = createSubagentTodoTool();
    await a.run({ todos: [item("a only")] }, ctx());
    const rb = await b.run({ todos: [item("b only")] }, ctx());
    expect(rb.content).toContain("b only");
    expect(rb.content).not.toContain("a only");
  });

  it("the subagent tool set ships the isolated TodoWrite", async () => {
    await todoWriteTool.run({ todos: [item("parent step")] }, ctx());
    const tool = getSubagentTools("general-purpose").find((t) => t.name === "TodoWrite");
    expect(tool).toBeTruthy();
    await tool!.run({ todos: [item("subagent step")] } as any, ctx());
    expect(getTodos().map((t) => t.content)).toEqual(["parent step"]);
  });
});
