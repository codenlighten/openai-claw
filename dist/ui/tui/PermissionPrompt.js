import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
export function PermissionPrompt({ pending }) {
    const [selected, setSelected] = useState(0);
    const choices = [
        { key: "y", label: "Yes (once)", value: "yes" },
        { key: "a", label: "Always (this session)", value: "always" },
        { key: "s", label: "Save to settings (allowlist)", value: "save" },
        { key: "n", label: "No (deny)", value: "no" },
    ];
    useInput((input, key) => {
        if (key.upArrow)
            setSelected((s) => (s - 1 + choices.length) % choices.length);
        else if (key.downArrow)
            setSelected((s) => (s + 1) % choices.length);
        else if (key.return)
            pending.resolve(choices[selected].value);
        else {
            const c = choices.find((c) => c.key === input.toLowerCase());
            if (c)
                pending.resolve(c.value);
        }
    });
    return (React.createElement(Box, { borderStyle: "round", borderColor: "yellow", flexDirection: "column", paddingX: 1, marginY: 1 },
        React.createElement(Text, { color: "yellow", bold: true }, "Permission required"),
        React.createElement(Text, null,
            "Tool: ",
            React.createElement(Text, { color: "cyan" }, pending.tool),
            " (",
            pending.key,
            ")"),
        React.createElement(Box, { marginTop: 1, flexDirection: "column" },
            React.createElement(Text, { dimColor: true }, "Input:"),
            React.createElement(Text, null, truncate(JSON.stringify(pending.input, null, 2), 400))),
        React.createElement(Box, { marginTop: 1, flexDirection: "column" }, choices.map((c, i) => (React.createElement(Text, { key: c.value, color: i === selected ? "green" : undefined },
            i === selected ? "› " : "  ",
            "[",
            c.key,
            "] ",
            c.label)))),
        React.createElement(Box, { marginTop: 1 },
            React.createElement(Text, { dimColor: true }, "\u2191/\u2193 to choose, Enter to confirm, or press the letter directly."))));
}
function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + "\n…" : s;
}
//# sourceMappingURL=PermissionPrompt.js.map