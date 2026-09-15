type ExtensionApi = import("./extension").ExtensionApi

const assert: typeof import("node:assert") = require("node:assert")
const path: typeof import("node:path") = require("node:path")
const fs: typeof import("node:fs/promises") = require("node:fs/promises")
const vscode: typeof import("vscode") = require("vscode")

const sdk_path = process.env.RENPY_SDK_PATH as string
const project_root = path.join(sdk_path, "the_question")
const script = path.join(project_root, "game", "script.rpy")

const fs_path = (file: string) => vscode.Uri.file(file).fsPath

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function wait_for(
	predicate: () => boolean,
	what: string,
	timeout_ms = 30_000
): Promise<void> {
	const deadline = Date.now() + timeout_ms

	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
		await sleep(100)
	}
}

async function show_line(file: string, line: number): Promise<void> {
	const document = await vscode.workspace.openTextDocument(file)
	const editor = await vscode.window.showTextDocument(document)
	editor.selection = new vscode.Selection(line, 0, line, 0)
}

async function update_config(values: Record<string, unknown>): Promise<void> {
	const config = vscode.workspace.getConfiguration("renpyWarp")

	for (const [key, value] of Object.entries(values)) {
		await config.update(key, value, vscode.ConfigurationTarget.Global)
	}
}

suite("renpyWarp", function () {
	this.timeout(60_000)

	let api: ExtensionApi

	suiteSetup(async () => {
		await update_config({
			sdkPath: sdk_path,
			renpyExtensionsEnabled: "Disabled"
		})

		const extension = vscode.extensions.getExtension<ExtensionApi>(
			"PaisleySoftworks.renpyWarp"
		)
		assert.ok(extension, "extension not found")

		api = await extension.activate()
	})

	test("activates in a ren'py workspace", () => {
		assert.strictEqual(
			vscode.workspace.workspaceFolders?.[0].uri.fsPath,
			fs_path(project_root)
		)
		assert.ok(api.pm, "extension api not exported")
	})

	test("registers its commands", async () => {
		const commands = await vscode.commands.getCommands(true)

		assert.ok(commands.includes("renpyWarp.launch"))
	})

	test("lints the project and opens the report", async () => {
		const lint_txt = path.join(sdk_path, "tmp", "the_question", "lint.txt")
		await fs.rm(lint_txt, { force: true })

		await vscode.commands.executeCommand("renpyWarp.lint")

		const document = vscode.window.activeTextEditor?.document
		assert.strictEqual(document?.uri.fsPath, fs_path(lint_txt))
		assert.match(document.getText(), /Lint is not a substitute/)
	})

	test("launches the game and kills it", async () => {
		await vscode.commands.executeCommand("renpyWarp.launch")

		assert.strictEqual(api.pm.length, 1)
		const process = api.pm.at(0) as import("./lib/process").ManagedProcess

		const exited = new Promise((resolve) => process.once("exit", resolve))
		await vscode.commands.executeCommand("renpyWarp.killAll")
		await exited

		// a game that died on its own would have left an exit code behind
		// rather than going down to our signal
		assert.strictEqual(process.exit_code, null, "game exited early")
		assert.strictEqual(process.dead, true)
		assert.strictEqual(api.pm.length, 0)
	})

	suite("follow cursor", function () {
		this.timeout(120_000)

		suiteSetup(async () => {
			await update_config({
				renpyExtensionsEnabled: "Enabled",
				strategy: "Update Window",
				followCursorOnLaunch: true,
				followCursorMode: "Update both",
				followCursorBehavior: "Cursor at line end"
			})
		})

		suiteTeardown(async () => {
			await vscode.commands.executeCommand("renpyWarp.killAll")
		})

		// launches the game when nothing is running and hands back the process
		// once its rpe has connected
		async function running(): Promise<import("./lib/process").AnyProcess> {
			if (api.pm.length === 0) {
				await vscode.commands.executeCommand("renpyWarp.launch")
			}

			const process = api.pm.at(-1)
			assert.ok(process, "game did not launch")

			await wait_for(() => process.socket_ready, "the rpe to connect")

			return process
		}

		test("can receive and jump to a label", async () => {
			const process = await running()

			await process.wait_for_labels(10_000)
			assert.ok(process.labels?.includes("start"), "label start not listed")

			// script.rpy:18 is the first line of narration under `label start`
			await process.jump_to_label("start")
			await wait_for(
				() => process.last_cursor?.line === 18,
				"ren'py to report script.rpy:18"
			)
			assert.strictEqual(process.last_cursor?.relative_path, "script.rpy")
		})

		test("ren'py and the editor follow each other", async () => {
			const process = await running()

			// the previous test may have left the game sitting on script.rpy:18
			// already, so forget that report before jumping there again
			process.last_cursor = undefined
			const cursor = () => process.last_cursor

			await process.jump_to_label("start")
			await wait_for(
				() => cursor()?.line === 18,
				"ren'py to report script.rpy:18"
			)

			// ren'py updates the editor as the game moves on to the next line of
			// narration
			await process.advance()

			await wait_for(
				() => cursor()?.line === 20,
				"ren'py to report script.rpy:20"
			)
			await wait_for(
				() =>
					vscode.window.activeTextEditor?.document.uri.fsPath ===
						fs_path(script) &&
					vscode.window.activeTextEditor.selection.active.line === 19,
				"the editor to follow ren'py"
			)

			await vscode.commands.executeCommand("cursorMove", {
				to: "down",
				by: "line",
				value: 2
			})
			assert.strictEqual(
				vscode.window.activeTextEditor?.selection.active.line,
				21
			)

			await wait_for(
				() => cursor()?.line === 22,
				"ren'py to follow the editor to script.rpy:22"
			)
			assert.strictEqual(cursor()?.relative_path, "script.rpy")
		})

		test("launches the game warped to a line", async () => {
			await vscode.commands.executeCommand("renpyWarp.killAll")
			await wait_for(() => api.pm.length === 0, "the game to die")

			await show_line(script, 19)
			await vscode.commands.executeCommand("renpyWarp.warpToLine")

			const process = api.pm.at(-1)
			assert.ok(process, "game did not launch")

			// the launch warp lands before the rpe has connected, so nothing is
			// reported until the game moves on from script.rpy:20
			await wait_for(() => process.socket_ready, "the rpe to connect")
			await process.advance()

			await wait_for(
				() => process.last_cursor?.line === 22,
				"ren'py to report script.rpy:22"
			)
		})
	})
})
