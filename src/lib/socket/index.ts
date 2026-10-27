import * as vscode from "vscode"

import { get_logger } from "../log"
import { createServer, Server } from "node:net"
import { userInfo } from "node:os"
import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises"
import {
	AnyProcess,
	ManagedProcess,
	ProcessManager,
	UnmanagedProcess
} from "../process"
import { StatusBar } from "../status_bar"
import { prompt_install_rpe, get_rpe_checksum } from "../rpe"
import path from "upath"
import { get_config, set_config } from "../config"
import { find_projects_in_workspaces } from "../path"
import { FollowCursorService, sync_editor_with_renpy } from "../follow_cursor"
import { get_executable, process_finished } from "../sh"
import { get_sdk_path } from "../sdk"
import { said_range } from "../dialogue"
import { get_ipc_dir, get_ipc_path, WarpConnection } from "./connection"

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

/** the first frame an rpe sends, describing itself */
export interface HelloSocketMessage extends SocketMessage {
	type: "hello"
	pid: number
	project_root: string
	version: string
	checksum?: string
	nonce?: number
}

export type AnySocketMessage =
	| CurrentLineSocketMessage
	| ListLabelsSocketMessage
	| CurrentLabelSocketMessage
	| ConsoleResultSocketMessage

/** connection details a client presents in its hello */
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

/**
 * refuses a directory another user could have planted, and closes one this
 * user left open to others
 */
async function ensure_private_dir(dir: string): Promise<void> {
	const stats = await lstat(dir)

	if (!stats.isDirectory() || stats.uid !== userInfo().uid) {
		throw new Error(`${dir} is not a directory owned by this user`)
	}

	if (stats.mode & 0o077) await chmod(dir, 0o700)
}

/** removes sockets left behind by windows that died without closing them */
async function sweep_stale_sockets(dir: string): Promise<void> {
	const names = await readdir(dir).catch(() => [])

	await Promise.all(
		names.map(async (name) => {
			const pid = Number(path.basename(name, ".sock"))
			if (!name.endsWith(".sock") || !Number.isInteger(pid)) return
			if (pid === process.pid || !(await process_finished(pid))) return

			logger.debug(`removing stale socket ${name}`)
			await rm(path.join(dir, name), { force: true })
		})
	)
}

export class WarpSocketService {
	private context: vscode.ExtensionContext
	private socket_server?: Server
	private connections = new Set<WarpConnection>()
	private message_handler: MessageHandler

	private pm: ProcessManager
	private status_bar: StatusBar

	public readonly ipc_path = get_ipc_path()

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

		const socket_server = createServer((socket) => {
			logger.debug("socket server received a connection")
			this.handle_connection(new WarpConnection(socket))
		})
		this.socket_server = socket_server

		// windows pipes live in their own namespace, so only unix has files to
		// manage. the directory is private to this user
		if (process.platform !== "win32") {
			try {
				const dir = get_ipc_dir()
				await mkdir(dir, { recursive: true, mode: 0o700 })
				await ensure_private_dir(dir)
				await sweep_stale_sockets(dir)
				await rm(this.ipc_path, { force: true })
			} catch (error) {
				this.socket_server = undefined
				throw error
			}
		}

		socket_server.on("close", () => {
			logger.info("socket server closed")

			this.socket_server = undefined
			this.status_bar.notify(`$(server-process) Socket server closed`)

			this.deny_processes.clear()
			this.allowed_processes.clear()
			this.pm.disconnect_all()
			this.status_bar.update(() => ({ socket_server_status: "stopped" }))
			vscode.commands.executeCommand(
				"setContext",
				"renpyWarp.socketServerRunning",
				false
			)
		})

		socket_server.on("error", (error) => {
			logger.error("socket server error:", error)

			vscode.window
				.showErrorMessage("Failed to start socket server.", "Logs", "OK")
				.then((selection) => {
					if (selection === "Logs") {
						logger.show()
					}
				})
			this.close()
		})

