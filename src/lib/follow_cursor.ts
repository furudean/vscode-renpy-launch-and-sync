import * as vscode from "vscode"
import { get_config } from "./config"
import { AnyProcess } from "./process"
import { get_logger } from "./log"
import path from "upath"
import { find_project_root } from "./sh"
import { StatusBar } from "./status_bar"
import { find_dialogue_range, SaidRange } from "./lex"
import { cursor_selection, dialogue_range } from "./mark"

const logger = get_logger()
const last_warps = new Map<number, string>()

let own_mark: { uri: string; selection: vscode.Selection } | undefined

interface SyncEditorWithRenpyOptions {
	/** absolute path to the file */
	path: string
	/** path relative from the game folder (e.g. `script.rpy`) */
	relative_path: string
	/** 0-indexed line number */
	line: number
	/** dialogue ren'py is displaying, if it reported any */
	what?: string
	/** the part of the dialogue ren'py is saying, if it reported one */
	said?: SaidRange
	/** skip redundancy checks */
	force?: boolean
	/** pid of the renpy process, used for deduplication */
	pid?: number
}

export async function sync_editor_with_renpy({
	path,
	relative_path,
	line,
	what,
	said,
	force,
	pid = 0
}: SyncEditorWithRenpyOptions): Promise<void> {
	const warp_spec = `${path}:${line + 1}:${what ?? ""}:${said?.from}-${said?.to}`
	if (!force && warp_spec === last_warps.get(pid)) return // no change
	last_warps.set(pid, warp_spec)

	const doc = await vscode.workspace.openTextDocument(path)
	const editor = await vscode.window.showTextDocument(doc)

	logger.debug(`syncing editor to ${relative_path}:${line}`)

	const dialogue =
		what === undefined
			? undefined
			: find_dialogue_range(editor.document, line, what, said)

	if (what !== undefined && dialogue === undefined) {
		logger.debug(`could not find the dialogue ${JSON.stringify(what)}`)
	}

	// ren'py reports monologue blocks on the line they open on, so the dialogue
	// can be further down the file than the line it came with
	const range = dialogue
		? dialogue_range(dialogue)
		: editor.document.lineAt(Math.min(line, editor.document.lineCount - 1))
				.range

	editor.revealRange(
		range,
		vscode.TextEditorRevealType.InCenterIfOutsideViewport
	)

	const selection = cursor_selection(editor.document, line, dialogue)

	if (selection) {
		editor.selection = selection
		own_mark = { uri: editor.document.uri.toString(), selection }
	}
}

function is_own_mark(event: vscode.TextEditorSelectionChangeEvent): boolean {
	return (
		own_mark !== undefined &&
		own_mark.uri === event.textEditor.document.uri.toString() &&
		event.selections.length === 1 &&
		event.selections[0].isEqual(own_mark.selection)
	)
}

export async function warp_renpy_to_cursor(
	rp: AnyProcess,
	status_bar: StatusBar
): Promise<void> {
	const editor = vscode.window.activeTextEditor

	if (!editor) return

	const filename = editor.document.fileName
	const file = editor.document.uri.fsPath
	const line = editor.selection.active.line

	if (!filename.endsWith(".rpy")) return

	const project_root = find_project_root(file)

	if (!project_root) return

	const filename_relative = path.relative(
		path.join(project_root, "game/"),
		file
	)

	const warp_spec = `${filename_relative}:${line + 1}`

	if (warp_spec === last_warps.get(rp.pid)) return // no change
	last_warps.set(rp.pid, warp_spec)

	if (!rp) {
		logger.warn("no renpy process found")
		return
	}

	await rp.warp_to_line(filename_relative, line + 1)
	status_bar.notify(`$(debug-line-by-line) Warped to ${warp_spec}`)
	logger.info("warped to", warp_spec)
}

export class FollowCursorService {
	private status_bar: StatusBar
	private text_editor_handle: vscode.Disposable | undefined

	enabled = false
	active_process: AnyProcess | undefined

	constructor({ status_bar }: { status_bar: StatusBar }) {
		this.status_bar = status_bar
	}

	async set(process: AnyProcess) {
		if (get_config("renpyExtensionsEnabled") !== "Enabled") return

		this.active_process = process
		this.enabled = true

		process.once("exit", () => {
			last_warps.delete(process.pid)
			own_mark = undefined
		})

		this.text_editor_handle?.dispose()
		this.text_editor_handle = vscode.window.onDidChangeTextEditorSelection(
			async (event) => {
				if (
					["Visual Studio Code updates Ren'Py", "Update both"].includes(
						get_config("followCursorMode") as string
					) &&
					event.kind !== vscode.TextEditorSelectionChangeKind.Command &&
					!is_own_mark(event)
				) {
					await warp_renpy_to_cursor(process, this.status_bar)
				}
			}
		)

		this.status_bar.update(() => ({
			is_follow_cursor: true
		}))

		if (
			["Visual Studio Code updates Ren'Py", "Update both"].includes(
				get_config("followCursorMode") as string
			)
		) {
			await warp_renpy_to_cursor(process, this.status_bar)
		}
	}

	off() {
		this.enabled = false
		own_mark = undefined

		if (!this.active_process) return

		this.active_process = undefined

		this.text_editor_handle?.dispose()
		this.text_editor_handle = undefined

		this.status_bar.update(() => ({
			is_follow_cursor: false
		}))
	}

	dispose() {
		this.text_editor_handle?.dispose()
	}
}
