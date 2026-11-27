import * as vscode from "vscode"
import type { AnyProcess } from "."
import type { ProcessManager } from "./manager"
import { find_project_root } from "../sh"
import { is_same_path } from "../path"

export function focused_process(pm: ProcessManager): AnyProcess | undefined {
	const session = vscode.debug.activeDebugSession

	return session ? pm.find_by_debug_session(session.id) : undefined
}

export function target_process(
	pm: ProcessManager,
	project_root?: string
): AnyProcess | undefined {
	const in_project = (rpp: AnyProcess) =>
		project_root === undefined || is_same_path(rpp.project_root, project_root)

	const focused = focused_process(pm)
	if (focused && in_project(focused)) return focused

	return pm.newest(in_project)
}

export function active_target_process(
	pm: ProcessManager
): AnyProcess | undefined {
	const focused = focused_process(pm)
	if (focused) return focused

	const document = vscode.window.activeTextEditor?.document
	const project_root =
		document?.uri.scheme === "file"
			? find_project_root(document.uri.fsPath)
			: null

	return (
		(project_root ? target_process(pm, project_root) : undefined) ??
		target_process(pm)
	)
}
