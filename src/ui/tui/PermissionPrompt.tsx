import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { PendingPermission } from "./types.js";

export function PermissionPrompt({ pending }: { pending: PendingPermission }) {
  const [selected, setSelected] = useState(0);
  const choices: { key: string; label: string; value: "yes" | "no" | "always" | "save" }[] = [
    { key: "y", label: "Yes (once)", value: "yes" },
    { key: "a", label: "Always (this session)", value: "always" },
    { key: "s", label: "Save to settings (allowlist)", value: "save" },
    { key: "n", label: "No (deny)", value: "no" },
  ];

  useInput((input, key) => {
    if (key.upArrow) setSelected((s) => (s - 1 + choices.length) % choices.length);
    else if (key.downArrow) setSelected((s) => (s + 1) % choices.length);
    else if (key.return) pending.resolve(choices[selected].value);
    else {
      const c = choices.find((c) => c.key === input.toLowerCase());
      if (c) pending.resolve(c.value);
    }
  });

  return (
    <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1} marginY={1}>
      <Text color="yellow" bold>
        Permission required
      </Text>
      <Text>
        Tool: <Text color="cyan">{pending.tool}</Text> ({pending.key})
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Input:</Text>
        <Text>{truncate(JSON.stringify(pending.input, null, 2), 400)}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {choices.map((c, i) => (
          <Text key={c.value} color={i === selected ? "green" : undefined}>
            {i === selected ? "› " : "  "}[{c.key}] {c.label}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ to choose, Enter to confirm, or press the letter directly.</Text>
      </Box>
    </Box>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\n…" : s;
}
