type ExtensionApi = import("./extension").ExtensionApi
type AnyProcess = import("./lib/process").AnyProcess
type ManagedProcess = import("./lib/process").ManagedProcess
type DebugSession = import("vscode").DebugSession

const assert: typeof import("node:assert") = require("node:assert")
const path: typeof import("node:path") = require("node:path")
const fs: typeof import("node:fs/promises") = require("node:fs/promises")
const http: typeof import("node:http") = require("node:http")
const { createHash }: typeof import("node:crypto") = require("node:crypto")
const AdmZip: typeof import("adm-zip") = require("adm-zip")
const vscode: typeof import("vscode") = require("vscode")

// the sdk the game tests run against. .vscode-test.mjs has already fetched
// the archive into the cache dir, and a server in this process hands it to
// the extension's download command so that path runs offline every time
const SDK_VERSION = process.env.RENPY_SDK_VERSION as string
const SDK_CACHE = process.env.RENPY_SDK_CACHE as string
const SDK_NAME = `renpy-${SDK_VERSION}-sdk`

// a throwaway sdk for the management tests, built in memory
const FAKE_NAME = "renpy-0.0.1-sdk"
const fake_archive = new AdmZip()
fake_archive.addFile(`${FAKE_NAME}/renpy.py`, Buffer.from("# fake sdk\n"))
const fake_zip = fake_archive.toBuffer()
const fake_md5 = createHash("md5").update(fake_zip).digest("hex")

const checksums = (sum: string) => `# md5\n${sum}  ${FAKE_NAME}.zip\n# sha1\n`

/**
 * serves the cached real sdk under /dl/<version>/ and the fake one under
 * /good/ (checksum matches) and /bad/ (checksum does not)
 */
function serve_sdks(): Promise<import("node:http").Server> {
	const server = http.createServer(async (request, response) => {
		const url = new URL(request.url!, "http://localhost")
		const cached = url.pathname.match(`^/dl/${SDK_VERSION}/([^/]+)$`)

		if (cached) {
			const file = path.join(SDK_CACHE, cached[1])
			try {
				const body = await fs.readFile(file)
				response.writeHead(200, { "content-length": body.length })
				return response.end(body)
			} catch {
				response.writeHead(404)
				return response.end()
			}
		}
		if (url.pathname.endsWith(`/${FAKE_NAME}.zip`)) {
			response.writeHead(200, { "content-length": fake_zip.length })
			return response.end(fake_zip)
		}
		if (url.pathname === "/good/checksums.txt") {
			return response.end(checksums(fake_md5))
		}
		if (url.pathname === "/bad/checksums.txt") {
			return response.end(checksums("0".repeat(32)))
		}
		response.writeHead(404)
		response.end()
	})

	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve(server))
	)
}

const project_root = vscode.workspace.workspaceFolders![0].uri.fsPath
const script = path.join(project_root, "game", "script.rpy")

const fs_path = (file: string) => vscode.Uri.file(file).fsPath

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ren'py reports 1-based lines, the editor works in 0-based ones
const editor_line = (line: number) => line - 1

function log_tail(process: AnyProcess | undefined): string {
	if (!process || !("take_output_backlog" in process)) return ""

	const lines = (process as ManagedProcess).take_output_backlog()
	if (lines.length === 0) return ""

	return "\n\nren'py log:\n" + lines.slice(-30).join("\n")
}

