import * as vscode from "vscode"
import { get_config } from "./config"
import { AnyProcess } from "./process"
import { get_logger } from "./log"
import path from "upath"
import { find_project_root } from "./sh"
import { StatusBar } from "./status_bar"
import {
	DialogueRange,
	find_dialogue_range,
	said_range,
	SaidRange
} from "./dialogue"
import { cursor_selection, dialogue_range } from "./mark"
import {
	editor_line,
	get_statements,
	warp_refusal,
	warp_target
} from "./script"

const logger = get_logger()
const last_warps = new Map<number, string>()
const refusing = new Set<number>()

let own_mark: { uri: string; selection: vscode.Selection } | undefined

interface SyncEditorWithRenpyOptions {
	/** absolute path to the file */
	path: string
	/** path relative from the game folder (e.g. `script.rpy`) */
	relative_path: string
	/** 0-indexed line ren'py reported, in ren'py's own numbering */
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

function reported_dialogue(
	document: vscode.TextDocument,
	line: number,
	what: string | undefined,
	said: SaidRange | undefined
): DialogueRange | undefined {
	if (what === undefined) return undefined

	const dialogue = find_dialogue_range(document, line, what, said)

	if (dialogue === undefined) {
		logger.debug(`could not find the dialogue ${JSON.stringify(what)}`)
	}

	return dialogue
}

function reveal_dialogue(
	editor: vscode.TextEditor,
	line: number,
	dialogue: DialogueRange | undefined
): void {
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
}

export async function sync_editor_with_renpy({
	path,
	relative_path,
	line: reported_line,
	what,
	said,
	force,
	pid = 0
}: SyncEditorWithRenpyOptions): Promise<void> {
	const warp_spec = `${path}:${reported_line + 1}:${what ?? ""}:${said?.from}-${said?.to}`
	if (!force && warp_spec === last_warps.get(pid)) return // no change
	last_warps.set(pid, warp_spec)

	const doc = await vscode.workspace.openTextDocument(path)
	const editor = await vscode.window.showTextDocument(doc)

	const line = editor_line(get_statements(doc), reported_line)

	logger.debug(`syncing editor to ${relative_path}:${line}`)

	const dialogue = reported_dialogue(editor.document, line, what, said)

	reveal_dialogue(editor, line, dialogue)

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

function is_at_renpy_cursor(
	rp: AnyProcess,
	editor: vscode.TextEditor
): boolean {
	const last_cursor = rp.last_cursor

	if (!last_cursor) return false

	const document = editor.document

	if (
		path.normalize(document.uri.fsPath) !== path.normalize(last_cursor.path)
	) {
		return false
	}

	// ren'py reports the line a statement opens on, so anywhere inside one is
	// the same place as far as warping goes
	const target = warp_target(
		get_statements(document),
		editor.selection.active.line
	)

	return target?.warp_line === last_cursor.line - 1
}

function reveal_renpy_cursor(rp: AnyProcess, editor: vscode.TextEditor): void {
	const last_cursor = rp.last_cursor

	if (!last_cursor) return

	// opening the file ren'py happens to be in would take the user off
	// whatever they were working on
	if (
		path.normalize(editor.document.uri.fsPath) !==
		path.normalize(last_cursor.path)
	) {
		return
	}

	const line = editor_line(
		get_statements(editor.document),
		last_cursor.line - 1
	)

	reveal_dialogue(
		editor,
		line,
		reported_dialogue(
			editor.document,
			line,
			last_cursor.what,
			said_range(last_cursor)
		)
	)
}

export async function warp_renpy_to_cursor(
	rp: AnyProcess,
	status_bar: StatusBar,
	editor = vscode.window.activeTextEditor
): Promise<void> {
	if (!editor) return

	const filename = editor.document.fileName
	const file = editor.document.uri.fsPath
	const line = editor.selection.active.line

	if (!filename.endsWith(".rpy")) return

	const project_root = find_project_root(file)

	if (!project_root) return

	const target = warp_target(get_statements(editor.document), line)

	if (!target?.warpable || !target.stops) {
		const refusal_spec = `refused ${file}:${line + 1}`

		if (refusal_spec === last_warps.get(rp.pid)) return
		last_warps.set(rp.pid, refusal_spec)

		const message = warp_refusal(target, line)

		logger.debug(message)
		status_bar.notify(`$(circle-slash) ${message}`)

		// the game stays where it is, so show where that is rather than
		// leaving the two out of step. scrolling on every move would fight the
		// cursor, so only do it when it first lands somewhere unwarpable
		if (
			!refusing.has(rp.pid) &&
			get_config("followCursorMode") === "Update both"
		) {
			reveal_renpy_cursor(rp, editor)
		}

		refusing.add(rp.pid)

		return
	}

	refusing.delete(rp.pid)

	const filename_relative = path.relative(
		path.join(project_root, "game/"),
		file
	)

	const warp_spec = `${filename_relative}:${target.warp_line + 1}`

	if (warp_spec === last_warps.get(rp.pid)) return // no change
	last_warps.set(rp.pid, warp_spec)

	await rp.warp_to_line(filename_relative, target.warp_line + 1)
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
			refusing.delete(process.pid)

			if (this.active_process === process) this.detach()
		})

		this.text_editor_handle?.dispose()
		this.text_editor_handle = vscode.window.onDidChangeTextEditorSelection(
			async (event) => {
				if (
					["Visual Studio Code updates Ren'Py", "Update both"].includes(
						get_config("followCursorMode") as string
					) &&
					event.kind !== vscode.TextEditorSelectionChangeKind.Command &&
					!is_own_mark(event) &&
					!is_at_renpy_cursor(process, event.textEditor)
				) {
					await warp_renpy_to_cursor(
						process,
						this.status_bar,
						event.textEditor
					).catch(logger.error)
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

	private detach() {
		this.active_process = undefined
		own_mark = undefined

		this.text_editor_handle?.dispose()
		this.text_editor_handle = undefined
	}

	off() {
		this.enabled = false

		if (!this.active_process) {
			own_mark = undefined
			return
		}

		this.detach()

		this.status_bar.update(() => ({
			is_follow_cursor: false
		}))
	}

	dispose() {
		this.text_editor_handle?.dispose()
	}
}
