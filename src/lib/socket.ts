import * as vscode from "vscode"

import { get_logger } from "./log"
import WebSocket, { WebSocketServer } from "ws"
import {
	AnyProcess,
	ManagedProcess,
	ProcessManager,
	UnmanagedProcess
} from "./process"
import get_port from "get-port"
import { StatusBar } from "./status_bar"
import { prompt_install_rpe, get_rpe_checksum } from "./rpe"
import path from "upath"
import { get_config, set_config } from "./config"
import { createServer, IncomingMessage } from "node:http"
import { find_projects_in_workspaces } from "./path"
import { FollowCursorService, sync_editor_with_renpy } from "./follow_cursor"
import { get_executable } from "./sh"
import { get_sdk_path } from "./sdk"
import { said_range } from "./dialogue"

const logger = get_logger()

type MaybePromise<T> = T | Promise<T>

export interface SocketMessage {
	type: string
	[key: string]: unknown
}

export interface CurrentLineSocketMessage extends SocketMessage {
	type: "current_line"
	line: number
	path: string
	relative_path: string
	what?: string
	said_from?: number
	said_to?: number
}

export interface ListLabelsSocketMessage extends SocketMessage {
	type: "list_labels"
	labels: string[]
}

export interface CurrentLabelSocketMessage extends SocketMessage {
	type: "current_label"
	label: string
}

export interface ConsoleResultSocketMessage extends SocketMessage {
	type: "console_result"
	nonce: number
	text: string
	is_error: boolean
}

export type AnySocketMessage =
	| CurrentLineSocketMessage
	| ListLabelsSocketMessage
	| CurrentLabelSocketMessage
	| ConsoleResultSocketMessage

/** connection details a client presents during the websocket handshake */
export interface SocketClient {
	pid: number
	nonce?: number
	project_root: string
}

export type MessageHandler = (
	process: AnyProcess,
	data: SocketMessage
) => MaybePromise<void>

export function get_message_handler(follow_cursor: FollowCursorService) {
	return async function message_handler(
		process: AnyProcess,
		message: SocketMessage
	) {
		if (message.type !== "current_line") return

		logger.debug(
			`current line reported as ${message.relative_path}:${message.line}`
		)

		if (follow_cursor.active_process !== process) return

		if (
			!["Ren'Py updates Visual Studio Code", "Update both"].includes(
				get_config("followCursorMode") as string
			)
		)
			return

		await sync_editor_with_renpy({
			path: message.path as string,
			relative_path: message.relative_path as string,
			line: (message.line as number) - 1,
			what: typeof message.what === "string" ? message.what : undefined,
			said: said_range(message as CurrentLineSocketMessage),
			pid: process.pid
		})
	}
}

export class WarpSocketService {
	private context: vscode.ExtensionContext
	private socket_server?: WebSocketServer
	private message_handler: MessageHandler

	private pm: ProcessManager
	private status_bar: StatusBar

	public readonly ports = Object.freeze([
		40111, 40112, 40113, 40114, 40115, 40116, 40117, 40118, 40119, 40120
	])

	public deny_processes = new Set<number>()
	public allowed_processes = new Set<number>()

	constructor({
		message_handler,
		context,
		pm,
		status_bar
	}: {
		message_handler: MessageHandler
		context: vscode.ExtensionContext
		pm: ProcessManager
		status_bar: StatusBar
	}) {
		this.context = context
		this.pm = pm
		this.status_bar = status_bar
		this.message_handler = message_handler
	}

