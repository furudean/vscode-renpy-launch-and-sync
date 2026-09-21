import { defineConfig } from "@vscode/test-cli"
import { createHash } from "node:crypto"
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs"
import { access, readFile } from "node:fs/promises"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import { join } from "node:path"
import { tmpdir } from "node:os"

// the e2e tests open this project as their workspace
const workspace = join(import.meta.dirname, "test", "fixtures", "project")

// the sdk the game tests run against. the archive is fetched once into the
// cache below, and the tests serve it to the extension from localhost so the
// extension's own download path runs on every run without touching renpy.org
const SDK_VERSION = "8.5.3"
const sdk_cache = join(
	import.meta.dirname,
	".vscode-test",
	"cache",
	SDK_VERSION
)

async function fetch_to(url, file) {
	const response = await fetch(url)
	if (!response.ok || !response.body) {
		throw new Error(`failed to download ${url}: ${response.status}`)
	}
	await pipeline(Readable.fromWeb(response.body), createWriteStream(file))
}

async function ensure_sdk_archive() {
	const name = `renpy-${SDK_VERSION}-sdk.zip`
	const archive = join(sdk_cache, name)
	const checksums = join(sdk_cache, "checksums.txt")
	const base = `https://renpy.org/dl/${SDK_VERSION}/`

	try {
		await access(archive)
		await access(checksums)
		return
	} catch {
		// not cached yet
	}

	mkdirSync(sdk_cache, { recursive: true })
	console.log(`downloading ${base}${name}`)
	await fetch_to(base + "checksums.txt", checksums)
	await fetch_to(base + name, archive)

	const md5 = (await readFile(checksums, "utf8"))
		.split("# md5")[1]
		.split("# sha1")[0]
		.match(new RegExp(`^([a-f0-9]+)\\s+${name}$`, "m"))?.[1]
	const actual = createHash("md5")
		.update(await readFile(archive))
		.digest("hex")
	if (md5 !== actual) {
		throw new Error(
			`checksum mismatch for ${name}: expected ${md5}, got ${actual}`
		)
	}
}

await ensure_sdk_archive()

const user_data_dir = join(
	process.env.RUNNER_TEMP ?? tmpdir(),
	"renpy-warp-user-data"
)
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

		"renpyWarp.strategy": "Update Window",
		"renpyWarp.renpyExtensionsEnabled": "Disabled",
		"renpyWarp.autoConnectExternalProcesses": "Never connect",
		"renpyWarp.followCursorMode": "Ren'Py updates Visual Studio Code",
		"renpyWarp.followCursorBehavior": "Just reveal",
		"renpyWarp.followCursorOnLaunch": false,
		"renpyWarp.setAutoReloadOnSave": false,
		"renpyWarp.processEnvironment": {
			RENPY_DISABLE_SOUND: "1", // be quiet
			SDL_MAC_BACKGROUND_APP: "1" // dont steal focus
		}
	})
)

export default defineConfig({
	files: "out/**/*.e2e.test.js",
	workspaceFolder: workspace,
	env: { RENPY_SDK_VERSION: SDK_VERSION, RENPY_SDK_CACHE: sdk_cache },
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
