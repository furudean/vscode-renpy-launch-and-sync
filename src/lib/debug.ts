import * as vscode from "vscode"
import path from "upath"
import {
	ContinuedEvent,
	DebugSession,
	ErrorDestination,
	ExitedEvent,
	InitializedEvent,
	OutputEvent,
	StoppedEvent,
	TerminatedEvent,
	Thread
} from "@vscode/debugadapter"
import { DebugProtocol } from "@vscode/debugprotocol"

import { AnyProcess, ManagedProcess, ProcessManager } from "./process"
import { CurrentLineSocketMessage, WarpSocketService } from "./socket"
import { StatusBar } from "./status_bar"
import { launch_renpy, warp_game } from "./launch"
import { find_project_root } from "./sh"
import {
	find_projects_in_workspaces,
	path_exists,
	prompt_projects_in_workspaces
} from "./path"
import {
	get_statements,
	next_resting_statement,
	warp_refusal,
	warp_target
} from "./script"
import { resolve_sdk_reference } from "./sdk"
import { get_logger } from "./log"

const logger = get_logger()

const THREAD_ID = 1

/**
 * the debugger this extension contributes. the Ren'Py Language extension
 * already owns `renpy`, so the two coexist under different types
 */
export const DEBUG_TYPE = "renpyWarp"

export interface RenpyDebugConfiguration extends vscode.DebugConfiguration {
	/** path to the project root, the directory holding `game/` */
	project?: string
	/** script to open at, absolute or relative to `project` */
	file?: string
	/** 1-indexed line in `file`, a string when it came from `${lineNumber}` */
	line?: number | string
	/** extra arguments for the ren'py command line */
	args?: string[]
	/** extra environment for the ren'py process */
	env?: Record<string, string>
	/** sdk to run with, as a managed version name or a path */
	sdk?: string
	/** pid of a tracked process, for `attach` */
	pid?: number
	/** zero-indexed line to warp to, resolved from `file` and `line` */
	_warp_line?: number
	/** progress notification wording, when a command had something to say */
	_intent?: string
	/** sdk path, resolved from `sdk` */
	_sdk_path?: string
	/** identifies the session `start_renpy` is waiting on, among concurrent launches */
	_launch_nonce?: number
}

interface DebugSessionDeps {
	context: vscode.ExtensionContext
	pm: ProcessManager
	status_bar: StatusBar
	wss: WarpSocketService
}

/**
 * validates and fills in a launch configuration before it reaches the adapter.
 * returning undefined cancels the session without opening launch.json
 */
