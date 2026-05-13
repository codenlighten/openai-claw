import { ok, err } from "./types.js";
import { listSubagents } from "../subagents/index.js";
/** Built lazily so registered agents in .claw/agents/ surface at runtime. */
export function buildTaskTool(config) {
    const agents = listSubagents(config);
    const enumNames = agents.map((a) => a.name);
    const catalog = agents
        .map((a) => `- ${a.name}${a.tools ? ` (tools: ${a.tools.join(",")})` : ""}: ${a.description}`)
        .join("\n");
    return {
        name: "Task",
        description: `Launch a subagent to handle complex multi-step work in an isolated context. Use for: open-ended research, parallel investigations, or tasks whose tool output would crowd the parent's context. Brief the subagent thoroughly — it sees none of this conversation. Set isolation="worktree" to run the subagent in a temporary git worktree; the returned text will include the diff.\nAvailable subagent types:\n${catalog}`,
        needsPermission: false,
        mutates: false,
        parameters: {
            type: "object",
            properties: {
                description: { type: "string", description: "Short (3-5 word) description of the task" },
                prompt: { type: "string", description: "Self-contained instructions for the subagent" },
                subagent_type: {
                    type: "string",
                    enum: enumNames,
                    description: "Which subagent type to use (default 'general-purpose')",
                },
                isolation: {
                    type: "string",
                    enum: ["worktree"],
                    description: "If 'worktree', the subagent runs in a fresh git worktree and its diff is returned.",
                },
            },
            required: ["description", "prompt"],
        },
        async run(input, ctx) {
            if (!ctx.spawnSubagent)
                return err("Subagent spawning is not available in this context.");
            if (input.subagent_type && !enumNames.includes(input.subagent_type)) {
                return err(`Unknown subagent_type: ${input.subagent_type}. Available: ${enumNames.join(", ")}`);
            }
            try {
                const result = await ctx.spawnSubagent({
                    description: input.description,
                    prompt: input.prompt,
                    subagent_type: input.subagent_type,
                    isolation: input.isolation,
                });
                return ok(result);
            }
            catch (e) {
                return err(`Subagent failed: ${e?.message ?? String(e)}`);
            }
        },
        preview: (input) => `Task: ${input.description}${input.isolation ? " [worktree]" : ""}`,
    };
}
/** Static fallback (kept for backwards compat with the existing exports). */
export const taskTool = {
    name: "Task",
    description: "Launch a subagent to handle complex multi-step work in an isolated context. Use for: open-ended research, parallel investigations, or tasks whose tool output would crowd the parent's context. Brief the subagent thoroughly — it sees none of this conversation. Available subagent types: 'general-purpose', 'explore' (read-only search).",
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
        if (!ctx.spawnSubagent)
            return err("Subagent spawning is not available in this context.");
        try {
            const result = await ctx.spawnSubagent({
                description: input.description,
                prompt: input.prompt,
                subagent_type: input.subagent_type,
            });
            return ok(result);
        }
        catch (e) {
            return err(`Subagent failed: ${e?.message ?? String(e)}`);
        }
    },
    preview: (input) => `Task: ${input.description}`,
};
//# sourceMappingURL=task.js.map