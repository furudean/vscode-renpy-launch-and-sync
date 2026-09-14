import * as vscode from "vscode"
import { get_config } from "./config"
import { DialoguePosition, DialogueRange } from "./lex"

function position(place: DialoguePosition): vscode.Position {
	return new vscode.Position(place.line, place.column)
}

/** the stretch of script a piece of dialogue occupies */
export function dialogue_range(dialogue: DialogueRange): vscode.Range {
	return new vscode.Range(position(dialogue.start), position(dialogue.end))
}

/**
 * where follow cursor should leave the caret, or `undefined` to leave it where
 * the user put it
 */
export function cursor_selection(
	document: vscode.TextDocument,
	line: number,
	dialogue: DialogueRange | undefined
): vscode.Selection | undefined {
	const behavior = get_config("followCursorBehavior") as string

	if (line < 0 || line >= document.lineCount) return undefined

	const fallback = document.lineAt(line).range.end
	const start = dialogue ? position(dialogue.start) : fallback
	const end = dialogue ? position(dialogue.end) : fallback

	switch (behavior) {
		case "Select dialogue":
			return new vscode.Selection(start, end)

		case "Cursor at dialogue end":
			return new vscode.Selection(end, end)

		case "Cursor at line end": {
			const end_of_line = document.lineAt(end.line).range.end

			return new vscode.Selection(end_of_line, end_of_line)
		}

		default:
			return undefined
	}
}