export class RenpyDebugConfigurationProvider
	implements vscode.DebugConfigurationProvider
{
	private context: vscode.ExtensionContext
	private pm: ProcessManager

	constructor(context: vscode.ExtensionContext, pm: ProcessManager) {
		this.context = context
		this.pm = pm
	}

	async resolveDebugConfiguration(
		folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration
	): Promise<vscode.DebugConfiguration> {
		// bare f5 with no launch.json. start the project rather than warping to
		// the cursor, which the dynamic configuration and the commands cover
		if (!config.type && !config.request && !config.name) {
			const projects = await find_projects_in_workspaces()

			return {
				type: DEBUG_TYPE,
				request: "launch",
				name:
					projects.length === 1
						? `Launch project '${path.basename(projects[0])}'`
						: "Launch Ren'Py project",
				project:
					projects.length === 1 ? as_workspace_relative(projects[0]) : undefined
			}
		}

		return config
	}

	async resolveDebugConfigurationWithSubstitutedVariables(
		folder: vscode.WorkspaceFolder | undefined,
		config: RenpyDebugConfiguration
	): Promise<RenpyDebugConfiguration | undefined> {
		return config.request === "attach"
			? this.resolve_attach(config)
			: this.resolve_launch(folder, config)
	}

	private resolve_attach(
		config: RenpyDebugConfiguration
	): RenpyDebugConfiguration | undefined {
		const rpp =
			typeof config.pid === "number"
				? this.pm.find_by_pid(config.pid)
				: undefined

		if (!rpp) {
			vscode.window.showErrorMessage(
				`No tracked Ren'Py process with pid ${config.pid}`,
				"OK"
			)
			return undefined
		}

		if (rpp.debug_session_id !== undefined) {
			logger.warn(
				`Ren'Py process with pid ${config.pid} already has an active debug session`
			)
			return undefined
		}

		return config
	}

	private async resolve_launch(
		folder: vscode.WorkspaceFolder | undefined,
		config: RenpyDebugConfiguration
	): Promise<RenpyDebugConfiguration | undefined> {
		let line: number | undefined

		if (config.line !== undefined) {
			// `${lineNumber}` substitutes to a string
			line = Number(config.line)

			if (!Number.isInteger(line)) {
				show_invalid_config_error(
					folder,
					config.name,
					`'line' must be a whole number, but was '${config.line}'`
				)
				return undefined
			}
		}

		let project = config.project
		let file = config.file

		if (project && !path.isAbsolute(project)) {
			project = path.resolve(folder?.uri.fsPath ?? "", project)
		}

		if (project && !(await path_exists(path.join(project, "game")))) {
			show_invalid_config_error(
				folder,
				config.name,
				`${project} is not a Ren'Py project. A project is a directory holding a 'game' directory`
			)
			return undefined
		}

		if (file && !path.isAbsolute(file)) {
			file = path.resolve(project ?? folder?.uri.fsPath ?? "", file)
		}

		if (!project && file) {
			project = find_project_root(file) ?? undefined

			if (!project) {
				show_invalid_config_error(
					folder,
					config.name,
					`${path.basename(file)} is not inside a Ren'Py project. A project is a directory holding a 'game' directory`
				)
				return undefined
			}
		}

		if (!project) {
			project = await prompt_projects_in_workspaces(this.context)
			if (!project) return undefined
		}

		let sdk_path = config._sdk_path

		if (config.sdk && sdk_path === undefined) {
			// resolving here rather than at spawn means a missing sdk is picked
			// or refused before the session reaches the Run view
			sdk_path = await resolve_sdk_reference(config.sdk, this.context)
			if (!sdk_path) return undefined
		}

		// a command resolves its own target, so that its refusal message can
		// name the statement in the way. only a hand-written configuration
		// reaches here needing one
		if (file && config._warp_line === undefined) {
			const document = await vscode.workspace.openTextDocument(file)
			const statements = get_statements(document)

			if (line === undefined) {
				// the top of a file is rarely a statement, so start at the first
				// one the game comes to rest on
				const target = next_resting_statement(statements, 0)

				if (target === undefined) {
					vscode.window.showErrorMessage(
						"There is nothing to start at in this file, as it holds no statements Ren'Py can play",
						"OK"
					)
					return undefined
				}

				config._warp_line = target.warp_line
			} else {
				const target = warp_target(statements, line - 1)

				if (!target?.warpable) {
					vscode.window.showErrorMessage(warp_refusal(target, line - 1), "OK")
					return undefined
				}

				config._warp_line = target.warp_line
			}
		}

		return { ...config, project, file, _sdk_path: sdk_path }
	}
}

function show_invalid_config_error(
	folder: vscode.WorkspaceFolder | undefined,
	name: string | undefined,
	message: string
): void {
	void vscode.window
		.showErrorMessage(message, "Edit Configuration", "OK")
		.then((selection) => {
			if (selection === "Edit Configuration") {
				void reveal_launch_config(folder, name)
			}
		})
}

/** opens launch.json and, when it can find the entry, selects it */
async function reveal_launch_config(
	folder: vscode.WorkspaceFolder | undefined,
	name: string | undefined
): Promise<void> {
	const workspace_folder = folder ?? vscode.workspace.workspaceFolders?.[0]
	if (!workspace_folder) return

	const launch_json = vscode.Uri.joinPath(
		workspace_folder.uri,
		".vscode",
		"launch.json"
	)

	if (!(await path_exists(launch_json.fsPath))) return

	const document = await vscode.workspace.openTextDocument(launch_json)
	const editor = await vscode.window.showTextDocument(document)

	if (!name) return

	const escaped_name = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const match = new RegExp(`"name"\\s*:\\s*"${escaped_name}"`).exec(
		document.getText()
	)
	if (!match) return

	const start = document.positionAt(match.index)
	const end = document.positionAt(match.index + match[0].length)
	editor.selection = new vscode.Selection(start, end)
	editor.revealRange(
		new vscode.Range(start, end),
		vscode.TextEditorRevealType.InCenter
	)
}

