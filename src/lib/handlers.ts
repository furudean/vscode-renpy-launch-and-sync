import * as vscode from "vscode"
import { get_config } from "./config"
import { get_logger } from "./log"
import { ProcessManager } from "./process"
import { WarpSocketService } from "./socket"
import { uninstall_rpes, update_existing_rpes } from "./rpe"
import { get_sdk_path } from "./sdk"
import { find_projects_in_workspaces } from "./path"

const logger = get_logger()

export function register_handlers(
	context: vscode.ExtensionContext,
	pm: ProcessManager,
	wss: WarpSocketService
) {
	const save_text_handler = vscode.workspace.onWillSaveTextDocument(
		async ({ document }) => {
			try {
				if (!document.fileName.endsWith(".rpy")) return
				if (document.isDirty === false) return
				if (get_config("setAutoReloadOnSave") !== true) return

				if (vscode.window.activeTextEditor?.selection.active.line === undefined)
					return

				for (const process of pm) {
					if (!process.socket) continue

					logger.info("reloading process on save", process.pid)
					await process.set_autoreload()
				}
			} catch (error: unknown) {
				logger.error(error as Error)
			}
		}
	)
	context.subscriptions.push(save_text_handler)

	vscode.commands.executeCommand(
		"setContext",
		"renpyWarp.renpyExtensionsEnabled",
		get_config("renpyExtensionsEnabled") === "Enabled"
	)
	const on_server_relevant_change = async () => {
		await update_existing_rpes(context)

		logger.info("server settings changed")
		const extensions_enabled =
			get_config("renpyExtensionsEnabled") === "Enabled"

		if (get_config("autoStartSocketServer") && extensions_enabled) {
			wss.start()
		} else {
			wss.close()
		}

		if (!extensions_enabled) {
			const sdk_path = await get_sdk_path(context, false)
			if (sdk_path) {
				for (const folder of vscode.workspace.workspaceFolders ?? []) {
					await uninstall_rpes(folder.uri)
				}
			}
		}

		vscode.commands.executeCommand(
			"setContext",
			"renpyWarp.renpyExtensionsEnabled",
			get_config("renpyExtensionsEnabled") === "Enabled"
		)
	}

	const server_on_change = vscode.workspace.onDidChangeConfiguration((e) => {
		if (
			e.affectsConfiguration("renpyWarp.autoStartSocketServer") ||
			e.affectsConfiguration("renpyWarp.renpyExtensionsEnabled")
		) {
			on_server_relevant_change()
		}
	})

	// a new sdk can need a new rpe, but it never changes whether the server runs
	const on_version_file_change = () => {
		if (get_config("renpyExtensionsEnabled") !== "Enabled") return

		update_existing_rpes(context).catch((error) => logger.error(error))
	}

	const version_file_watcher =
		vscode.workspace.createFileSystemWatcher("**/.renpy-version")
	version_file_watcher.onDidCreate(on_version_file_change)
	version_file_watcher.onDidChange(on_version_file_change)
	version_file_watcher.onDidDelete(on_version_file_change)

	const on_project_change = () => {
		find_projects_in_workspaces()
			.then((projects) =>
				vscode.commands.executeCommand(
					"setContext",
					"renpyWarp.hasProject",
					projects.length > 0
				)
			)
			.catch((error) => logger.error(error))
	}

	on_project_change()

	const workspace_folders_on_change =
		vscode.workspace.onDidChangeWorkspaceFolders(on_project_change)

	const project_file_watcher = vscode.workspace.createFileSystemWatcher(
		"**/game/**/*.rpy",
		false,
		true,
		false
	)
	project_file_watcher.onDidCreate(on_project_change)
	project_file_watcher.onDidDelete(on_project_change)

	context.subscriptions.push(
		server_on_change,
		version_file_watcher,
		workspace_folders_on_change,
		project_file_watcher
	)
}
