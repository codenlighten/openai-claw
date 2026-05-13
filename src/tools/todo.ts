import fs from "node:fs";
import path from "node:path";
import { type Tool, ok } from "./types.js";

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

let todoList: TodoItem[] = [];

export function getTodos(): TodoItem[] {
  return todoList;
}

function todosFile(memoryDir: string): string {
  return path.join(memoryDir, "todos.json");
}

export function loadTodos(memoryDir: string): void {
  try {
    const f = todosFile(memoryDir);
    if (!fs.existsSync(f)) return;
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    if (Array.isArray(raw)) todoList = raw;
  } catch {
    // ignore — start fresh
  }
}

export const todoWriteTool: Tool<{ todos: TodoItem[] }> = {
  name: "TodoWrite",
  description:
    "Create and manage a structured todo list for the current session. Use for tasks that span 3+ steps. Replace the whole list each call. Mark exactly one item in_progress at a time. The list is persisted to disk and survives /resume.",
  needsPermission: false,
  mutates: false,
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Imperative form, e.g. 'Run the tests'" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            activeForm: { type: "string", description: "Present continuous, e.g. 'Running the tests'" },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  async run(input, ctx) {
    todoList = input.todos;
    try {
      fs.writeFileSync(todosFile(ctx.config.memoryDir), JSON.stringify(todoList, null, 2));
    } catch {
      // persistence failure is non-fatal — the in-memory list still works for this turn
    }
    const formatted = todoList
      .map((t, i) => {
        const icon = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
        return `${icon} ${i + 1}. ${t.content}`;
      })
      .join("\n");
    return ok(`Todos updated:\n${formatted}`);
  },
};
