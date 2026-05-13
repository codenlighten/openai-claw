export type ChatItem =
  | { kind: "user"; text: string; id: string }
  | { kind: "assistant"; text: string; id: string; streaming?: boolean }
  | { kind: "tool_call"; tool: string; preview: string; id: string; callId?: string; progress?: string }
  | { kind: "tool_result"; tool: string; content: string; isError: boolean; id: string; display?: string }
  | { kind: "system"; text: string; id: string }
  | { kind: "error"; text: string; id: string };

export interface PendingPermission {
  tool: string;
  key: string;
  input: unknown;
  resolve: (answer: "yes" | "no" | "always" | "save") => void;
}