	public async start(): Promise<void> {
		if (this.socket_server) return

		const socket_server = new WebSocketServer({ noServer: true })
		this.socket_server = socket_server
		const http_server = createServer()
		const port = await this.get_socket_port()

		socket_server.on("close", () => {
			logger.info("socket server closed")

			this.socket_server = undefined
			this.status_bar.notify(`$(server-process) Socket server :${port} closed`)

			this.deny_processes.clear()
			this.allowed_processes.clear()
			// every tracked process goes down with the server, which ends the
			// debug sessions mirroring them
			this.pm.clear()
			this.status_bar.update(() => ({ socket_server_status: "stopped" }))
			vscode.commands.executeCommand(
				"setContext",
				"renpyWarp.socketServerRunning",
				false
			)
			http_server.close()
		})

		http_server.on("upgrade", (request, socket, head) => {
			logger.debug(
				`socket server ${port} received a connection request with headers ${JSON.stringify(
					request.headers
				)}`
			)
			socket.on("error", logger.error)

			this.handle_handshake(request)
				.then((client) => {
					if (!client) {
						socket.destroy()
						return
					}

					socket_server.handleUpgrade(request, socket, head, (ws) => {
						this.handle_socket_connection(ws, client)
					})
				})
				.catch(logger.error)
		})

		function handle_error(error: unknown) {
			logger.error("socket server error:", error)

			vscode.window
				.showErrorMessage("Failed to start websockets server.", "Logs", "OK")
				.then((selection) => {
					if (selection === "Logs") {
						logger.show()
					}
				})
			socket_server.close()
		}
		http_server.on("error", handle_error)
		socket_server.on("wsClientError", handle_error)

		http_server.listen(port, undefined, undefined, () => {
			logger.info(`socket server listening on :${port}`)
			this.status_bar.notify(
				`$(server-process) Socket server listening on :${port}`
			)
			this.status_bar.update(() => ({
				socket_server_status: "running"
			}))
			vscode.commands.executeCommand(
				"setContext",
				"renpyWarp.socketServerRunning",
				true
			)
		})
	}

	/**
	 * stops tracking a process and refuses it if it connects again. the
	 * handshake already turns away denied pids
	 */
	public forget(pid: number): void {
		logger.info(`forgetting process ${pid}`)

		this.allowed_processes.delete(pid)
		this.deny_processes.add(pid)

		this.pm.find_by_pid(pid)?.socket?.close(4001, "forgotten")
	}

	public close() {
		if (this.socket_server) {
			logger.info("stopping socket server")
			this.socket_server.close()
		}
	}

	private async get_socket_port(): Promise<number> {
		const port = await get_port({ port: this.ports })

		if (!this.ports.includes(port)) {
			throw new Error("exhausted all available ports")
		}

		return port
	}

	/** the process this extension launched under `nonce`, if there is one */
	private get_managed_process(nonce?: number): ManagedProcess | undefined {
		const rpp = nonce === undefined ? undefined : this.pm.get(nonce)

		return rpp instanceof ManagedProcess ? rpp : undefined
	}

	private handle_socket_connection(
		ws: WebSocket,
		{ pid, nonce, project_root }: SocketClient
	) {
		const managed = this.get_managed_process(nonce)

		if (managed) {
			logger.info(
				`socket server discovered managed process ${managed.pid} with nonce ${nonce}`
			)
		}

		const rpp =
			managed ?? this.handle_unmanaged_process({ pid, project_root, ws })

		// a new process is constructed holding `ws` already, so this replaces a
		// socket only where the process was reconnecting over an older one
		if (rpp.socket !== ws) {
			if (rpp.socket) {
				logger.warn(`replacing existing socket for pid ${rpp.pid}`)
				rpp.socket.close(4000, "connection replaced")
			}

			rpp.socket = ws
		}

		ws.on("message", async (data) => {
			logger.debug(`websocket (${rpp.pid}) <`, data.toString())
			const message = JSON.parse(data.toString())

			rpp.emit("socketMessage", message)
			await this.message_handler(rpp, message)
		})

		ws.on("close", () => {
			logger.info(`websocket connection closed (pid ${rpp.pid})`)
			rpp.socket = undefined
		})

		ws.on("error", (error) => {
			logger.error(`websocket error (pid ${rpp.pid})`, error)
		})
	}