function as_workspace_relative(project: string): string {
	const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project))
	if (!folder) return project

	const multi_root = (vscode.workspace.workspaceFolders?.length ?? 0) > 1
	const variable = multi_root
		? `\${workspaceFolder:${folder.name}}`
		: "${workspaceFolder}"

	const relative = path.relative(folder.uri.fsPath, project)
	return relative ? `${variable}/${relative}` : variable
}

/** the entries offered in the Run and Debug view when there is no launch.json */
export class RenpyDynamicDebugConfigurationProvider
	implements vscode.DebugConfigurationProvider
{
	async provideDebugConfigurations(): Promise<vscode.DebugConfiguration[]> {
		const projects = await find_projects_in_workspaces()

		const configurations: RenpyDebugConfiguration[] = projects.map(
			(project) => ({
				type: DEBUG_TYPE,
				request: "launch",
				name: `Launch ${path.basename(project)}`,
				project: as_workspace_relative(project)
			})
		)

		const editor = vscode.window.activeTextEditor

		if (editor?.document.uri.fsPath.endsWith(".rpy")) {
			configurations.push({
				type: DEBUG_TYPE,
				request: "launch",
				name: "Open Ren'Py at current line",
				file: "${file}",
				line: "${lineNumber}"
			})
		}

		return configurations
	}
}

class RenpyDebugAdapterDescriptorFactory
	implements vscode.DebugAdapterDescriptorFactory
{
	private deps: DebugSessionDeps

	constructor(deps: DebugSessionDeps) {
		this.deps = deps
	}

	createDebugAdapterDescriptor(
		session: vscode.DebugSession
	): vscode.DebugAdapterDescriptor {
		return new vscode.DebugAdapterInlineImplementation(
			new RenpyDebugSession({ ...this.deps, session })
		)
	}
}

/**
 * mirrors one process in `pm` as a debug session. it never owns the process,
 * so `pm` stays the source of truth for everything else the extension does
 * with it.
 */
export class RenpyDebugSession extends DebugSession {
	private context: vscode.ExtensionContext
	private pm: ProcessManager
	private status_bar: StatusBar
	private wss: WarpSocketService
	private session: vscode.DebugSession

	private rpp?: AnyProcess
	private request: "launch" | "attach" = "launch"
	private unbind: (() => void)[] = []
	/** set once `rpp` has told us it's gone, real death or a manager clear */
	private rpp_exited = false

	constructor({
		context,
		pm,
		status_bar,
		wss,
		session
	}: DebugSessionDeps & { session: vscode.DebugSession }) {
		super()

		this.context = context
		this.pm = pm
		this.status_bar = status_bar
		this.wss = wss
		this.session = session
	}

	protected initializeRequest(
		response: DebugProtocol.InitializeResponse
	): void {
		response.body = {
			...response.body,
			supportsConfigurationDoneRequest: true,
			supportsTerminateRequest: true,
			supportTerminateDebuggee: true,
			supportsRestartRequest: true
		}

		this.sendResponse(response)
		this.sendEvent(new InitializedEvent())
	}

	protected configurationDoneRequest(
		response: DebugProtocol.ConfigurationDoneResponse
	): void {
		this.sendResponse(response)
	}

	protected async launchRequest(
		response: DebugProtocol.LaunchResponse
	): Promise<void> {
		this.request = "launch"
		await this.launch(response)
	}

	protected async restartRequest(
		response: DebugProtocol.RestartResponse
	): Promise<void> {
		if (this.request !== "launch") {
			this.sendResponse(response)
			return
		}

		const old_rpp = this.rpp
		const last_cursor = old_rpp?.last_cursor

		if (old_rpp) {
			this.cleanup()
			this.rpp = undefined
			this.rpp_exited = false

			await old_rpp.kill().catch((error) => logger.error(error as Error))
		}

		await this.launch(response, last_cursor)
	}

