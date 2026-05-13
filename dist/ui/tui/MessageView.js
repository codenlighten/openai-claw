import React from "react";
import { Box, Text } from "ink";
import { Diff } from "./Diff.js";
import { renderMarkdown, renderStreamingMarkdown } from "./markdown.js";
import { highlightToolOutput } from "./highlight.js";
function renderAssistant(text, streaming) {
    if (streaming)
        return renderStreamingMarkdown(text);
    return renderMarkdown(text);
}
export function MessageView({ item }) {
    switch (item.kind) {
        case "user":
            return (React.createElement(Box, { marginTop: 1 },
                React.createElement(Text, { color: "cyan", bold: true }, "> "),
                React.createElement(Text, null, item.text)));
        case "assistant":
            return (React.createElement(Box, { marginTop: 1, flexDirection: "column" },
                React.createElement(Text, null, renderAssistant(item.text, item.streaming))));
        case "tool_call": {
            const progressLines = (item.progress ?? "").split("\n").slice(-6);
            return (React.createElement(Box, { flexDirection: "column", marginTop: 1 },
                React.createElement(Box, null,
                    React.createElement(Text, { color: "blue" }, "\u25B8 "),
                    React.createElement(Text, { color: "blue" }, item.preview)),
                item.progress && (React.createElement(Box, { flexDirection: "column", marginLeft: 2 }, progressLines.map((line, i) => (React.createElement(Text, { key: i, dimColor: true }, line)))))));
        }
        case "tool_result": {
            if (item.display && (item.tool === "Write" || item.tool === "Edit")) {
                return React.createElement(Diff, { patch: item.display });
            }
            const rendered = item.isError ? item.content : highlightToolOutput(item.tool, item.content);
            const lines = rendered.split("\n");
            const limit = 12;
            const shown = lines.slice(0, limit);
            const more = lines.length > shown.length ? lines.length - shown.length : 0;
            return (React.createElement(Box, { flexDirection: "column" },
                shown.map((line, i) => (React.createElement(Text, { key: i, color: item.isError ? "red" : undefined, dimColor: !item.isError }, "  " + line))),
                more > 0 && React.createElement(Text, { color: "gray" }, `  … (${more} more lines — /last to expand)`)));
        }
        case "system":
            return React.createElement(Text, { color: "magenta" }, item.text);
        case "error":
            return (React.createElement(Box, { marginTop: 1 },
                React.createElement(Text, { color: "red" },
                    "! ",
                    item.text)));
    }
}
//# sourceMappingURL=MessageView.js.map