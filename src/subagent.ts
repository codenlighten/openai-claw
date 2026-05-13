import { Agent } from "./agent.js";
import type { ClawConfig } from "./config.js";
import { getSubagentTools } from "./tools/index.js";
import type { SubagentRequest, ToolContext } from "./tools/types.js";
import { buildSystemPrompt } from "./prompts/system.js";

/**
 * Spawn a subagent. Subagents have their own conversation but share the parent's
 * config + permission manager. Their result is a single text string returned to
 * the parent's Task tool call.
 */
export async function runSubagent(
  config: ClawConfig,
  permissionCheck: ToolContext["permissionCheck"],
  req: SubagentRequest,
  onStatus?: (event: string) => void
): Promise<string> {
  const kind = (req.subagent_type ?? "general-purpose") as "general-purpose" | "explore";
  const tools = getSubagentTools(kind);

  const variant = kind === "explore" ? "subagent-explore" : "subagent-general";
  const systemPrompt = buildSystemPrompt({ config, tools, variant });

  const agent = new Agent({
    config,
    tools,
    permissionCheck,
    // Subagents cannot recursively spawn more subagents.
    spawnSubagent: undefined,
    systemPromptExtras: [],
  });
  // Replace the system prompt with the subagent variant.
  agent.conversation[0] = { role: "system", content: systemPrompt };
  agent.pushUser(req.prompt);

  let result = "";
  onStatus?.(`[subagent:${kind}] ${req.description}`);
  await agent.run((evt) => {
    if (evt.type === "text") result = evt.data as string;
    if (evt.type === "error") {
      result = `Subagent error: ${evt.data}`;
    }
  });
  return result || "(subagent returned no output)";
}
