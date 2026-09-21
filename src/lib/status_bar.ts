import * as vscode from "vscode"
import path from "upath"
import { get_config } from "./config"
import { get_logger } from "./log"
import { find_project_root, get_executable, get_version } from "./sh"
import tildify from "tildify"
import { get_sdk_path, get_version_file_raw_value } from "./sdk"
import { is_explicit_path } from "./path"

const logger = get_logger()

export class StatusBar {
	private context: vscode.ExtensionContext
	private sdk_bar: vscode.StatusBarItem
	private instance_bar: vscode.StatusBarItem
	private follow_cursor_bar: vscode.StatusBarItem
	private notification_bar: vscode.StatusBarItem
	private subscriptions: vscode.Disposable[] = []

	private message_timeout: NodeJS.Timeout | undefined

	private state = {
		socket_server_status: "stopped" as "running" | "stopped",
		/** how many processes `pm` tracks, which is also how many sessions run */
		running_processes: 0,
		is_follow_cursor: false,
		message: undefined as string | undefined,
		message_level: undefined as number | undefined
	}

	constructor(context: vscode.ExtensionContext) {
		this.context = context

		this.instance_bar = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			0
		)

		this.follow_cursor_bar = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			0
		)

		this.sdk_bar = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			0
		)

		this.notification_bar = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			10_000
		)

		const update_status_bar_on_config_update =
			vscode.workspace.onDidChangeConfiguration(() => {
				this.update_status_bar().catch((err) =>
					logger.error("failed to update status bar:", err)
				)
			})

		const update_status_bar_on_active_editor_change =
			vscode.window.onDidChangeActiveTextEditor(() => {
				this.update_status_bar().catch((err) =>
					logger.error("failed to update status bar:", err)
				)
			})

		const update_status_bar_on_version_file_change = () => {
			this.update_status_bar().catch((err) =>
				logger.error("failed to update status bar:", err)
			)
		}

		const version_file_watchers = new Map<string, vscode.Disposable>()
		const sync_version_file_watchers = () => {
			const folders = vscode.workspace.workspaceFolders ?? []
			const seen = new Set(folders.map((f) => f.uri.toString()))

			for (const [key, disposable] of version_file_watchers) {
				if (!seen.has(key)) {
					disposable.dispose()
					version_file_watchers.delete(key)
				}
			}

			for (const folder of folders) {
				const key = folder.uri.toString()
				if (version_file_watchers.has(key)) continue

				const watcher = vscode.workspace.createFileSystemWatcher(
					new vscode.RelativePattern(folder, "**/.renpy-version")
				)
				watcher.onDidCreate(update_status_bar_on_version_file_change)
				watcher.onDidChange(update_status_bar_on_version_file_change)
				watcher.onDidDelete(update_status_bar_on_version_file_change)
				version_file_watchers.set(key, watcher)
			}
		}
		sync_version_file_watchers()

		const update_watchers_on_workspace_folders_change =
			vscode.workspace.onDidChangeWorkspaceFolders(sync_version_file_watchers)

		// the native watcher above can still lag by a beat, so react to an
		// in-editor save of the file itself immediately rather than waiting on it
		const update_status_bar_on_version_file_save =
			vscode.workspace.onDidSaveTextDocument((document) => {
				if (path.basename(document.uri.fsPath) === ".renpy-version") {
					update_status_bar_on_version_file_change()
				}
			})

		this.subscriptions.push(
			this.instance_bar,
			this.follow_cursor_bar,
			this.notification_bar,
			update_status_bar_on_config_update,
			update_status_bar_on_active_editor_change,
			update_watchers_on_workspace_folders_change,
			update_status_bar_on_version_file_save,
			{ dispose: () => version_file_watchers.forEach((w) => w.dispose()) }
		)

		this.update_status_bar().catch((err) =>
			logger.error("failed to update status bar:", err)
		)
	}

	update(fn: (state: typeof this.state) => Partial<typeof this.state>) {
		const incoming_state = fn(this.state)
		this.state = { ...this.state, ...incoming_state }

		if (incoming_state.message) {
			clearTimeout(this.message_timeout)

			this.message_timeout = setTimeout(() => {
				this.update(() => ({ message: undefined }))
			}, 5000)
		}

		logger.debug("status bar state:", this.state)

		this.update_status_bar().catch((err) =>
			logger.error("failed to update status bar:", err)
		)
	}

	notify(message: string, level = 0) {
		if (level >= (this.state.message_level ?? -1)) {
			this.update(() => ({ message, message_level: level }))
		}
	}

	private async update_status_bar() {
		if (this.state.message) {
			this.notification_bar.text = this.state.message
			this.notification_bar.show()
		} else {
			this.notification_bar.hide()
		}

		const active_document = vscode.window.activeTextEditor?.document
		const current_file =
			active_document?.uri.scheme === "file"
				? active_document.uri.fsPath
				: undefined
		const current_project_root = current_file
			? find_project_root(current_file)
			: null

		const { version_file, raw_value } = await get_version_file_raw_value(
			current_project_root ?? undefined
		)

		const sdk_path = await get_sdk_path(
			this.context,
			false,
			current_project_root ?? undefined,
			{ version_file, raw_value }
		)

		const version_file_source = version_file
			? vscode.workspace.asRelativePath(version_file)
			: undefined

		const extensions_enabled =
			get_config("renpyExtensionsEnabled") === "Enabled"

		if (sdk_path && this.state.running_processes > 0 && extensions_enabled) {
			this.follow_cursor_bar.show()
		} else {
			this.follow_cursor_bar.hide()
		}

		if (this.state.is_follow_cursor) {
			this.follow_cursor_bar.text = "$(pinned) Following Cursor"
			this.follow_cursor_bar.color = new vscode.ThemeColor(
				"statusBarItem.warningForeground"
			)
			this.follow_cursor_bar.backgroundColor = new vscode.ThemeColor(
				"statusBarItem.warningBackground"
			)
		} else {
			this.follow_cursor_bar.text = "$(pin) Follow Cursor"
			this.follow_cursor_bar.command = "renpyWarp.toggleFollowCursor"
			this.follow_cursor_bar.tooltip =
				"When enabled, keep editor cursor and Ren'Py dialogue in sync"
			this.follow_cursor_bar.color = undefined
			this.follow_cursor_bar.backgroundColor = undefined
		}

		if (
			sdk_path &&
			this.state.socket_server_status === "stopped" &&
			extensions_enabled
		) {
			this.instance_bar.text = "$(plug) Start Ren'Py socket server"
			this.instance_bar.command = "renpyWarp.startSocketServer"
			this.instance_bar.tooltip = "Start Ren'Py WebSocket server"
			this.instance_bar.show()
		} else {
			this.instance_bar.hide()
		}

		let executable: string[] | undefined
		let version: string | undefined

		if (sdk_path) {
			executable = await get_executable(sdk_path)
		}

		if (executable) {
			const v = get_version(executable)
			version = v.display
		}

		if (!sdk_path || !executable || !version) {
			if (raw_value && !is_explicit_path(raw_value)) {
				this.sdk_bar.backgroundColor = undefined
				this.sdk_bar.color = undefined
				this.sdk_bar.text = `$(warp-renpy) ${raw_value}`
				this.sdk_bar.tooltip = version_file_source
					? `Using Ren'Py SDK ${raw_value} (from ${version_file_source})`
					: `Using Ren'Py SDK ${raw_value}`
			} else {
				this.sdk_bar.text = "$(warp-renpy)"
				this.sdk_bar.backgroundColor = undefined
				this.sdk_bar.color = undefined
				this.sdk_bar.tooltip = "No Ren'Py SDK configured"
			}
		} else {
			this.sdk_bar.backgroundColor = undefined
			this.sdk_bar.color = undefined

			if (
				// if is managed by the extension
				sdk_path.includes("/globalStorage/paisleysoftworks.renpywarp/")
			) {
				this.sdk_bar.text = `$(warp-renpy) ${version}`
			} else {
				this.sdk_bar.text = `$(warp-renpy) ${tildify(sdk_path)} (${version})`
			}

			this.sdk_bar.tooltip = version_file_source
				? `Using Ren'Py SDK at ${tildify(sdk_path)} (from ${version_file_source})`
				: `Using Ren'Py SDK at ${tildify(sdk_path)}`
		}
		this.sdk_bar.command = {
			title: "Set SDK Path",
			command: "renpyWarp.setSdkPath",
			arguments: [current_project_root ?? undefined]
		}
		this.sdk_bar.show()
	}

	dispose() {
		for (const subscription of this.subscriptions) {
			subscription.dispose()
		}
	}
}
