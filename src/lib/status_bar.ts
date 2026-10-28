import * as vscode from "vscode"
import path from "upath"
import { get_config } from "./config"
import { get_logger } from "./log"
import {
	find_project_root,
	get_executable,
	get_version,
	RenpyVersion
} from "./sh"
import tildify from "tildify"
import { get_sdk_path, get_version_file_raw_value } from "./sdk"
import { is_explicit_path } from "./path"
import { direction_info, FollowCursorDirection } from "./follow_cursor"

const logger = get_logger()

type ProjectSdk =
	/** resolved to an sdk with a working executable */
	| { kind: "installed"; path: string; version: RenpyVersion; source?: string }
	/** the version file names a version that isn't downloaded */
	| { kind: "named"; name: string; source?: string }
	| { kind: "none" }

function active_project_root(): string | undefined {
	const document = vscode.window.activeTextEditor?.document

	if (document?.uri.scheme !== "file") return undefined

	return find_project_root(document.uri.fsPath) ?? undefined
}

function with_source(text: string, source: string | undefined): string {
	return source ? `${text} (from ${source})` : text
}

export class StatusBar {
	private context: vscode.ExtensionContext
	private sdk_bar: vscode.StatusBarItem
	private instance_bar: vscode.StatusBarItem
	private follow_cursor_bar: vscode.StatusBarItem
	private direction_bar: vscode.StatusBarItem
	private notification_bar: vscode.StatusBarItem
	private subscriptions: vscode.Disposable[] = []

	private message_timeout: NodeJS.Timeout | undefined
	private flash_timeout: NodeJS.Timeout | undefined

	private state = {
		socket_server_status: "stopped" as "running" | "stopped",
		running_processes: 0,
		is_follow_cursor: false,
		follow_cursor_direction: "game_to_script" as FollowCursorDirection,
		is_follow_cursor_flashing: false,
		message: undefined as string | undefined,
		message_level: undefined as number | undefined
	}

	private sdk: ProjectSdk | undefined
	private project_root: string | undefined
	private sdk_generation = 0

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

