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

export const todoWriteTool: Tool<{ todos: TodoItem[] }> = {
  name: "TodoWrite",
  description:
    "Create and manage a structured todo list for the current session. Use for tasks that span 3+ steps. Replace the whole list each call. Mark exactly one item in_progress at a time.",
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
  async run(input) {
    todoList = input.todos;
    const formatted = todoList
      .map((t, i) => {
        const icon = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
        return `${icon} ${i + 1}. ${t.content}`;
      })
      .join("\n");
    return ok(`Todos updated:\n${formatted}`);
  },
};
