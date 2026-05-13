import React from "react";
import path from "node:path";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ClawConfig } from "../../config.js";

export function StatusBar({
  config,
  busy,
  totalTokens,
  totalCostUSD,
}: {
  config: ClawConfig;
  busy: boolean;
  totalTokens: number;
  totalCostUSD: number;
}) {
  const cost = totalCostUSD > 0 ? ` $${totalCostUSD.toFixed(4)}` : "";
  const wd = shortWorkdir(config.workdir);
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {busy ? <Spinner type="dots" /> : "●"}{" "}
        <Text bold color="cyan">openai-claw</Text>{" "}
        <Text dimColor>model={config.model} mode={config.permissionMode} wd={wd} tokens={totalTokens}{cost}</Text>
      </Text>
    </Box>
  );
}

function shortWorkdir(p: string): string {
  const parts = p.split(path.sep).filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join("/")}`;
}