		this.direction_bar = vscode.window.createStatusBarItem(
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

		// files.exclude narrows the search for projects
		const refresh_sdk_on_config_update =
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration("renpyWarp") ||
					e.affectsConfiguration("files.exclude")
				) {
					this.refresh_sdk()
				}
			})

		const refresh_sdk_on_active_editor_change =
			vscode.window.onDidChangeActiveTextEditor(() => this.refresh_sdk())

		const refresh_sdk_on_version_file_change = () => this.refresh_sdk()

		const version_file_watcher =
			vscode.workspace.createFileSystemWatcher("**/.renpy-version")
		version_file_watcher.onDidCreate(refresh_sdk_on_version_file_change)
		version_file_watcher.onDidChange(refresh_sdk_on_version_file_change)
		version_file_watcher.onDidDelete(refresh_sdk_on_version_file_change)

		// the native watcher above can still lag by a beat, so react to an
		// in-editor save of the file itself immediately rather than waiting on it
		const refresh_sdk_on_version_file_save =
			vscode.workspace.onDidSaveTextDocument((document) => {
				if (path.basename(document.uri.fsPath) === ".renpy-version") {
					refresh_sdk_on_version_file_change()
				}
			})

		this.subscriptions.push(
			this.instance_bar,
			this.follow_cursor_bar,
			this.direction_bar,
			this.notification_bar,
			refresh_sdk_on_config_update,
			refresh_sdk_on_active_editor_change,
			version_file_watcher,
			refresh_sdk_on_version_file_save
		)

		this.refresh_sdk()
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

		this.render()

		// launching can download the sdk a version file names
		if ("running_processes" in incoming_state) this.refresh_sdk()
	}

	notify(message: string, level = 0) {
		if (level >= (this.state.message_level ?? -1)) {
			this.update(() => ({ message, message_level: level }))
		}
	}

	flash_follow_cursor() {
		clearTimeout(this.flash_timeout)

		this.flash_timeout = setTimeout(() => {
			this.update(() => ({ is_follow_cursor_flashing: false }))
		}, 3000)

		this.update(() => ({ is_follow_cursor_flashing: true }))
	}

	private refresh_sdk(): void {
		const generation = ++this.sdk_generation
		const project_root = active_project_root()

		this.resolve_sdk(project_root)
			.then((sdk) => {
				// a newer refresh started, possibly for another editor
				if (generation !== this.sdk_generation) return

				this.project_root = project_root
				this.sdk = sdk
				this.render()
			})
			.catch((err) => logger.error("failed to update status bar:", err))
	}

	private async resolve_sdk(
		project_root: string | undefined
	): Promise<ProjectSdk> {
		const { version_file, raw_value } =
			await get_version_file_raw_value(project_root)
		const source = version_file
			? vscode.workspace.asRelativePath(version_file)
			: undefined

		const sdk_path = await get_sdk_path(this.context, false, project_root, {
			version_file,
			raw_value
		})
		const executable = sdk_path ? await get_executable(sdk_path) : undefined

		if (sdk_path && executable) {
			return {
				kind: "installed",
				path: sdk_path,
				version: await get_version(executable),
				source
			}
		}

		if (raw_value && !is_explicit_path(raw_value)) {
			return { kind: "named", name: raw_value, source }
		}

		return { kind: "none" }
	}

	private render() {
		if (this.state.message) {
			this.notification_bar.text = this.state.message
			this.notification_bar.show()
		} else {
			this.notification_bar.hide()
		}

		const sdk = this.sdk
		const installed = sdk?.kind === "installed"

		const extensions_enabled =
			get_config("renpyExtensionsEnabled") === "Enabled"

		const can_follow =
			installed && this.state.running_processes > 0 && extensions_enabled

		if (can_follow || this.state.is_follow_cursor_flashing) {
			this.follow_cursor_bar.show()
		} else {
			this.follow_cursor_bar.hide()
		}

		this.follow_cursor_bar.command = "renpyWarp.toggleFollowCursor"

		if (this.state.is_follow_cursor) {
			this.follow_cursor_bar.text = "$(pinned) Following Cursor"
			this.follow_cursor_bar.tooltip =
				"Keeping the editor cursor and Ren'Py dialogue in sync\nClick to stop following"
			this.follow_cursor_bar.color = new vscode.ThemeColor(
				"statusBarItem.warningForeground"
			)
			this.follow_cursor_bar.backgroundColor = new vscode.ThemeColor(
				"statusBarItem.warningBackground"
			)
		} else {
			this.follow_cursor_bar.text = "$(pin) Follow Cursor"
			this.follow_cursor_bar.tooltip =
				"Keep the editor cursor and Ren'Py dialogue in sync\nClick to start following"
			this.follow_cursor_bar.color = undefined
			this.follow_cursor_bar.backgroundColor = undefined
		}

		if (
			(can_follow && this.state.is_follow_cursor) ||
			this.state.is_follow_cursor_flashing
		) {
			this.direction_bar.show()
		} else {
			this.direction_bar.hide()
		}

		const direction = direction_info(this.state.follow_cursor_direction)
		this.direction_bar.text = direction.text
		this.direction_bar.command = "renpyWarp.cycleFollowCursorDirection"
		this.direction_bar.tooltip = `${direction.description}\nClick to switch direction`

		if (
			installed &&
			this.state.socket_server_status === "stopped" &&
			extensions_enabled
		) {
			this.instance_bar.text = "$(plug) Start Ren'Py socket server"
			this.instance_bar.command = "renpyWarp.startSocketServer"
			this.instance_bar.tooltip = "Start Ren'Py socket server"
			this.instance_bar.show()
		} else {
			this.instance_bar.hide()
		}

		if (!sdk) return

		switch (sdk.kind) {
			case "installed": {
				const location =
					process.platform === "win32" ? sdk.path : tildify(sdk.path)

				// the extension's own downloads go by version alone
				this.sdk_bar.text = path
					.toUnix(sdk.path)
					.includes("/globalStorage/paisleysoftworks.renpywarp/")
					? `$(warp-renpy) ${sdk.version.display}`
					: `$(warp-renpy) ${location} (${sdk.version.display})`
				this.sdk_bar.tooltip = with_source(
					`Using Ren'Py SDK at ${location}`,
					sdk.source
				)
				break
			}

			case "named":
				this.sdk_bar.text = `$(warp-renpy) ${sdk.name}`
				this.sdk_bar.tooltip = with_source(
					`Using Ren'Py SDK ${sdk.name}`,
					sdk.source
				)
				break

			case "none":
				this.sdk_bar.hide()
				return
		}

		this.sdk_bar.command = {
			title: "Set SDK Path",
			command: "renpyWarp.setSdkPath",
			arguments: [this.project_root]
		}
		this.sdk_bar.show()
	}

	dispose() {
		for (const subscription of this.subscriptions) {
			subscription.dispose()
		}
	}
}