	private async launch(
		response: DebugProtocol.Response,
		warp_to?: CurrentLineSocketMessage
	): Promise<void> {
		const config = this.session.configuration as RenpyDebugConfiguration
		let rpp: ManagedProcess | undefined

		try {
			rpp = await launch_renpy({
				intent: config._intent,
				context: this.context,
				pm: this.pm,
				wss: this.wss,
				project_root: config.project,
				sdk_path: config._sdk_path,
				// a restart with somewhere to come back to takes precedence over
				// the configuration's original target
				file: warp_to?.path ?? config.file,
				line: warp_to ? warp_to.line - 1 : config._warp_line,
				command: config.args?.length ? config.args : undefined,
				extra_environment: config.env,
				debug_session_id: this.session.id
			})
		} catch (error) {
			logger.error(error as Error)
			this.sendErrorResponse(response, 1001, String(error))
			this.sendEvent(new TerminatedEvent())
			return
		}

		if (!rpp) {
			// a cancelled prompt or a process that died at spawn. launch_renpy
			// has already said whatever there was to say
			this.sendResponse(response)
			this.sendEvent(new TerminatedEvent())
			return
		}

		this.bind(rpp)
		this.sendResponse(response)
	}

	protected attachRequest(response: DebugProtocol.AttachResponse): void {
		this.request = "attach"

		const { pid } = this.session.configuration as RenpyDebugConfiguration
		const rpp = pid === undefined ? undefined : this.pm.find_by_pid(pid)

		if (!rpp) {
			this.sendErrorResponse(
				response,
				1002,
				`No tracked Ren'Py process with pid ${pid}`
			)
			this.sendEvent(new TerminatedEvent())
			return
		}

		this.bind(rpp)
		this.sendResponse(response)
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = { threads: [new Thread(THREAD_ID, "Ren'Py")] }
		this.sendResponse(response)
	}

	protected async disconnectRequest(
		response: DebugProtocol.DisconnectResponse,
		args: DebugProtocol.DisconnectArguments
	): Promise<void> {
		const rpp = this.rpp

		try {
			if (!rpp) {
				// nothing ever bound
			} else if (this.request === "attach" && args.restart) {
				// vscode attaches again with the same pid, so the process only
				// has to come free of this session for that bind to succeed
				rpp.debug_session_id = undefined
			} else if (
				!this.rpp_exited &&
				(args.terminateDebuggee ?? this.request === "launch")
			) {
				await rpp.kill()
			} else if (!this.rpp_exited) {
				this.forget(rpp)
			}
		} catch (error) {
			logger.error(error as Error)
		}

		this.sendResponse(response)
		this.cleanup()
	}

	protected async terminateRequest(
		response: DebugProtocol.TerminateResponse
	): Promise<void> {
		const rpp = this.rpp

		try {
			if (rpp && !this.rpp_exited) {
				// a launched process is ours to kill; an attached one outlives us
				if (this.request === "launch") {
					await rpp.kill()
				} else {
					this.forget(rpp)
				}
			}
		} catch (error) {
			logger.error(error as Error)
		}

		this.sendResponse(response)
		this.cleanup()
	}

	protected async evaluateRequest(
		response: DebugProtocol.EvaluateResponse,
		args: DebugProtocol.EvaluateArguments
	): Promise<void> {
		if (args.context !== "repl" || !this.rpp || this.rpp_exited) {
			this.sendErrorResponse(
				response,
				1003,
				"Not connected to process",
				undefined,
				ErrorDestination.Telemetry // telemetry destination does not nag user when errors happen
			)
			return
		}

		try {
			const { text, is_error } = await this.rpp.console(args.expression)

			if (is_error) {
				this.sendErrorResponse(
					response,
					1006,
					text,
					undefined,
					ErrorDestination.Telemetry
				)
				return
			}

			response.body = { result: text, variablesReference: 0 }
			this.sendResponse(response)
		} catch (error) {
			logger.error(error as Error)
			this.sendErrorResponse(
				response,
				1006,
				String(error),
				undefined,
				ErrorDestination.Telemetry
			)
		}
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse): void {
		// treat as a no-op
		this.sendResponse(response)
	}

	protected async continueRequest(
		response: DebugProtocol.ContinueResponse
	): Promise<void> {
		await this.checkpoint_step(response, "advance")
	}

	protected nextRequest(response: DebugProtocol.NextResponse): void {
		// TODO: implement breakpoints
		// no-op for now
		this.sendResponse(response)
		this.sendEvent(new StoppedEvent("step", THREAD_ID))
	}

