import { defineConfig } from "@vscode/test-cli"
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs"
import { access, rename, rm } from "node:fs/promises"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import { join } from "node:path"
import { tmpdir } from "node:os"

const workspace = join(import.meta.dirname, "test", "fixtures", "project")

const SDK_VERSION = process.env.RENPY_SDK_VERSION ?? "8.1.0"
const sdk_cache = join(
	import.meta.dirname,
	".vscode-test",
	"cache",
	SDK_VERSION
)

const user_data_dir = join(
	process.env.RUNNER_TEMP ?? tmpdir(),
	"renpy-warp-user-data"
)

const installed_sdk = join(
	user_data_dir,
	"User",
	"globalStorage",
	"paisleysoftworks.renpywarp",
	"sdks",
	`renpy-${SDK_VERSION}-sdk`
)

async function fetch_to(url, file) {
	const response = await fetch(url)
	if (!response.ok || !response.body) {
		throw new Error(`failed to download ${url}: ${response.status}`)
	}

	const partial = `${file}.partial`
	try {
		await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
	} catch (error) {
		await rm(partial, { force: true })
		throw error
	}
	await rename(partial, file)
}

async function ensure_sdk_archive() {
	const name = `renpy-${SDK_VERSION}-sdk.zip`
	const archive = join(sdk_cache, name)
	const checksums = join(sdk_cache, "checksums.txt")
	const base = `https://renpy.org/dl/${SDK_VERSION}/`

	try {
		await access(join(installed_sdk, "renpy.py"))
		return
	} catch {
		// not unpacked
	}

	try {
		await access(archive)
		await access(checksums)
		return
	} catch {
		// not cached
	}

	mkdirSync(sdk_cache, { recursive: true })
	console.log(`downloading ${base}${name}`)
	await fetch_to(base + "checksums.txt", checksums)
	await fetch_to(base + name, archive)
}

await ensure_sdk_archive()

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
		"git.enabled": false,
		"git.autofetch": false,
		"security.workspace.trust.enabled": false,
		"task.autoDetect": "off",
		"extensions.ignoreRecommendations": true,
		"workbench.tips.enabled": false,
		"update.showReleaseNotes": false,

		"renpyWarp.renpyExtensionsEnabled": "Disabled",
		"renpyWarp.autoConnectExternalProcesses": "Never connect",
		"renpyWarp.followCursorMode": "Ren'Py updates Visual Studio Code",
		"renpyWarp.followCursorBehavior": "Just reveal",
		"renpyWarp.followCursorOnLaunch": false,
		"renpyWarp.setAutoReloadOnSave": false
	})
)

export default defineConfig({
	files: "out/**/*.e2e.test.js",
	version: process.env.VSCODE_VERSION || "stable",
	workspaceFolder: workspace,
	env: {
		RENPY_SDK_VERSION: SDK_VERSION,
		RENPY_SDK_CACHE: sdk_cache,
		RENPY_DISABLE_SOUND: "1", // be quiet
		SDL_MAC_BACKGROUND_APP: "1" // dont steal focus
	},
	launchArgs: [
		`--user-data-dir=${user_data_dir}`,
		"--disable-extension=GitHub.copilot-chat",
		"--disable-extension=vscode.git",
		"--disable-extension=vscode.git-base",
		"--disable-extension=vscode.github",
		"--disable-extension=TypeScriptTeam.jsts-chat-features",
		"--disable-extension=vscode.github-authentication",
		"--disable-extension=vscode.microsoft-authentication",
		"--disable-telemetry",
		"--disable-updates",
		"--disable-crash-reporter",
		"--disable-workspace-trust",
		"--sync=off"
	]
})
