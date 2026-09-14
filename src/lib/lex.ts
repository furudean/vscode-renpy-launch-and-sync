/** where a piece of dialogue ends in the script */
export interface DialoguePosition {
	/** 0-indexed line number */
	line: number
	/** 0-indexed column */
	column: number
}

/** the parts of `vscode.TextDocument` this module needs */
export interface LineSource {
	lineCount: number
	lineAt(line: number): { text: string }
}

/**
 * String literal, as matched by `Lexer.string`. `"`, `'` and `` ` `` delimit.
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/lexer.py#L976
 */
const STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g

/**
 * Delimiter opening a monologue block, as matched by `Lexer.triple_string`.
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/lexer.py#L1033
 */
const TRIPLE_QUOTE = /r?("""|'''|```)/

/**
 * Delimiters the `rpy monologue` statement can set, most common first. A script
 * can pick any of them, and nothing in the reported dialogue says which, so
 * each is tried in turn.
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/parser.py#L1189
 */
const MONOLOGUE_DELIMITERS = ["\n\n", "\n", ""]

/**
 * A monologue paragraph of just this becomes an `nvl clear` statement rather
 * than a say statement, so it never holds dialogue.
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/parser.py#L1512
 */
const CLEAR_TAG = "{clear}"

/**
 * Text tags and interpolations, plus the escapes for their opening characters.
 * Ren'Py strips the dialogue tags among these from the text it displays.
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/character.py#L36
 */
const MARKUP = /\{\{|\[\[|\{[^{}]*\}|\[[^[\]]*\]/g

/**
 * Opens the say statement's argument list, or a comment. `finish_say` takes
 * the arguments after the text is already in hand, and the lexer drops
 * comments before parsing, so a string past either belongs to something else.
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/parser.py#L1495
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/lexer.py#L556
 */
const SAY_END = /[(#]/

/** lines to search for a monologue block's closing delimiter */
const MONOLOGUE_LINE_LIMIT = 500

/**
 * The whitespace collapsing the lexer applies to every string it reads.
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/lexer.py#L1027
 */
function collapse(text: string): string {
	return text.replace(/[ \n]+/g, " ").trim()
}

/**
 * Mirrors `dequote`, the escapes the lexer expands as it reads a string.
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/lexer.py#L1006
 */
function unescape(text: string): string {
	return text.replace(/\\(u[0-9a-fA-F]{1,4}|.)/g, (_, escape: string) => {
		if (escape.length > 1) {
			return String.fromCharCode(parseInt(escape.slice(1), 16))
		}

		return { n: "\n", "{": "{{", "[": "[[", "%": "%%" }[escape] ?? escape
	})
}

/**
 * Checks that every literal part of `source` appears in `what`, in order.
 * Returns the number of characters matched, or `undefined` if the text doesn't
 * line up.
 *
 * Markup is skipped rather than compared, since the script says `[name]` where
 * Ren'Py says `Sylvie`. Text that is only markup therefore matches anything,
 * which is what the returned count is for.
 */
function match_strength(source: string, what: string): number | undefined {
	let cursor = 0
	let strength = 0

	for (const part of source.split(MARKUP)) {
		const fragment = collapse(unescape(part))

		if (!fragment) continue

		const index = what.indexOf(fragment, cursor)

		if (index === -1) return undefined

		cursor = index + fragment.length
		strength += fragment.length
	}

	return strength
}

/** finds the dialogue in an ordinary say statement */
function find_in_literals(line_text: string, what: string): number | undefined {
	let best: { column: number; strength: number } | undefined
	let gap = 0 // where the text between literals starts

	for (const literal of line_text.matchAll(STRING_LITERAL)) {
		// the first string on the line is always a candidate, since a python
		// line can call `renpy.say()` with the dialogue as an argument
		if (gap > 0 && SAY_END.test(line_text.slice(gap, literal.index))) break

		gap = literal.index + literal[0].length

		const strength = match_strength(literal[2], what)

		if (strength === undefined) continue

		// later literals win ties, as the say statement's text comes last
		if (best && strength < best.strength) continue

		// the closing quote, so the cursor sits after the last character
		best = { column: literal.index + 1 + literal[2].length, strength }
	}

	return best?.column
}

interface BlockLine extends DialoguePosition {
	/** the line's text, or empty for the blank lines that separate paragraphs */
	text: string
}

/** reads the lines between a monologue block's delimiters */
function read_block(document: LineSource, line: number): BlockLine[] {
	const opener = TRIPLE_QUOTE.exec(document.lineAt(line).text)

	if (!opener) return []

	const delimiter = opener[1]
	const last_line = Math.min(
		line + MONOLOGUE_LINE_LIMIT,
		document.lineCount - 1
	)
	const block: BlockLine[] = []

	for (let n = line; n <= last_line; n++) {
		// the opening delimiter isn't part of the block's text
		const offset = n === line ? opener.index + opener[0].length : 0
		let text = document.lineAt(n).text.slice(offset)

		const close = text.indexOf(delimiter)

		if (close !== -1) text = text.slice(0, close)

		block.push({
			line: n,
			column: offset + text.trimEnd().length,
			text: collapse(text)
		})

		if (close !== -1) break
	}

	return block
}

/**
 * Splits a block the way the lexer splits on `monologue_delimiter`. Ren'Py
 * makes a statement of each piece, but reports them all on the line the block
 * opens on.
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/lexer.py#L1084
 */
function split_block(
	block: readonly BlockLine[],
	delimiter: string
): BlockLine[] {
	const paragraphs: BlockLine[] = []
	let open = false // whether the last paragraph still takes lines

	for (const { line, column, text } of block) {
		if (!text) {
			if (delimiter === "\n\n") open = false
			continue
		}

		if (open) {
			// a paragraph ends wherever its last line does
			const paragraph = paragraphs[paragraphs.length - 1]

			paragraph.text += " " + text
			paragraph.line = line
			paragraph.column = column
		} else {
			paragraphs.push({ line, column, text })
			open = delimiter !== "\n"
		}
	}

	return paragraphs
}

/** the paragraph of a monologue block most likely to be the one being said */
function best_paragraph(
	paragraphs: BlockLine[],
	what: string
): BlockLine | undefined {
	let best: { paragraph: BlockLine; strength: number } | undefined

	for (const paragraph of paragraphs) {
		if (paragraph.text === CLEAR_TAG) continue

		const strength = match_strength(paragraph.text, what)

		if (strength === undefined) continue

		// paragraphs of pure markup match anything, so the paragraph with the
		// most text in common wins
		if (best && strength <= best.strength) continue

		best = { paragraph, strength }
	}

	return best?.paragraph
}

/**
 * Returns where in the script the dialogue `what` ends, starting from the line
 * Ren'Py reported, or `undefined` if the script doesn't recognizably contain
 * it. Games that transform their dialogue before displaying it fall into the
 * latter case.
 */
export function find_dialogue_position(
	document: LineSource,
	line: number,
	what: string
): DialoguePosition | undefined {
	if (line < 0 || line >= document.lineCount) return undefined

	const needle = collapse(what)
	const line_text = document.lineAt(line).text

	// a monologue block holds the dialogue of every statement it makes, so
	// there's nothing to find on the line itself
	if (TRIPLE_QUOTE.test(line_text)) {
		const block = read_block(document, line)

		for (const delimiter of MONOLOGUE_DELIMITERS) {
			const paragraph = best_paragraph(split_block(block, delimiter), needle)

			if (paragraph) return { line: paragraph.line, column: paragraph.column }
		}

		return undefined
	}

	const column = find_in_literals(line_text, needle)

	return column === undefined ? undefined : { line, column }
}
