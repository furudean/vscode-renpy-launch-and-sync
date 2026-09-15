import { defineConfig } from "@vscode/test-cli"
import { tmpdir } from "node:os"
import { join } from "node:path"

export default defineConfig({
	files: "out/test/extension/**/*.test.js",
	launchArgs: [`--user-data-dir=${join(tmpdir(), "vscode-renpy-warp-test")}`]
})