async function wait_for(
	predicate: () => boolean,
	what: string,
	{
		process,
		timeout_ms = 10_000
	}: { process?: AnyProcess; timeout_ms?: number } = {}
): Promise<void> {
	const deadline = Date.now() + timeout_ms

	while (!predicate()) {
		if (process?.dead) {
			throw new Error(`process died before ${what}` + log_tail(process))
		}
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}` + log_tail(process))
		}
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

async function write_version_file(value: string): Promise<void> {
	await fs.writeFile(path.join(project_root, ".renpy-version"), value + "\n")
}

suite("renpyWarp", function () {
	this.timeout(30_000)

	let api: ExtensionApi
	let server: import("node:http").Server
	let origin: string
	let sdk_path: string

	suiteSetup(async function () {
		// unpacking the real sdk takes a while
		this.timeout(5 * 60_000)

		const extension = vscode.extensions.getExtension<ExtensionApi>(
			"PaisleySoftworks.renpyWarp"
		)
		assert.ok(extension, "extension not found")

		api = await extension.activate()

		server = await serve_sdks()
		const address = server.address() as import("node:net").AddressInfo
		origin = `http://127.0.0.1:${address.port}`

		// reuse an sdk a previous local run already unpacked - unzipping a
		// real sdk is slow
		const cached = (await api.sdk.list()).find(
			(sdk) => path.basename(sdk) === SDK_NAME
		)

		const downloaded =
			cached ??
			(await api.sdk.download(
				`${origin}/dl/${SDK_VERSION}/${SDK_NAME}.zip`,
				SDK_NAME
			))
		assert.ok(downloaded, `could not install ${SDK_NAME}`)

		sdk_path = downloaded
		await write_version_file(sdk_path)
	})

	suiteTeardown(async () => {
		await fs.rm(path.join(project_root, ".renpy-version"), { force: true })
		await new Promise((resolve) => server.close(resolve))
	})

	test("registers commands", async () => {
		const commands = await vscode.commands.getCommands(true)

		assert.ok(commands.includes("renpyWarp.launch"))
	})

	test("lints the project and opens the report", async () => {
		const lint_txt = path.join(
			sdk_path,
			"tmp",
			path.basename(project_root),
			"lint.txt"
		)
		await fs.rm(lint_txt, { force: true })

		await vscode.commands.executeCommand("renpyWarp.lint")

		await wait_for(
			() =>
				vscode.window.activeTextEditor?.document.uri.fsPath ===
				fs_path(lint_txt),
			"the lint report to open"
		)
		assert.match(
			vscode.window.activeTextEditor!.document.getText(),
			/Lint is not a substitute/
		)
	})

	test("launches the game and kills it", async () => {
		await vscode.commands.executeCommand("renpyWarp.launch")

		assert.strictEqual(api.pm.length, 1)
		const process = api.pm.at(0) as ManagedProcess

		const exited = new Promise((resolve) => process.once("exit", resolve))
		await vscode.commands.executeCommand("renpyWarp.killAll")
		await exited

		// a game that died on its own would have left an exit code behind
		// rather than going down to our signal
		assert.strictEqual(process.exit_code, null, "game exited early")
		assert.strictEqual(process.dead, true)
		assert.strictEqual(api.pm.length, 0)
	})

	suite("sdk management", function () {
		suiteTeardown(async () => {
			for (const sdk of await api.sdk.list()) {
				if (path.basename(sdk) === FAKE_NAME) await api.sdk.uninstall(sdk)
			}
		})

		test("downloads, verifies and unpacks an sdk", async () => {
			const installed = await api.sdk.download(
				`${origin}/good/${FAKE_NAME}.zip`,
				FAKE_NAME
			)
			assert.ok(installed, "download returned nothing")
			assert.strictEqual(path.basename(installed), FAKE_NAME)

			const renpy_py = await fs.readFile(
				path.join(installed, "renpy.py"),
				"utf8"
			)
			assert.strictEqual(renpy_py, "# fake sdk\n")

			// the archive and staging directory are gone once unpacked
			const siblings = await fs.readdir(path.dirname(installed))
			assert.ok(!siblings.includes(`${FAKE_NAME}.zip`), "archive left behind")
			assert.ok(!siblings.includes(`${FAKE_NAME}_tmp`), "staging left behind")
		})

		test("lists downloaded sdks", async () => {
			const sdks = (await api.sdk.list()).map((sdk) => path.basename(sdk))

			assert.ok(sdks.includes(FAKE_NAME))
			assert.ok(sdks.includes(SDK_NAME))
		})

		test("uninstalls an sdk", async () => {
			const before = await api.sdk.list()
			const fake = before.find((sdk) => path.basename(sdk) === FAKE_NAME)
			assert.ok(fake, "fake sdk not installed")

			await api.sdk.uninstall(fake)

			const after = await api.sdk.list()
			assert.ok(!after.includes(fake))
			await assert.rejects(fs.access(fake))
		})

		test("rejects an sdk whose checksum does not match", async () => {
			const installed = await api.sdk.download(
				`${origin}/bad/${FAKE_NAME}.zip`,
				FAKE_NAME
			)

			assert.strictEqual(installed, undefined)

			const sdks = (await api.sdk.list()).map((sdk) => path.basename(sdk))
			assert.ok(!sdks.includes(FAKE_NAME), "bad sdk was installed anyway")

			// the rejected archive is not kept around either
			const siblings = await fs.readdir(path.dirname(sdk_path))
			assert.ok(!siblings.includes(`${FAKE_NAME}.zip`), "archive left behind")
		})

		test("refuses to uninstall a path it did not download", async () => {
			await assert.rejects(api.sdk.uninstall(project_root), /not found/)
		})
	})

	suite("follow cursor", function () {
		this.timeout(30_000)

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

			await update_config({
				renpyExtensionsEnabled: "Disabled",
				followCursorOnLaunch: false,
				followCursorMode: "Ren'Py updates Visual Studio Code",
				followCursorBehavior: "Just reveal"
			})
		})

		// launches the game when nothing is running and hands back the process
		// once its rpe has connected
		async function running(): Promise<AnyProcess> {
			if (api.pm.length === 0) {
				await vscode.commands.executeCommand("renpyWarp.launch")
			}

			const process = api.pm.at(-1)
			assert.ok(process, "game did not launch")

			await wait_for(() => process.socket_ready, "the rpe to connect", {
				process
			})

			return process
		}

		test("can receive and jump to a label", async () => {
			const process = await running()

			await process.wait_for_labels(10_000)
			assert.ok(process.labels?.includes("start"), "label start not listed")

			await process.jump_to_label("start")
			await wait_for(
				() => process.last_cursor?.line === 5,
				`ren'py to report script.rpy:5`,
				{ process }
			)
			assert.strictEqual(process.last_cursor?.relative_path, "script.rpy")
		})

		test("ren'py and the editor follow each other", async () => {
			const process = await running()

			// the previous test may have left the game sitting on script.rpy:5
			// already, so forget that report before jumping there again
			process.last_cursor = undefined
			const cursor = () => process.last_cursor

			await process.jump_to_label("start")
			await wait_for(
				() => cursor()?.line === 5,
				`ren'py to report script.rpy:5`,
				{ process }
			)

			// ren'py updates the editor as the game moves on to the next line of
			// narration
			await process.advance()

			await wait_for(
				() => cursor()?.line === 7,
				`ren'py to report script.rpy:7`,
				{ process }
			)
			await wait_for(
				() =>
					vscode.window.activeTextEditor?.document.uri.fsPath ===
						fs_path(script) &&
					vscode.window.activeTextEditor.selection.active.line ===
						editor_line(7),
				"the editor to follow ren'py",
				{ process }
			)

			await vscode.commands.executeCommand("cursorMove", {
				to: "down",
				by: "line",
				value: 2
			})
			assert.strictEqual(
				vscode.window.activeTextEditor?.selection.active.line,
				editor_line(9)
			)

			await wait_for(
				() => cursor()?.line === 9,
				`ren'py to follow the editor to script.rpy:9`,
				{ process }
			)
			assert.strictEqual(cursor()?.relative_path, "script.rpy")
		})

		test("leaves both sides alone when not following", async () => {
			const process = await running()

			await vscode.commands.executeCommand("renpyWarp.toggleFollowCursor")

			// park the editor on the `return`, then move the game. neither side
			// should react to the other until following is back on
			await show_line(script, editor_line(13))
			process.last_cursor = undefined
			const cursor = () => process.last_cursor

			await process.jump_to_label("start")
			await wait_for(
				() => cursor()?.line === 5,
				"ren'py to report script.rpy:5",
				{ process }
			)
			await sleep(500)
			assert.strictEqual(
				vscode.window.activeTextEditor?.selection.active.line,
				editor_line(13),
				"editor moved while not following"
			)

			await show_line(script, editor_line(9))
			await sleep(500)
			assert.strictEqual(cursor()?.line, 5, "ren'py moved while not following")

			await vscode.commands.executeCommand("renpyWarp.toggleFollowCursor")
			await wait_for(
				() =>
					vscode.window.activeTextEditor?.selection.active.line ===
					editor_line(5),
				"the editor to catch up with ren'py",
				{ process }
			)

			await vscode.commands.executeCommand("cursorMove", {
				to: "down",
				by: "line",
				value: 2
			})
			await wait_for(
				() => cursor()?.line === 7,
				"ren'py to follow the editor again",
				{ process }
			)
		})

		test("launches the game warped to a line", async () => {
			await vscode.commands.executeCommand("renpyWarp.killAll")
			await wait_for(() => api.pm.length === 0, "the game to die")

			await show_line(script, editor_line(7))
			await vscode.commands.executeCommand("renpyWarp.warpToLine")

			const process = api.pm.at(-1)
			assert.ok(process, "game did not launch")

			// the launch warp lands before the rpe has connected, so nothing is
			// reported until the game moves on from the warped line
			await wait_for(() => process.socket_ready, "the rpe to connect", {
				process
			})
			await process.advance()

			await wait_for(
				() => process.last_cursor?.line === 9,
				`ren'py to report script.rpy:9`,
				{ process }
			)
		})
	})

	suite("unmanaged processes", function () {
		this.timeout(30_000)

		suiteSetup(async () => {
			await update_config({
				renpyExtensionsEnabled: "Enabled",
				autoConnectExternalProcesses: "Always connect"
			})
		})

		suiteTeardown(async () => {
			await vscode.commands.executeCommand("renpyWarp.killAll")

			await update_config({
				renpyExtensionsEnabled: "Disabled",
				autoConnectExternalProcesses: "Never connect"
			})
		})

		test("discovers a process that isn't tracked by the process manager", async () => {
			assert.strictEqual(api.pm.length, 0)

			const launched = await api.launch_unmanaged()
			assert.ok(launched, "process did not launch")

			await wait_for(() => api.pm.length === 1, "the process to be discovered")

			const discovered = api.pm.at(0)!
			assert.strictEqual(discovered.pid, launched.pid)

			assert.ok(
				!("take_output_backlog" in discovered),
				"process was tracked as managed"
			)
			assert.notStrictEqual(discovered, launched)

			await wait_for(() => discovered.socket_ready, "the rpe to connect", {
				process: discovered
			})

			await discovered.kill()
			await wait_for(
				() => api.pm.length === 0,
				"the process to be forgotten on exit"
			)

			await (launched as ManagedProcess).wait_for_exit()
			launched.dispose()
		})
	})

	suite("debugging", function () {
		this.timeout(30_000)

		const sessions = new Set<DebugSession>()
		const listeners: import("vscode").Disposable[] = []

		const folder = vscode.workspace.workspaceFolders![0]

		const renpy_sessions = (): DebugSession[] =>
			Array.from(sessions).filter((session) => session.type === "renpyWarp")

		/** the attach session mirroring `pid`, once it has started */
		const session_for = (pid: number): DebugSession | undefined =>
			renpy_sessions().find(
				(session) =>
					session.configuration.request === "attach" &&
					session.configuration.pid === pid
			)

		suiteSetup(() => {
			listeners.push(
				vscode.debug.onDidStartDebugSession((session) => sessions.add(session)),
				vscode.debug.onDidTerminateDebugSession((session) =>
					sessions.delete(session)
				)
			)
		})

		suiteTeardown(async () => {
			for (const listener of listeners) listener.dispose()
			await vscode.commands.executeCommand("renpyWarp.killAll")
		})

		test("launches the game as a debug session", async () => {
			const terminated = new Promise<void>((resolve) => {
				const listener = vscode.debug.onDidTerminateDebugSession(() => {
					listener.dispose()
					resolve()
				})
			})

			const started = await vscode.debug.startDebugging(folder, {
				type: "renpyWarp",
				request: "launch",
				name: "t",
				project: project_root
			})
			assert.strictEqual(started, true, "debug session did not start")

			assert.strictEqual(api.pm.length, 1)
			const process = api.pm.at(0)!
			assert.strictEqual(vscode.debug.activeDebugSession?.type, "renpyWarp")

			await vscode.debug.stopDebugging()
			await wait_for(() => process.dead, "the game to die")
			await terminated

			await wait_for(() => api.pm.length === 0, "the process to be forgotten")
		})

		test("starts a command launch inside a session of its own", async () => {
			assert.strictEqual(renpy_sessions().length, 0)

			await vscode.commands.executeCommand("renpyWarp.launch")

			const process = api.pm.at(-1)
			assert.ok(process, "game did not launch")

			// the command goes through the debugger itself, so the process is
			// born inside a launch session rather than being adopted into one
			assert.strictEqual(renpy_sessions().length, 1)
			assert.strictEqual(
				renpy_sessions()[0].configuration.request,
				"launch",
				"process was adopted rather than launched"
			)

			await vscode.commands.executeCommand("renpyWarp.killAll")

			await wait_for(() => api.pm.length === 0, "the game to die")
			await wait_for(
				() => renpy_sessions().length === 0,
				"the session to terminate"
			)
		})

		test("warps the open game rather than starting a second one", async () => {
			await update_config({
				renpyExtensionsEnabled: "Enabled",
				strategy: "Update Window"
			})

			try {
				await vscode.commands.executeCommand("renpyWarp.launch")

				const process = api.pm.at(-1)
				assert.ok(process, "game did not launch")
				await wait_for(() => process.socket_ready, "the rpe to connect", {
					process
				})

				assert.strictEqual(renpy_sessions().length, 1)

				// warping an open window starts nothing, so the session it
				// already has is the only one
				await show_line(script, editor_line(7))
				await vscode.commands.executeCommand("renpyWarp.warpToLine")

				assert.strictEqual(api.pm.length, 1, "a second game was started")
				assert.strictEqual(renpy_sessions().length, 1, "a second session ran")

				await vscode.commands.executeCommand("renpyWarp.killAll")
				await wait_for(() => api.pm.length === 0, "the game to die")
				await wait_for(
					() => renpy_sessions().length === 0,
					"the session to terminate"
				)
			} finally {
				await update_config({
					renpyExtensionsEnabled: "Disabled",
					strategy: "Update Window"
				})
			}
		})

		test("sends process output to the debug console", async () => {
			const output: string[] = []
			const tracker = vscode.debug.registerDebugAdapterTrackerFactory(
				"renpyWarp",
				{
					createDebugAdapterTracker() {
						return {
							onDidSendMessage(message: {
								type?: string
								event?: string
								body?: { output?: string }
							}) {
								if (message.type === "event" && message.event === "output") {
									output.push(message.body?.output ?? "")
								}
							}
						}
					}
				}
			)

			try {
				await vscode.commands.executeCommand("renpyWarp.launch")

				const process = api.pm.at(-1)
				assert.ok(process, "game did not launch")

				// the console is the only place process output goes now, and it
				// gets the lines written before the session bound as well
				await wait_for(
					() => output.some((line) => line.includes("Ren'Py")),
					"ren'py to say something on the console",
					{ process }
				)

				assert.ok(
					output.some((line) => line.includes(String(process.pid))),
					"the console never named the process"
				)

				await vscode.commands.executeCommand("renpyWarp.killAll")
				await wait_for(() => api.pm.length === 0, "the game to die")
				await wait_for(
					() => renpy_sessions().length === 0,
					"the session to terminate"
				)
			} finally {
				tracker.dispose()
			}
		})

		test("resolves the sdk a configuration names", async () => {
			const resolve = (sdk: string) =>
				api.debug_provider.resolveDebugConfigurationWithSubstitutedVariables(
					folder,
					{
						type: "renpyWarp",
						request: "launch",
						name: "t",
						project: project_root,
						sdk
					}
				)

			// a managed install is named by its version
			const by_name = await resolve(SDK_NAME)
			assert.strictEqual(fs_path(by_name!._sdk_path!), fs_path(sdk_path))

			// anything shaped like a path is one
			const by_path = await resolve(sdk_path)
			assert.strictEqual(fs_path(by_path!._sdk_path!), fs_path(sdk_path))

			assert.strictEqual(
				await resolve(project_root),
				undefined,
				"a path holding no sdk was accepted"
			)
		})

		test("launches with the sdk a configuration names", async () => {
			// with no .renpy-version, only the attribute can find an sdk
			await fs.rm(path.join(project_root, ".renpy-version"), { force: true })

			try {
				const started = await vscode.debug.startDebugging(folder, {
					type: "renpyWarp",
					request: "launch",
					name: "t",
					project: project_root,
					sdk: sdk_path
				})

				assert.strictEqual(started, true, "debug session did not start")
				assert.strictEqual(api.pm.length, 1)
			} finally {
				await write_version_file(sdk_path)
			}

			await vscode.commands.executeCommand("renpyWarp.killAll")
			await wait_for(() => api.pm.length === 0, "the game to die")
			await wait_for(
				() => renpy_sessions().length === 0,
				"the session to terminate"
			)
		})

		test("resolves a bare f5 to a launch configuration", async () => {
			// workbench.action.debug.start would show the debugger quick pick
			// whenever the ren'py language extension is installed too, so ask
			// the provider directly
			const resolved = await api.debug_provider.resolveDebugConfiguration(
				folder,
				{} as import("vscode").DebugConfiguration
			)

			assert.deepStrictEqual(resolved, {
				type: "renpyWarp",
				request: "launch",
				name: "Launch project 'project'",
				project: "${workspaceFolder}"
			})
		})

		test("refuses to attach to a pid it does not track", async () => {
			assert.strictEqual(renpy_sessions().length, 0)

			const started = await vscode.debug.startDebugging(folder, {
				type: "renpyWarp",
				request: "attach",
				name: "t",
				pid: 1
			})

			assert.strictEqual(started, false, "session started anyway")
			assert.strictEqual(
				renpy_sessions().length,
				0,
				"a session was left behind"
			)
			assert.strictEqual(api.pm.length, 0)
		})

		suite("stepping", function () {
			this.timeout(30_000)

			suiteSetup(async () => {
				await update_config({ renpyExtensionsEnabled: "Enabled" })
			})

			suiteTeardown(async () => {
				await vscode.commands.executeCommand("renpyWarp.killAll")
				await update_config({ renpyExtensionsEnabled: "Disabled" })
			})

			async function debugging(): Promise<{ process: AnyProcess }> {
				const started = await vscode.debug.startDebugging(folder, {
					type: "renpyWarp",
					request: "launch",
					name: "t",
					project: project_root
				})
				assert.strictEqual(started, true, "debug session did not start")

				const process = api.pm.at(-1)
				assert.ok(process, "game did not launch")

				await wait_for(() => process.socket_ready, "the rpe to connect", {
					process
				})
				await process.wait_for_labels(10_000)

				return { process }
			}

			async function stop(process: AnyProcess): Promise<void> {
				await vscode.commands.executeCommand("renpyWarp.killAll")
				await wait_for(() => process.dead, "the game to die")
				await wait_for(
					() => renpy_sessions().length === 0,
					"the session to terminate"
				)
			}

			test("next_checkpoint skips every pause in a dialogue block", async () => {
				const { process } = await debugging()

				try {
					await process.jump_to_label("pauses")
					await wait_for(
						() => process.last_cursor !== undefined,
						"ren'py to report the paused line",
						{ process }
					)
					const paused_line = process.last_cursor!.line

					await process.next_checkpoint()

					await wait_for(
						() => process.last_cursor?.line !== paused_line,
						"ren'py to move past the paused line",
						{ process }
					)
					assert.strictEqual(
						process.last_cursor?.what,
						"After the pauses.",
						"next_checkpoint stopped inside the pause block"
					)
				} finally {
					await stop(process)
				}
			})

			test("rollback rolls back to the previous checkpoint", async () => {
				const { process } = await debugging()

				try {
					await process.jump_to_label("start")
					await wait_for(
						() => process.last_cursor?.line === 5,
						"ren'py to report script.rpy:5",
						{ process }
					)

					await process.advance()
					await wait_for(
						() => process.last_cursor?.line === 7,
						"ren'py to report script.rpy:7",
						{ process }
					)

					await process.rollback()
					await wait_for(
						() => process.last_cursor?.line === 5,
						"ren'py to roll back to script.rpy:5",
						{ process }
					)
				} finally {
					await stop(process)
				}
			})

			test("Step Into advances to the next checkpoint", async () => {
				const { process } = await debugging()

				try {
					await process.jump_to_label("pauses")
					await wait_for(
						() => process.last_cursor !== undefined,
						"ren'py to report the paused line",
						{ process }
					)
					const paused_line = process.last_cursor!.line

					const session = vscode.debug.activeDebugSession
					assert.strictEqual(session?.type, "renpyWarp")
					await session.customRequest("stepIn")

					await wait_for(
						() => process.last_cursor?.line !== paused_line,
						"ren'py to move past the paused line",
						{ process }
					)
					assert.strictEqual(
						process.last_cursor?.what,
						"After the pauses.",
						"stepIn stopped inside the pause block"
					)
				} finally {
					await stop(process)
				}
			})

			test("debug toolbar's Step Out rolls back to the previous checkpoint", async () => {
				const { process } = await debugging()

				try {
					await process.jump_to_label("start")
					await wait_for(
						() => process.last_cursor?.line === 5,
						"ren'py to report script.rpy:5",
						{ process }
					)

					await process.advance()
					await wait_for(
						() => process.last_cursor?.line === 7,
						"ren'py to report script.rpy:7",
						{ process }
					)

					const session = vscode.debug.activeDebugSession
					assert.strictEqual(session?.type, "renpyWarp")
					await session.customRequest("stepOut")

					await wait_for(
						() => process.last_cursor?.line === 5,
						"ren'py to roll back to script.rpy:5",
						{ process }
					)
				} finally {
					await stop(process)
				}
			})

			test("evaluates an expression typed into the debug console", async () => {
				const { process } = await debugging()

				try {
					const session = vscode.debug.activeDebugSession
					assert.strictEqual(session?.type, "renpyWarp")

					const result = await session.customRequest("evaluate", {
						expression: "1 + 1",
						context: "repl"
					})

					assert.strictEqual(result.result, "2")
				} finally {
					await stop(process)
				}
			})

			test("reports a console error without killing the session", async () => {
				const { process } = await debugging()

				try {
					const session = vscode.debug.activeDebugSession
					assert.strictEqual(session?.type, "renpyWarp")

					await assert.rejects(
						Promise.resolve(
							session.customRequest("evaluate", {
								expression: "1 / 0",
								context: "repl"
							})
						)
					)

					// the session survived the error, so a follow-up command still
					// reaches the same running process
					const result = await session.customRequest("evaluate", {
						expression: "1 + 1",
						context: "repl"
					})
					assert.strictEqual(result.result, "2")
				} finally {
					await stop(process)
				}
			})

			test("_return re-enables stepping immediately, without waiting on dialogue", async () => {
				const { process } = await debugging()
				const changes: boolean[] = []
				process.on("canStepChange", (can_step: boolean) =>
					changes.push(can_step)
				)

				try {
					await process.jump_to_label("start")
					await wait_for(
						() => process.last_cursor?.line === 5,
						"ren'py to report script.rpy:5",
						{ process }
					)

					await process.jump_to_label("_simulate_menu")
					await wait_for(
						() => changes.includes(false),
						"can_step to turn off while paused"
					)

					const before_return = changes.length

					// releases the `pause`, letting `_simulate_menu` reach
					// `jump _return`. nothing said afterwards would trigger a
					// current_line message, so a change here can only have
					// come from the `_return` label itself
					await process.advance()

					await wait_for(
						() => changes.length > before_return,
						"a can_step change following _return"
					)
					assert.strictEqual(
						changes[before_return],
						true,
						"_return did not immediately re-enable stepping"
					)
				} finally {
					await stop(process)
				}
			})
		})

		suite("external processes", function () {
			this.timeout(30_000)

			suiteSetup(async () => {
				await update_config({
					renpyExtensionsEnabled: "Enabled",
					autoConnectExternalProcesses: "Always connect"
				})
			})

			suiteTeardown(async () => {
				await vscode.commands.executeCommand("renpyWarp.killAll")

				await update_config({
					renpyExtensionsEnabled: "Disabled",
					autoConnectExternalProcesses: "Never connect"
				})
			})

			test("gives a process it did not launch a session", async () => {
				assert.strictEqual(api.pm.length, 0)

				const launched = await api.launch_unmanaged()
				assert.ok(launched, "process did not launch")

				await wait_for(
					() => api.pm.length === 1,
					"the process to be discovered"
				)
				const discovered = api.pm.at(0)!

				await wait_for(
					() => session_for(discovered.pid) !== undefined,
					"the attach session to start",
					{ process: discovered }
				)

				// vscode disconnects an attach session rather than terminating
				// it, so the game lives on and only stops being tracked
				await vscode.debug.stopDebugging(session_for(discovered.pid))

				await wait_for(() => api.pm.length === 0, "the process to be dropped", {
					process: discovered
				})
				assert.strictEqual(discovered.dead, false, "the game was killed")

				// the socket server denies a process it was told to forget, so
				// it does not come back when the rpe reconnects
				await sleep(1500)
				assert.strictEqual(api.pm.length, 0, "the process was adopted again")

				await launched.kill()
				await (launched as ManagedProcess).wait_for_exit()
				launched.dispose()
			})
		})
	})
})
