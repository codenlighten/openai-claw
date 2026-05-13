import type { Tool } from "./types.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { lsTool } from "./ls.js";
import { webFetchTool } from "./webfetch.js";
import { webSearchTool } from "./websearch.js";
import { taskTool } from "./task.js";
import { todoWriteTool } from "./todo.js";

export function getAllTools(): Tool[] {
  return [
    readTool,
    writeTool,
    editTool,
    bashTool,
    grepTool,
    globTool,
    lsTool,
    webFetchTool,
    webSearchTool,
    taskTool,
    todoWriteTool,
  ];
}

export function getSubagentTools(kind: "general-purpose" | "explore"): Tool[] {
  if (kind === "explore") {
    return [readTool, grepTool, globTool, lsTool, webFetchTool, webSearchTool];
  }
  return getAllTools().filter((t) => t.name !== "Task");
}
