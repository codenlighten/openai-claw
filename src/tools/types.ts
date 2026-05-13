import type { ClawConfig } from "../config.js";

export interface ToolContext {
  config: ClawConfig;
  // Bag of services the tool may need. Kept loose so each tool only pulls what it uses.
  abortSignal?: AbortSignal;
  permissionCheck: (tool: string, input: unknown) => Promise<PermissionDecision>;
  // For subagents to spawn child agents.
  spawnSubagent?: (opts: SubagentRequest) => Promise<string>;
  // For long-running tools to stream progress lines back to the UI.
  onProgress?: (chunk: string) => void;
  // Identifies the in-flight tool call so the UI can route progress events.
  callId?: string;
}

export type PermissionDecision =
  | { allow: true }
  | { allow: false; reason: string };

export interface SubagentRequest {
  description: string;
  prompt: string;
  subagent_type?: string;
}

export interface ToolResult {
  // Returned to the model as the tool message content.
  content: string;
  // Whether the tool succeeded. Failed tools still return content (the error string).
  isError?: boolean;
  // Optional structured display for the UI layer.
  display?: string;
}

// JSON schema (subset) compatible with OpenAI's function-calling spec.
export interface JsonSchema {
  type: "object";
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface Tool<TInput = any> {
  name: string;
  description: string;
  parameters: JsonSchema;
  // True = needs permission prompt (unless allowlisted). False = always-on (e.g. Read).
  needsPermission: boolean;
  // True = mutates state (file writes, bash, etc).
  mutates: boolean;
  run(input: TInput, ctx: ToolContext): Promise<ToolResult>;
  // Optional human-readable rendering for confirmation prompts.
  preview?(input: TInput): string;
}

export function ok(content: string, display?: string): ToolResult {
  return { content, display };
}

export function err(message: string): ToolResult {
  return { content: message, isError: true };
}
