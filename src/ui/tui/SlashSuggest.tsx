import React from "react";
import { Box, Text } from "ink";
import { builtinCommands } from "../../commands/index.js";
import { listSkills } from "../../skills/index.js";
import type { ClawConfig } from "../../config.js";

export function SlashSuggest({ input, config }: { input: string; config: ClawConfig }) {
  if (!input.startsWith("/")) return null;
  const query = input.slice(1).toLowerCase();
  const builtin = builtinCommands.map((c) => ({ name: c.name, desc: c.description }));
  const skills = listSkills(config).map((s) => ({ name: s.name, desc: s.description }));
  const all = [...builtin, ...skills];
  const matches = (query === "" ? all : all.filter((c) => c.name.toLowerCase().startsWith(query))).slice(0, 8);
  if (matches.length === 0) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
      <Text dimColor>commands (Tab to complete first match)</Text>
      {matches.map((m) => (
        <Text key={m.name}>
          <Text color="cyan">/{m.name}</Text>{" "}
          <Text dimColor>{m.desc}</Text>
        </Text>
      ))}
    </Box>
  );
}

export function firstMatch(input: string, config: ClawConfig): string | null {
  if (!input.startsWith("/")) return null;
  const query = input.slice(1).toLowerCase();
  if (query === "") return null;
  const all = [
    ...builtinCommands.map((c) => c.name),
    ...listSkills(config).map((s) => s.name),
  ];
  return all.find((n) => n.toLowerCase().startsWith(query)) ?? null;
}
