import { defineConfig } from "@vscode/test-cli"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensure_sdk } from "./scripts/renpy_sdk.mjs"

// the sdk ships the_question, which the e2e tests open as their workspace
const sdk_path = await ensure_sdk()

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
		"workbench.startupEditor": "none",

		"renpyWarp.sdkPath": sdk_path,
		"renpyWarp.strategy": "Update Window",
		"renpyWarp.renpyExtensionsEnabled": "Disabled",
		"renpyWarp.autoConnectExternalProcesses": "Never connect",
		"renpyWarp.followCursorMode": "Ren'Py updates Visual Studio Code",
		"renpyWarp.followCursorBehavior": "Just reveal",
		"renpyWarp.followCursorOnLaunch": false,
		"renpyWarp.setAutoReloadOnSave": false,
		"renpyWarp.processEnvironment": { RENPY_DISABLE_SOUND: "1" }
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
