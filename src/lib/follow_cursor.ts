import * as vscode from "vscode"
import { get_config } from "./config"
import { AnyProcess } from "./process"
import { get_logger } from "./log"
import path from "upath"
import { find_project_root } from "./sh"
import type { StatusBar } from "./status_bar"
import { DialogueRange, said_range, SaidRange } from "./dialogue"
import { cursor_selection, dialogue_range } from "./mark"
import {
	get_statements,
	reported_position,
	ReportedPosition,
	warp_refusal,
	warp_target
} from "./script"

const logger = get_logger()

export const FOLLOW_CURSOR_DIRECTIONS = [
	{
		id: "game_to_script",
		text: "Ren'Py $(arrow-right) Editor",
		description: "Ren'Py advancing will update the editor's cursor"
	},
	{
		id: "script_to_game",
		text: "Ren'Py $(arrow-left) Editor",
		description: "Editor cursor will update Ren'Py's current line"
	},
	{
		id: "both",
		text: "Ren'Py $(arrow-both) Editor",
		description: "Game and editor cursor stay in sync"
	}
] as const

export type FollowCursorDirection =
	(typeof FOLLOW_CURSOR_DIRECTIONS)[number]["id"]

export function direction_info(id: FollowCursorDirection) {
	return FOLLOW_CURSOR_DIRECTIONS.find((d) => d.id === id)!
}

const DIRECTION_KEY = "followCursorDirection"

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

function locate_renpy(
	document: vscode.TextDocument,
	warp_line: number,
	what: string | undefined,
	said: SaidRange | undefined
): ReportedPosition {
	const position = reported_position(
		document,
		get_statements(document),
		warp_line,
		what,
		said
	)

	if (what !== undefined && position.dialogue === undefined) {
		logger.debug(`could not find the dialogue ${JSON.stringify(what)}`)
	}

	return position
}

function reveal_dialogue(
	editor: vscode.TextEditor,
	line: number,
	dialogue: DialogueRange | undefined
): void {
	// ren'py below 8.6 reports a monologue block on its `"""` line, so the
	// dialogue can be further down the file than the line it came with
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

	const { line, dialogue } = locate_renpy(doc, reported_line, what, said)

	logger.debug(`syncing editor to ${relative_path}:${line}`)

	reveal_dialogue(editor, line, dialogue)

	const selection = cursor_selection(editor.document, line, dialogue)

	if (selection) {
		editor.selection = selection
		own_mark = { uri: editor.document.uri.toString(), selection }
	}
}

export async function sync_editor_to_last_known_line(
	process: AnyProcess
): Promise<void> {
	const last_cursor = process.last_cursor

	// the report predates a warp still in flight, so it is likely stale
	if (!last_cursor || process.warp_pending) return

	await sync_editor_with_renpy({
		path: last_cursor.path,
		relative_path: last_cursor.relative_path,
		line: last_cursor.line - 1,
		what: last_cursor.what,
		said: said_range(last_cursor),
		force: true,
		pid: process.pid
	})
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

	if (!last_cursor || rp.warp_pending) return false

	const document = editor.document

	if (
		path.normalize(document.uri.fsPath) !== path.normalize(last_cursor.path)
	) {
		return false
	}

	const { statement } = locate_renpy(
		document,
		last_cursor.line - 1,
		last_cursor.what,
		said_range(last_cursor)
	)

	// anywhere inside a statement is the same place as far as warping goes
	return (
		statement !== undefined &&
		statement ===
			warp_target(get_statements(document), editor.selection.active.line)
	)
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

	const { line, dialogue } = locate_renpy(
		editor.document,
		last_cursor.line - 1,
		last_cursor.what,
		said_range(last_cursor)
	)

	reveal_dialogue(editor, line, dialogue)
}

export async function warp_renpy_to_cursor(
	rp: AnyProcess,
	status_bar: StatusBar,
	direction: FollowCursorDirection,
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
		if (!refusing.has(rp.pid) && direction === "both") {
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
	private context: vscode.ExtensionContext
	private status_bar: StatusBar
	private text_editor_handle: vscode.Disposable | undefined

	enabled = false
	active_process: AnyProcess | undefined

	constructor({
		context,
		status_bar
	}: {
		context: vscode.ExtensionContext
		status_bar: StatusBar
	}) {
		this.context = context
		this.status_bar = status_bar

		this.status_bar.update(() => ({
			follow_cursor_direction: this.direction
		}))
	}

	get direction(): FollowCursorDirection {
		const stored = this.context.workspaceState.get<string>(DIRECTION_KEY)

		return (
			FOLLOW_CURSOR_DIRECTIONS.find((d) => d.id === stored)?.id ??
			"game_to_script"
		)
	}

	async set_direction(direction: FollowCursorDirection): Promise<void> {
		const previous = this.direction

		await this.context.workspaceState.update(DIRECTION_KEY, direction)

		this.status_bar.update(() => ({ follow_cursor_direction: direction }))

		// the editor stopped following while the script led
		if (this.active_process && previous === "script_to_game") {
			await this.catch_up(this.active_process)
		}
	}

	async cycle_direction(): Promise<void> {
		const index = FOLLOW_CURSOR_DIRECTIONS.findIndex(
			(d) => d.id === this.direction
		)
		const next =
			FOLLOW_CURSOR_DIRECTIONS[(index + 1) % FOLLOW_CURSOR_DIRECTIONS.length]

		await this.set_direction(next.id)

		this.status_bar.flash_follow_cursor()
	}

	async catch_up(process: AnyProcess): Promise<void> {
		if (this.direction === "script_to_game") return

		await sync_editor_to_last_known_line(process)
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
					this.direction !== "game_to_script" &&
					event.kind !== vscode.TextEditorSelectionChangeKind.Command &&
					!is_own_mark(event) &&
					!is_at_renpy_cursor(process, event.textEditor)
				) {
					await warp_renpy_to_cursor(
						process,
						this.status_bar,
						this.direction,
						event.textEditor
					).catch(logger.error)
				}
			}
		)

		this.status_bar.update(() => ({
			is_follow_cursor: true
		}))
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
			this.status_bar.update(() => ({ is_follow_cursor: false }))
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
