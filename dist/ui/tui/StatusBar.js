import React from "react";
import path from "node:path";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
export function StatusBar({ config, busy, totalTokens, totalCostUSD, }) {
    const cost = totalCostUSD > 0 ? ` $${totalCostUSD.toFixed(4)}` : "";
    const wd = shortWorkdir(config.workdir);
    return (React.createElement(Box, { marginTop: 1 },
        React.createElement(Text, { dimColor: true },
            busy ? React.createElement(Spinner, { type: "dots" }) : "●",
            " ",
            React.createElement(Text, { bold: true, color: "cyan" }, "openai-claw"),
            " ",
            React.createElement(Text, { dimColor: true },
                "model=",
                config.model,
                " mode=",
                config.permissionMode,
                " wd=",
                wd,
                " tokens=",
                totalTokens,
                cost))));
}
function shortWorkdir(p) {
    const parts = p.split(path.sep).filter(Boolean);
    if (parts.length <= 2)
        return p;
    return `…/${parts.slice(-2).join("/")}`;
}
//# sourceMappingURL=StatusBar.js.map