	protected async stepInRequest(
		response: DebugProtocol.StepInResponse
	): Promise<void> {
		await this.checkpoint_step(response, "next_checkpoint")
	}

	protected async stepOutRequest(
		response: DebugProtocol.StepOutResponse
	): Promise<void> {
		await this.checkpoint_step(response, "rollback")
	}

	private async checkpoint_step(
		response: DebugProtocol.Response,
		action: "advance" | "next_checkpoint" | "rollback"
	): Promise<void> {
		if (this.rpp && !this.rpp_exited) {
			try {
				await this.rpp[action]()
			} catch (error) {
				logger.error(error as Error)
			}
		}

		this.sendResponse(response)
		this.sendEvent(new StoppedEvent("step", THREAD_ID))
	}

	private bind(rpp: AnyProcess): void {
		this.rpp = rpp
		rpp.debug_session_id = this.session.id

		this.console(`Ren'Py pid ${rpp.pid} (${rpp.project_root})`)
		this.console("Connected to Ren'Py console. Type help to list commands.")

		// the debug toolbar's step buttons are only enabled while vscode
		// considers the thread stopped, so `can_step` has to drive that state
		// the same way it drives the editor-title step buttons
		const on_can_step_change = (can_step: boolean) => {
			this.sendEvent(
				can_step
					? new StoppedEvent("step", THREAD_ID)
					: new ContinuedEvent(THREAD_ID)
			)
		}

		if (rpp.can_step) this.sendEvent(new StoppedEvent("entry", THREAD_ID))

		rpp.on("canStepChange", on_can_step_change)
		this.unbind.push(() => rpp.off("canStepChange", on_can_step_change))

		if (rpp instanceof ManagedProcess) {
			// the console is the only place process output goes, so replay what
			// the game wrote between spawning and binding before streaming
			for (const line of rpp.take_output_backlog()) {
				this.sendEvent(new OutputEvent(line + "\n", "stdout"))
			}

			const on_output = (line: string) => {
				this.sendEvent(new OutputEvent(line + "\n", "stdout"))
			}

			rpp.on("output", on_output)
			this.unbind.push(() => rpp.off("output", on_output))
		}

		const on_exit = () => {
			this.rpp_exited = true

			if (!rpp.dead) {
				// a synthetic exit from `forget()` detaching a process that is
				// still running, not a real death
				this.console("process detached")
			} else if (rpp instanceof ManagedProcess) {
				this.console(`process exited with code ${rpp.exit_code}`)
				this.sendEvent(new ExitedEvent(rpp.exit_code ?? 0))
			} else {
				this.console("process exited")
			}

			this.sendEvent(new TerminatedEvent())
		}

		rpp.once("exit", on_exit)
		this.unbind.push(() => rpp.off("exit", on_exit))
	}

	private forget(rpp: AnyProcess): void {
		this.wss.forget(rpp.pid)

		// everything watching the process — decorations, follow cursor, the
		// status bar, `pm` — lets go of it the way it would on a real exit
		rpp.emit("exit")

		this.pm.forget(rpp)
		rpp.dispose()
	}

	private console(text: string): void {
		this.sendEvent(new OutputEvent(text + "\n", "console"))
	}

	private cleanup(): void {
		for (const off of this.unbind) off()
		this.unbind = []
	}
}

const QUIET_SESSION: vscode.DebugSessionOptions = {
	suppressDebugView: true,
	suppressDebugStatusbar: true,
	suppressSaveBeforeStart: true
}

interface StartRenpyOptions {
	pm: ProcessManager
	status_bar: StatusBar
	/** progress notification wording while the game starts */
	intent?: string
	/** fs path of the script to open at */
	file?: string
	/** zero-indexed line to warp to */
	line?: number
	/** project to run. detected from `file` or prompted for when unset */
	project_root?: string
	/** extra environment for the ren'py process */
	env?: Record<string, string>
}

/**
 * the way every command starts ren'py. a game is either already open and gets
 * warped, or it is started inside a debug session, so a tracked process is
 * never without one
 *
 * @returns
 * the process that ran, or undefined where nothing started
 */
