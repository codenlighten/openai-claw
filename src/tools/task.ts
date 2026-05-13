import { type Tool, ok, err } from "./types.js";

export const taskTool: Tool<{
  description: string;
  prompt: string;
  subagent_type?: string;
}> = {
  name: "Task",
  description:
    "Launch a subagent to handle complex multi-step work in an isolated context. Use for: open-ended research, parallel investigations, or tasks whose tool output would crowd the parent's context. Brief the subagent thoroughly — it sees none of this conversation. Available subagent types: 'general-purpose', 'explore' (read-only search).",
  needsPermission: false,
  mutates: false,
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: "Short (3-5 word) description of the task" },
      prompt: { type: "string", description: "Self-contained instructions for the subagent" },
      subagent_type: {
        type: "string",
        enum: ["general-purpose", "explore"],
        description: "Which subagent type to use (default 'general-purpose')",
      },
    },
    required: ["description", "prompt"],
  },
  async run(input, ctx) {
    if (!ctx.spawnSubagent) return err("Subagent spawning is not available in this context.");
    try {
      const result = await ctx.spawnSubagent({
        description: input.description,
        prompt: input.prompt,
        subagent_type: input.subagent_type,
      });
      return ok(result);
    } catch (e: any) {
      return err(`Subagent failed: ${e?.message ?? String(e)}`);
    }
  },
  preview: (input) => `Task: ${input.description}`,
};