	/** vets a connection request, resolving with the client if it may connect */
	private async handle_handshake(
		req: IncomingMessage
	): Promise<SocketClient | undefined> {
		const socket_version = req.headers["warp-version"]
		const socket_checksum = req.headers["warp-checksum"]
		const socket_nonce = req.headers["warp-nonce"]
			? Number(req.headers["warp-nonce"])
			: undefined
		const socket_pid = Number(req.headers["pid"])
		const socket_project_root = req.headers["warp-project-root"] as string

		const client: SocketClient = {
			pid: socket_pid,
			nonce: socket_nonce,
			project_root: socket_project_root
		}

		if (this.deny_processes.has(socket_pid)) {
			logger.debug(
				`ignoring connection request from pid ${socket_pid} as its in ack list`
			)
			return undefined
		}

		const [rpe_checksum, project_roots] = await Promise.all([
			get_rpe_checksum(this.context.extensionPath),
			find_projects_in_workspaces()
		])

		const matches_any_root = project_roots.some(
			(project_root) => path.relative(project_root, socket_project_root) === ""
		)

		if (!matches_any_root) {
			logger.info(
				`rejecting connection to socket because socket root '${socket_project_root}' does not match any ${project_roots
					.map((s) => `'${s}'`)
					.join(", ")}`
			)
			this.deny_processes.add(socket_pid)
			return undefined
		}

		if (socket_checksum !== rpe_checksum) {
			this.deny_processes.add(socket_pid)

			logger.info(
				`rpe checksum ${socket_version} does not match expected ${rpe_checksum}`
			)

			if (socket_checksum === undefined) {
				vscode.window.showErrorMessage(
					`Ren'Py extension reported no checksum. Ren'Py might have misbehaved.`,
					"Oh no"
				)
			} else {
				const picked = await vscode.window.showWarningMessage(
					`RPE in running Ren'Py process does not match extension. It may be out of date. Update?`,
					"Update",
					"Don't Update"
				)

				if (picked === "Update") {
					const sdk_path = await get_sdk_path()
					if (!sdk_path) return undefined

					const executable = await get_executable(sdk_path)
					if (!executable) return undefined

					await prompt_install_rpe({
						project: socket_project_root,
						context: this.context,
						executable,
						message:
							"Ren'Py extensions were updated. Please restart the game to connect.",
						force: true
					})
				}
			}

			return undefined
		}

		if (!this.get_managed_process(socket_nonce)) {
			const auto_connect_setting = get_config(
				"autoConnectExternalProcesses"
			) as string

			if (auto_connect_setting === "Ask") {
				if (this.allowed_processes.has(socket_pid)) return client

				const picked = await vscode.window.showInformationMessage(
					`A Ren'Py process wants to connect to this window`,
					"Connect",
					"Ignore",
					"Always connect",
					"Always ignore"
				)

				if (picked === "Connect") {
					this.allowed_processes.add(socket_pid)
				}
				if (picked === "Always connect") {
					await set_config("autoConnectExternalProcesses", "Always connect")
				}
				if (["Ignore", undefined].includes(picked)) {
					this.deny_processes.add(socket_pid)
					return undefined
				}
				if (picked === "Always ignore") {
					this.deny_processes.add(socket_pid)
					await set_config("autoConnectExternalProcesses", "Never connect")
				}
			} else if (auto_connect_setting === "Never connect") {
				this.deny_processes.add(socket_pid)
				return undefined
			}
		}

		return client
	}

	private handle_unmanaged_process({
		pid,
		project_root,
		ws
	}: {
		pid: number
		project_root: string
		ws: WebSocket
	}): AnyProcess {
		logger.info(`socket server discovered unmanaged process ${pid}`)

		const existing = this.pm.get(pid)

		if (existing) {
			logger.info("has existing process, reusing it")

			return existing
		}

		logger.info("creating new unmanaged process")

		const rpp = new UnmanagedProcess({ pid, project_root, socket: ws })

		rpp.on("exit", () => {
			logger.info(`external process ${pid} exited`)
		})

		this.pm.add(pid, rpp)

		if (this.context.globalState.get("hideExternalProcessConnected")) {
			this.status_bar.notify(`$(plug) Connected to Ren'Py process ${pid}`)
		} else {
			vscode.window
				.showInformationMessage(
					"Connected to external Ren'Py process",
					"OK",
					"Don't show again"
				)
				.then((selection) => {
					if (selection === "Don't show again") {
						this.context.globalState.update(
							"hideExternalProcessConnected",
							true
						)
					}
				})
		}

		return rpp
	}
}
