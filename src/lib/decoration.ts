import * as vscode from "vscode"
import { AnyProcess } from "./process"
import path from "upath"
import { get_config } from "./config"
import { AnySocketMessage, CurrentLineSocketMessage } from "./socket"
import { realpath } from "node:fs/promises"
import { get_logger } from "./log"
import { find_dialogue_range, said_range } from "./dialogue"
import { dialogue_range } from "./mark"
import { editor_line, get_statements } from "./script"

const logger = get_logger()

async function safe_realpath(p: string): Promise<string | void> {
	try {
		return await realpath(p)
	} catch {
		return undefined
	}
}

export class DecorationService {
	private state = new Map<number, CurrentLineSocketMessage>()
	private subscriptions: vscode.Disposable[]
	private gutter: boolean
	private dialogue: boolean
	private arrow: vscode.TextEditorDecorationType
	private highlight: vscode.TextEditorDecorationType
	private update_timeout: ReturnType<typeof setTimeout> | undefined

	constructor({ context }: { context: vscode.ExtensionContext }) {
		this.gutter = get_config("showGutterDecorations") as boolean
		this.dialogue = get_config("showDialogueDecorations") as boolean

		this.arrow = vscode.window.createTextEditorDecorationType({
			gutterIconPath: context.asAbsolutePath("dist/assets/arrow-right.svg"),
			dark: {
				gutterIconPath: context.asAbsolutePath(
					"dist/assets/arrow-right-white.svg"
				)
			},
			overviewRulerColor: new vscode.ThemeColor("editorCursor.foreground"),
			overviewRulerLane: vscode.OverviewRulerLane.Center
		})

		// the highlight stands in for a selection without touching the real one,
		// so edits around it must not stretch it
		this.highlight = vscode.window.createTextEditorDecorationType({
			backgroundColor: new vscode.ThemeColor(
				"renpyWarp.dialogueBackgroundDecoration"
			),
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
		})

		this.subscriptions = [
			this.arrow,
			this.highlight,
			vscode.window.onDidChangeActiveTextEditor(() => {
				this.schedule_update()
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("renpyWarp.showGutterDecorations")) {
					this.gutter = get_config("showGutterDecorations") as boolean
					this.schedule_update()
				}
				if (e.affectsConfiguration("renpyWarp.showDialogueDecorations")) {
					this.dialogue = get_config("showDialogueDecorations") as boolean
					this.schedule_update()
				}
			}),
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (e.document.uri.scheme === "file" && e.contentChanges.length) {
					this.schedule_update()
				}
			})
		]
	}

	private schedule_update() {
		clearTimeout(this.update_timeout)
		this.update_timeout = setTimeout(() => {
			this.update_decorations().catch(logger.error)
		}, 150)
	}

	private async update_decorations() {
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.uri.scheme !== "file") continue

			const arrows: vscode.Range[] = []
			const highlights: vscode.Range[] = []

			// finding the dialogue means lexing the script, so only look when
			// there is something to draw with it
			const editor_path =
				this.gutter || this.dialogue
					? await safe_realpath(editor.document.uri.fsPath)
					: undefined

			if (editor_path) {
				for (const [, state] of this.state) {
					if (path.relative(editor_path, state.path) !== "") continue

					// ren'py's line numbering can run behind editor's
					const line = editor_line(
						get_statements(editor.document),
						state.line - 1
					)
					const dialogue =
						state.what === undefined
							? undefined
							: find_dialogue_range(
									editor.document,
									line,
									state.what,
									said_range(state)
								)

					if (this.gutter) {
						const at = dialogue?.start.line ?? line

						arrows.push(new vscode.Range(at, 0, at, 0))
					}

					if (this.dialogue && dialogue) {
						highlights.push(dialogue_range(dialogue))
					}
				}
			}

			editor.setDecorations(this.arrow, arrows)
			editor.setDecorations(this.highlight, highlights)
		}
	}

	track(process: AnyProcess) {
		process.on("socketMessage", (message: AnySocketMessage) => {
			if (message.type === "current_line") {
				this.state.set(process.pid, message)
				this.update_decorations().catch(logger.error)
			}
			if (message.type === "current_label") {
				if (["start", "main_menu_screen"].includes(message.label)) {
					// if game starts, ends or is loaded from save
					this.state.delete(process.pid)
					this.update_decorations().catch(logger.error)
				}
			}
		})
		process.on("exit", () => {
			this.state.delete(process.pid)
			this.update_decorations().catch(logger.error)
		})
	}

	dispose() {
		this.subscriptions.forEach((subscription) => subscription.dispose())
	}
}
