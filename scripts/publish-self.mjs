#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";

const skillScript = path.resolve("skills/afterlife-publish/scripts/publish.mjs");
const proc = spawnSync(process.execPath, [skillScript, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
});

if (proc.error) {
  throw proc.error;
}

process.exit(proc.status ?? 1);
