/** where a piece of dialogue ends in the script */
export interface DialoguePosition {
	/** 0-indexed line number */
	line: number
	/** 0-indexed column */
	column: number
}

/** the stretch of script a say statement is saying */
export interface DialogueRange {
	/** where the text being said starts */
	start: DialoguePosition
	/** where it ends */
	end: DialoguePosition
}

/** how much of a say statement ren'py has said, in characters of its text */
export interface SaidRange {
	from: number
	to: number
}

/** the parts of `vscode.TextDocument` this module needs */
export interface LineSource {
	lineCount: number
	lineAt(line: number): { text: string }
}

interface Segment {
	/** 0-indexed line number */
	line: number
	start: number
	end: number
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
 * A tag that pauses the dialogue, anchored so it can be recognised at a
 * position. The cursor reads better past one of these than in front of it.
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/character.py#L36
 */
const PAUSE_TAG = /^\{(?:[wp](?:=[^}]*)?|nw=[^}]*)\}/

/**
 * An escape the lexer expands, matched at the start of the text.
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/lexer.py#L1006
 */
const ESCAPE = /^\\(u[0-9a-fA-F]{1,4}|.)/

/** the escapes that become two characters, since ren'py reads the text again */
const DOUBLED_ESCAPE = /^[{[%]$/

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
function find_in_literals(
	line_text: string,
	what: string
): { start: number; end: number } | undefined {
	let best: { start: number; end: number; strength: number } | undefined
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

		best = {
			start: literal.index + 1,
			// the closing quote, so the cursor sits after the last character
			end: literal.index + 1 + literal[2].length,
			strength
		}
	}

	if (!best) return undefined

	return { start: best.start, end: best.end }
}

interface BlockLine extends Segment {
	/** the line's text, or empty for the blank lines that separate paragraphs */
	text: string
}

/** one say statement's worth of text in a monologue block */
interface Paragraph {
	/** the text, as the lexer reads it */
	text: string
	/** the lines of script the text comes from */
	lines: BlockLine[]
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

		// the lexer trims every line of a block before joining them
		block.push({
			line: n,
			start: offset + (text.length - text.trimStart().length),
			end: offset + text.trimEnd().length,
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
): Paragraph[] {
	const paragraphs: Paragraph[] = []
	let open = false // whether the last paragraph still takes lines

	for (const block_line of block) {
		if (!block_line.text) {
			if (delimiter === "\n\n") open = false
			continue
		}

		if (open) {
			const paragraph = paragraphs[paragraphs.length - 1]

			paragraph.text += " " + block_line.text
			paragraph.lines.push(block_line)
		} else {
			paragraphs.push({ text: block_line.text, lines: [block_line] })
			open = delimiter !== "\n"
		}
	}

	return paragraphs
}

/** the paragraph of a monologue block most likely to be the one being said */
function best_paragraph(
	paragraphs: Paragraph[],
	what: string
): Paragraph | undefined {
	let best: { paragraph: Paragraph; strength: number } | undefined

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

/** moves a position past a pause tag, which ren'py counts as part of the text */
function skip_tag(
	document: LineSource,
	at: DialoguePosition
): DialoguePosition {
	const tag = PAUSE_TAG.exec(document.lineAt(at.line).text.slice(at.column))

	return tag ? { line: at.line, column: at.column + tag[0].length } : at
}

/** moves a position past the space a pause leaves in front of the next word */
function skip_space(
	document: LineSource,
	at: DialoguePosition
): DialoguePosition {
	const text = document.lineAt(at.line).text
	let column = at.column

	while (text[column] === " ") column += 1

	return { line: at.line, column }
}

/**
 * Walks the script the way the lexer reads it, stopping once `offset`
 * characters has gone by
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/lexer.py#L1024
 */
function find_offset(
	document: LineSource,
	segments: readonly Segment[],
	offset: number
): DialoguePosition | undefined {
	let count = 0 // characters of the string the lexer has produced

	for (const [index, segment] of segments.entries()) {
		const text = document
			.lineAt(segment.line)
			.text.slice(segment.start, segment.end)

		// the lexer joins the lines of a paragraph with a single space
		if (index > 0) count += 1

		let column = 0

		while (column < text.length) {
			if (count >= offset) {
				return { line: segment.line, column: segment.start + column }
			}

			if (text[column] === " ") {
				// runs of whitespace collapse into one space
				while (text[column] === " ") column += 1
				count += 1
				continue
			}

			const escape = ESCAPE.exec(text.slice(column))

			if (escape) {
				count += DOUBLED_ESCAPE.test(escape[1]) ? 2 : 1
				column += escape[0].length
				continue
			}

			count += 1
			column += 1
		}
	}

	return undefined
}

/**
 * Returns the stretch of script holding the dialogue `what`, starting from the
 * line Ren'Py reported.
 *
 * `said` narrows the range to the section Ren'Py is saying right now, which is
 * the whole of the dialogue until a `{w}` pause splits it up.
 */
export function find_dialogue_range(
	document: LineSource,
	line: number,
	what: string,
	said?: SaidRange
): DialogueRange | undefined {
	if (line < 0 || line >= document.lineCount) return undefined

	const needle = collapse(what)
	const line_text = document.lineAt(line).text
	let segments: Segment[] | undefined

	// a monologue block holds the dialogue of every statement it makes, so
	// there's nothing to find on the line itself
	if (TRIPLE_QUOTE.test(line_text)) {
		const block = read_block(document, line)

		for (const delimiter of MONOLOGUE_DELIMITERS) {
			const paragraph = best_paragraph(split_block(block, delimiter), needle)

			if (paragraph) {
				segments = paragraph.lines
				break
			}
		}
	} else {
		const literal = find_in_literals(line_text, needle)

		if (literal) segments = [{ line, ...literal }]
	}

	if (!segments) return undefined

	const first = segments[0]
	const last = segments[segments.length - 1]
	const whole = {
		start: { line: first.line, column: first.start },
		end: { line: last.line, column: last.end }
	}

	if (!said) return whole

	const from = find_offset(document, segments, said.from)
	const to = find_offset(document, segments, said.to)

	return {
		start: from ? skip_space(document, skip_tag(document, from)) : whole.start,
		end: to ? skip_tag(document, to) : whole.end
	}
}
