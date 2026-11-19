#!/usr/bin/env node
import { main } from "./cli.js";
import { xcodeSymcacheBuilder } from "./symcache/macho.js";

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  fetch: globalThis.fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  platform: process.platform,
  symcache: xcodeSymcacheBuilder,
});
