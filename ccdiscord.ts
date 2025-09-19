#!/usr/bin/env -S deno run -A --env
// ⚠️ 必ず最初に評価されるよう、先頭で副作用 import
import "./src/boot/ws-shim-early.ts";
import "./src/main.ts";
