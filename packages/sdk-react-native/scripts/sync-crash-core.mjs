#!/usr/bin/env node
// Copies the native crash reporter's core (sdks/ios/Sources/CohorlyCrash/Core,
// the source of truth) into ios/CohorlyCrash/, byte for byte. The pod compiles
// the copy; test/crash-core-sync.test.ts fails when the two diverge.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const pkg = new URL("..", import.meta.url).pathname;
const source = join(pkg, "../../sdks/ios/Sources/CohorlyCrash/Core");
const target = join(pkg, "ios/CohorlyCrash");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
const files = readdirSync(source).filter((f) => f.endsWith(".swift")).sort();
for (const file of files) copyFileSync(join(source, file), join(target, file));
console.log(`sync:crash: ${files.length} file(s) -> ios/CohorlyCrash`);
