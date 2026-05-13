import React from "react";
import { Box, Text } from "ink";
/**
 * Render a unified diff (as produced by `diff.createPatch`) with color.
 * Skips the leading `Index:` / `===` / file header lines.
 */
export function Diff({ patch }) {
    const lines = patch.split("\n");
    // Trim the standard header lines from `diff` package.
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("@@")) {
            start = i;
            break;
        }
    }
    const body = lines.slice(start);
    const MAX = 40;
    const trimmed = body.slice(0, MAX);
    return (React.createElement(Box, { flexDirection: "column", marginLeft: 2 },
        trimmed.map((line, i) => {
            let color;
            if (line.startsWith("@@"))
                color = "cyan";
            else if (line.startsWith("+"))
                color = "green";
            else if (line.startsWith("-"))
                color = "red";
            else
                color = "gray";
            return (React.createElement(Text, { key: i, color: color }, line || " "));
        }),
        body.length > MAX && React.createElement(Text, { color: "gray" },
            "  \u2026 (",
            body.length - MAX,
            " more diff lines)")));
}
//# sourceMappingURL=Diff.js.map