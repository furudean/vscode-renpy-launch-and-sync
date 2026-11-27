import * as vscode from "vscode"

import { ProcessManager } from "./lib/process/manager"
import { FollowCursorService, has_cursor_drifted } from "./lib/follow_cursor"
import { get_logger } from "./lib/log"
import { get_config, init_config_cache } from "./lib/config"
import { StatusBar } from "./lib/status_bar"
import { get_message_handler, WarpSocketService } from "./lib/socket"
import { register_commands } from "./lib/commands"
import { update_existing_rpes } from "./lib/rpe"
import { register_handlers } from "./lib/handlers"
import { DecorationService } from "./lib/decoration"
import { AnyProcess } from "./lib/process"
import type { RenpyDebugConfigurationProvider } from "./lib/debug"
import {
	download_sdk,
	list_downloaded_sdks,
	uninstall_sdk
} from "./lib/download"
import { launch_renpy } from "./lib/launch"
import { register_debugger } from "./lib/debug"
import { VersionFileAnnotations } from "./lib/version_file"

const logger = get_logger()

export interface ExtensionApi {
	pm: ProcessManager
	/** sdk management with the extension context already bound, for the e2e tests */
	sdk: {
		download: (
			url: string | URL,
			name: string,
			validate?: boolean
		) => Promise<string | undefined>
		list: () => Promise<string[]>
		uninstall: (sdk_path: string) => Promise<void>
	}
	/**
	 * launches ren'py without registering the process with `pm`, so its
	 * socket connection is picked up as an unmanaged/external process. for
	 * the e2e tests
	 */
	launch_unmanaged: () => Promise<AnyProcess | undefined>
	ipc_path: string
	debug_provider: RenpyDebugConfigurationProvider
	follow_cursor: FollowCursorService
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
	init_config_cache(context)

	const status_bar = new StatusBar(context)
	const version_annotations = new VersionFileAnnotations(context)
	const follow_cursor = new FollowCursorService({ context, status_bar })
	const pm = new ProcessManager()
	const ds = new DecorationService({ context })
	const wss = new WarpSocketService({
		message_handler: get_message_handler(follow_cursor),
		pm,
		status_bar,
		context
	})

	context.subscriptions.push(
		pm,
		follow_cursor,
		status_bar,
		version_annotations,
		ds,
		wss
	)

	function sync_process_count() {
		vscode.commands.executeCommand(
			"setContext",
			"renpyWarp.runningProcesses",
			pm.length
		)
		status_bar.update(() => ({ running_processes: pm.length }))

		version_annotations.refresh()
	}

	let cursor_drifted = false
	let cursor_drift_timeout: NodeJS.Timeout | undefined

	function set_cursor_drifted(drifted: boolean) {
		if (drifted === cursor_drifted) return

		cursor_drifted = drifted
		status_bar.update(() => ({ is_cursor_drifted: drifted }))
	}

	function refresh_cursor_drift() {
		if (!has_cursor_drifted(pm.at(-1))) {
			clearTimeout(cursor_drift_timeout)
			cursor_drift_timeout = undefined
			set_cursor_drifted(false)
			return
		}

		// already shown, or already waiting to be. restarting the wait on
		// every scroll would hold it off until the scrolling stops
		if (cursor_drifted || cursor_drift_timeout) return

		// the editor and ren'py fall out of step for a moment whenever follow
		// cursor has one catch up to the other, so only count drift that
		// outlasts that
		if (!follow_cursor.active_process) {
			set_cursor_drifted(true)
			return
		}

		cursor_drift_timeout = setTimeout(() => {
			cursor_drift_timeout = undefined
			set_cursor_drifted(has_cursor_drifted(pm.at(-1)))
		}, 200)
	}

	context.subscriptions.push(
		{ dispose: () => clearTimeout(cursor_drift_timeout) },
		vscode.window.onDidChangeTextEditorSelection(refresh_cursor_drift),
		vscode.window.onDidChangeActiveTextEditor(refresh_cursor_drift),
		vscode.window.onDidChangeTextEditorVisibleRanges(refresh_cursor_drift),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("renpyWarp.followCursorBehavior")) {
				refresh_cursor_drift()
			}
		})
	)

	let pm_init = false
	pm.on("exit", () => {
		sync_process_count()
		refresh_cursor_drift()

		if (pm.length === 0) {
			pm_init = false
		}
		if (
			follow_cursor.enabled &&
			get_config("renpyExtensionsEnabled") === "Enabled"
		) {
			const most_recent = pm.at(-1)

			if (most_recent) {
				follow_cursor.set(most_recent)
				status_bar.notify(
					`$(debug-line-by-line) Now following pid ${most_recent.pid}`
				)
			}
		}
	})
	pm.on("attach", async (rpp: AnyProcess) => {
		sync_process_count()

		ds.track(rpp)

		rpp.on("cursorChange", refresh_cursor_drift)
		refresh_cursor_drift()

		if (
			(get_config("renpyExtensionsEnabled") === "Enabled" &&
				get_config("followCursorOnLaunch") &&
				!pm_init) ||
			follow_cursor.enabled // follow cursor is already active, replace it
		) {
			logger.info("enabling follow cursor for new process")
			await follow_cursor.set(rpp)

			if (pm.length > 1) {
				status_bar.notify(`$(debug-line-by-line) Now following pid ${rpp.pid}`)
			}
		}

		pm_init = true
	})

	register_commands(context, pm, status_bar, follow_cursor, wss)
	const debug_provider = register_debugger(context, pm, status_bar, wss)
	register_handlers(context, pm, wss)

	if (get_config("renpyExtensionsEnabled") === "Enabled") {
		update_existing_rpes(context).catch((error) => {
			logger.error(error)
			vscode.window
				.showErrorMessage(
					"Failed to install/update RPE on startup",
					"Logs",
					"OK"
				)
				.then((selection) => {
					if (selection === "Logs") {
						logger.show()
					}
				})
		})

		if (get_config("autoStartSocketServer")) {
			wss.start().catch((error) => {
				logger.error("failed to start socket server:", error)
			})
		}
	}

	return {
		pm,
		sdk: {
			download: (url, name, validate) =>
				download_sdk(url, name, context, validate),
			list: () => list_downloaded_sdks(context),
			uninstall: (sdk_path) => uninstall_sdk(sdk_path, context)
		},
		launch_unmanaged() {
			return launch_renpy({ context, pm, wss, register: false })
		},
		ipc_path: wss.ipc_path,
		debug_provider,
		follow_cursor
	}
}

export function deactivate() {
	logger.dispose()
}