export async function start_renpy({
	pm,
	status_bar,
	intent,
	file,
	line,
	project_root,
	env
}: StartRenpyOptions): Promise<AnyProcess | undefined> {
	const warped = await warp_game({
		pm,
		status_bar,
		file,
		line,
		project_root
	})
	if (warped) return warped

	const folder = project_root
		? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project_root))
		: vscode.workspace.workspaceFolders?.[0]

	const launch_nonce = Math.trunc(Math.random() * Number.MAX_SAFE_INTEGER)

	const configuration: RenpyDebugConfiguration = {
		type: DEBUG_TYPE,
		request: "launch",
		name: project_root ? `Ren'Py (${path.basename(project_root)})` : "Ren'Py",
		project: project_root,
		file,
		_warp_line: line,
		_intent: intent,
		_launch_nonce: launch_nonce,
		env
	}

	let session_id: string | undefined
	const on_start_session = (session: vscode.DebugSession) => {
		if (session.configuration._launch_nonce === launch_nonce) {
			session_id = session.id
		}
	}
	const start_session_sub =
		vscode.debug.onDidStartDebugSession(on_start_session)

	try {
		const ok = await vscode.debug.startDebugging(
			folder,
			configuration,
			QUIET_SESSION
		)
		if (!ok) return undefined
	} finally {
		start_session_sub.dispose()
	}

	// the session binds the process during its launch request, well before
	// `startDebugging` resolves - by now it's already sitting in `pm`
	// regardless of whether `onDidStartDebugSession` had fired yet
	if (!session_id) return undefined

	for (const rpp of pm) {
		if (rpp.debug_session_id === session_id) return rpp
	}

	return undefined
}

/** gives a process a debug session of its own unless it already has one */
async function attach_to(
	rpp: AnyProcess,
	pm: ProcessManager,
	wss: WarpSocketService
): Promise<void> {
	const folder = vscode.workspace.getWorkspaceFolder(
		vscode.Uri.file(rpp.project_root)
	)

	const configuration: RenpyDebugConfiguration = {
		type: DEBUG_TYPE,
		request: "attach",
		name: `Ren'Py (pid ${rpp.pid})`,
		pid: rpp.pid,
		internalConsoleOptions: "neverOpen"
	}

	function give_up(error?: unknown): void {
		logger.error(`could not start a debug session for pid ${rpp.pid}`, error)
		vscode.window.showErrorMessage(
			`Could not start a debug session for Ren'Py process ${rpp.pid}`,
			"OK"
		)
		wss.forget(rpp.pid)
		rpp.emit("exit")
		pm.forget(rpp)
		rpp.dispose()
	}

	try {
		const started = await vscode.debug.startDebugging(
			folder,
			configuration,
			QUIET_SESSION
		)

		if (!started) give_up()
	} catch (error) {
		give_up(error)
	}
}

/** @returns the configuration provider, for the e2e tests */
export function register_debugger(
	context: vscode.ExtensionContext,
	pm: ProcessManager,
	status_bar: StatusBar,
	wss: WarpSocketService
): RenpyDebugConfigurationProvider {
	const deps: DebugSessionDeps = { context, pm, status_bar, wss }
	const provider = new RenpyDebugConfigurationProvider(context, pm)

	// every process the extension tracks gets a session, whether a command
	// started it or the socket server adopted it. an f5 launch already carries
	// a session id by the time `pm` sees it, so it is skipped here
	const on_attach = (rpp: AnyProcess) => {
		if (rpp.debug_session_id) return

		attach_to(rpp, pm, wss)
	}
	pm.on("attach", on_attach)

	const dynamic_provider = new RenpyDynamicDebugConfigurationProvider()

	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, provider),
		vscode.debug.registerDebugConfigurationProvider(
			DEBUG_TYPE,
			dynamic_provider,
			vscode.DebugConfigurationProviderTriggerKind.Dynamic
		),
		vscode.debug.registerDebugConfigurationProvider(
			DEBUG_TYPE,
			dynamic_provider,
			vscode.DebugConfigurationProviderTriggerKind.Initial
		),
		vscode.debug.registerDebugAdapterDescriptorFactory(
			DEBUG_TYPE,
			new RenpyDebugAdapterDescriptorFactory(deps)
		),
		{ dispose: () => pm.off("attach", on_attach) }
	)

	return provider
}
