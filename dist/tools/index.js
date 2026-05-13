import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { lsTool } from "./ls.js";
import { webFetchTool } from "./webfetch.js";
import { webSearchTool } from "./websearch.js";
import { taskTool, buildTaskTool } from "./task.js";
import { todoWriteTool } from "./todo.js";
import { bashOutputTool, killShellTool } from "./shell.js";
import { semanticTool } from "./semantic.js";
/**
 * Build the tool catalog. Pass a config to get a Task tool whose enum reflects
 * the current registered subagent types; without it falls back to the static
 * taskTool with only the builtin types.
 */
export function getAllTools(config) {
    const task = config ? buildTaskTool(config) : taskTool;
    return [
        readTool,
        writeTool,
        editTool,
        bashTool,
        bashOutputTool,
        killShellTool,
        grepTool,
        globTool,
        lsTool,
        semanticTool,
        webFetchTool,
        webSearchTool,
        task,
        todoWriteTool,
    ];
}
export function getSubagentTools(kind) {
    if (kind === "explore") {
        return [readTool, grepTool, globTool, lsTool, semanticTool, webFetchTool, webSearchTool];
    }
    return getAllTools().filter((t) => t.name !== "Task");
}
//# sourceMappingURL=index.js.map