		socket_server.listen(this.ipc_path, () => {
			logger.info(`socket server listening on ${this.ipc_path}`)
			this.status_bar.notify(`$(server-process) Socket server listening`)
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

	public forget(pid: number): void {
		logger.info(`forgetting process ${pid}`)

		this.allowed_processes.delete(pid)
		this.deny_processes.add(pid)

		this.pm.find_by_pid(pid)?.socket?.close({ reconnect: false })
	}

	public close() {
		if (this.socket_server) {
			logger.info("stopping socket server")

			// the server only emits "close" once every connection has gone
			for (const connection of this.connections) connection.close()
			this.socket_server.close()
		}
	}

	public dispose() {
		this.close()
	}

	/** waits for a connection's hello, then admits or turns it away */
	private handle_connection(connection: WarpConnection) {
		this.connections.add(connection)
		connection.on("close", () => this.connections.delete(connection))
		connection.on("error", (error) => {
			logger.error("socket connection error:", error)
		})

		const timeout = setTimeout(() => {
			logger.info("closing a connection that never said hello")
			connection.close()
		}, 5000)

		connection.once("message", (message: SocketMessage) => {
			clearTimeout(timeout)

			if (message.type !== "hello") {
				logger.info(`expected hello, got '${message.type}'`)
				connection.close()
				return
			}

			logger.debug("socket server received hello", JSON.stringify(message))

			this.handle_handshake(message as HelloSocketMessage)
				.then(async (client) => {
					if (!client) {
						connection.close()
						return
					}

					// the rpe can hang up while a prompt waits on the user
					if (!connection.open) return

					this.handle_socket_connection(connection, client)
					await connection.send({ type: "welcome" })
				})
				.catch((error) => {
					logger.error("socket handshake failed:", error)

					// the rpe blocks until it hears back, so it needs a hang up
					connection.close()
				})
		})
	}

	/** the process this extension launched under `nonce`, if there is one */
	private get_managed_process(nonce?: number): ManagedProcess | undefined {
		const rpp = nonce === undefined ? undefined : this.pm.get(nonce)

		return rpp instanceof ManagedProcess ? rpp : undefined
	}

	private handle_socket_connection(
		connection: WarpConnection,
		{ pid, nonce, project_root }: SocketClient
	) {
		const managed = this.get_managed_process(nonce)

		if (managed) {
			logger.info(
				`socket server discovered managed process ${managed.pid} with nonce ${nonce}`
			)
		}

		const rpp =
			managed ??
			this.handle_unmanaged_process({ pid, project_root, connection })

		// a new process is constructed holding `connection` already, so this
		// replaces a socket only where the process was reconnecting over an
		// older one
		if (rpp.socket !== connection) {
			if (rpp.socket) {
				logger.warn(`replacing existing socket for pid ${rpp.pid}`)
				rpp.socket.close({ reconnect: false })
			}

			rpp.socket = connection
		}

		connection.on("message", async (message: SocketMessage) => {
			logger.debug(`socket (${rpp.pid}) <`, JSON.stringify(message))

			rpp.emit("socketMessage", message)
			await this.message_handler(rpp, message)
		})

		connection.on("close", () => {
			logger.info(`socket connection closed (pid ${rpp.pid})`)

			// a replaced connection closes after its successor moved in
			if (rpp.socket === connection) rpp.socket = undefined
		})
	}

	/** vets a hello, resolving with the client if it may connect */
	private async handle_handshake(
		hello: HelloSocketMessage
	): Promise<SocketClient | undefined> {
		const socket_version = hello.version
		const socket_checksum = hello.checksum
		const socket_nonce =
			hello.nonce === undefined ? undefined : Number(hello.nonce)
		const socket_pid = Number(hello.pid)
		const socket_project_root = String(hello.project_root)

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
					const sdk_path = await get_sdk_path(
						this.context,
						true,
						socket_project_root
					)
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
		connection
	}: {
		pid: number
		project_root: string
		connection: WarpConnection
	}): AnyProcess {
		logger.info(`socket server discovered unmanaged process ${pid}`)

		const existing = this.pm.get(pid)

		if (existing) {
			logger.info("has existing process, reusing it")

			return existing
		}

		logger.info("creating new unmanaged process")

		const rpp = new UnmanagedProcess({ pid, project_root, socket: connection })

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
