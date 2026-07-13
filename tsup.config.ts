import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  // The CLI is the single entry point; `nexus serve` runs the MCP server over stdio.
  banner: { js: "#!/usr/bin/env node" },
  // Keep node: built-ins (incl. the experimental `node:sqlite`) external and
  // un-rewritten — older esbuild doesn't know `node:sqlite` and would otherwise
  // mangle it to a bare `sqlite` specifier that fails at runtime.
  external: [/^node:/, "@huggingface/transformers"],
});
