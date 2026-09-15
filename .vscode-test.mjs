import { defineConfig } from "@vscode/test-cli"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensure_sdk } from "./scripts/renpy_sdk.mjs"

// the sdk ships the_question, which the e2e tests open as their workspace
const sdk_path = await ensure_sdk()

// keep the test window quiet. copilot and friends are built in now, so they
// are turned off through settings and by disabling them outright
const user_data_dir = join(tmpdir(), "vscode-renpy-warp-test")
mkdirSync(join(user_data_dir, "User"), { recursive: true })
writeFileSync(
	join(user_data_dir, "User", "settings.json"),
	JSON.stringify({
		"chat.disableAIFeatures": true,
		"telemetry.telemetryLevel": "off",
		"update.mode": "none",
		"extensions.autoUpdate": false,
		"extensions.autoCheckUpdates": false,
		"workbench.startupEditor": "none"
	})
)

export default defineConfig({
	files: "out/**/*.e2e.test.js",
	workspaceFolder: join(sdk_path, "the_question"),
	env: { RENPY_SDK_PATH: sdk_path },
	launchArgs: [
		`--user-data-dir=${user_data_dir}`,
		"--disable-extension=GitHub.copilot-chat",
		"--disable-extension=TypeScriptTeam.jsts-chat-features",
		"--disable-telemetry",
		"--disable-updates"
	]
})
