import type { LineSource } from "./dialogue"

/** a statement ren'py's parser makes a node of */
export interface Statement {
	/** 0-indexed line the statement starts on */
	line: number
	/**
	 * 0-indexed line ren'py declares.
	 *
	 * NOTE: It falls behind `line` past a string that escapes a newline, where
	 * ren'py miscounts. See: {@link scan}
	 */
	warp_line: number
	/** 0-indexed line the statement's logical line ends on */
	end_line: number
	/** the keyword the parser dispatches on, or `say` for dialogue */
	keyword: string
	/**
	 * whether warping here runs the script. statements that only define things
	 * are nodes like any other, but ren'py has nowhere to go after them
	 */
	warpable: boolean
	/**
	 * whether the game comes to rest here. it runs on through anything that
	 * doesn't ask the player for something, so warping to one of those leaves
	 * the game somewhere further down the script
	 */
	stops: boolean
}

/** the parts of `vscode.TextDocument` the statement cache needs */
export interface CachedSource extends LineSource {
	version: number
	uri: { toString(): string }
}

/**
 * What a block of lines holds.
 *
 * - `script` for statements, the body of a label among them
 * - `menu` for a menu's choices and captions, which are part of its node
 * - `opaque` for anything that isn't statements, such as python and atl
 */
type BlockKind = "script" | "menu" | "opaque"

interface Context {
	kind: BlockKind
	/** whether statements here run as part of the game, rather than at init */
	runtime: boolean
}

/** what a logical line is, and what the lines indented under it are */
interface Classified {
	statement?: { keyword: string; warpable: boolean; stops: boolean }
	block: Context
}

interface LogicalLine {
	/** 0-indexed line the logical line starts on */
	line: number
	/** the line ren'py reports (sometimes wrong) */
	warp_line: number
	/** 0-indexed line it ends on, past any strings or brackets spanning lines */
	end_line: number
	/** columns of indentation */
	indent: number
	/** the text of every physical line, comments stripped */
	text: string
}

/** the string delimiters the lexer recognises */
const QUOTES = `"'\``

/** how a physical line leaves the lexer at its end */
interface ScanState {
	/** a string the line opens and doesn't close */
	string?: { quote: string; size: number }
	/** brackets opened and not closed */
	depth: number
	/** the line ends in a backslash, so the next one continues it */
	continued: boolean
}

/**
 * Reads one physical line, returning its text without the comment and the
 * state the lexer is left in.
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/lexer.py#L319
 */
function scan(
	text: string,
	state: ScanState
): { text: string; state: ScanState; ate_newline: boolean } {
	let open = state.string
	let depth = state.depth
	let continued = false
	let ate_newline = false
	let pos = 0
	let end = text.length

	while (pos < text.length) {
		const char = text[pos]

		if (open) {
			// a backslash escapes the next character, the newline included
			if (char === "\\") {
				// RENPY BUG! `while c == "\\": pos += 2` steps over
				// the escaped character without asking what it was, so a
				// newline escaped inside a string never reaches the `number +=
				// 1` below it. Ren'Py then names every statement past the
				// string a line lower than it really sits, and a warp has to
				// use ren'py's number to land in the right place.
				// @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/lexer.py#L404
				if (pos === text.length - 1) ate_newline = true

				pos += 2
				continue
			}

			if (char === open.quote) {
				let run = 0

				while (text[pos + run] === open.quote) run += 1

				if (run >= open.size) {
					pos += open.size
					open = undefined
				} else {
					pos += run
				}

				continue
			}

			pos += 1
			continue
		}

		if (char === "#") {
			end = pos
			break
		}

		if (QUOTES.includes(char)) {
			if (text[pos + 1] === char && text[pos + 2] === char) {
				open = { quote: char, size: 3 }
				pos += 3
			} else if (text[pos + 1] === char) {
				pos += 2 // an empty string
			} else {
				open = { quote: char, size: 1 }
				pos += 1
			}

			continue
		}

		if ("([{".includes(char)) {
			depth += 1
		} else if (")]}".includes(char)) {
			depth = Math.max(0, depth - 1)
		} else if (char === "\\" && pos === text.length - 1) {
			continued = true
		}

		pos += 1
	}

	return {
		text: text.slice(0, end),
		state: { string: open, depth, continued },
		ate_newline
	}
}

/**
 * Divides the script into logical lines the way the lexer does. Strings,
 * brackets and backslashes all carry a statement on to the next line, so a
 * physical line needn't start anything.
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/lexer.py#L319
 */
function logical_lines(document: LineSource): LogicalLine[] {
	const lines: LogicalLine[] = []
	let state: ScanState = { depth: 0, continued: false }
	let current: LogicalLine | undefined

	// how many lines ren'py's counter has dropped so far, which is how far
	// behind the editor its numbering runs from here down
	let lost = 0

	for (let n = 0; n < document.lineCount; n++) {
		const raw = document.lineAt(n).text

		if (!current) {
			const rest = raw.trimStart()

			// blank and comment-only lines are no part of any statement
			if (!rest || rest.startsWith("#")) continue

			current = {
				line: n,
				warp_line: n - lost,
				end_line: n,
				indent: raw.length - rest.length,
				text: ""
			}
		}

		const scanned = scan(raw, state)

		if (scanned.ate_newline) lost += 1

		state = scanned.state
		current.end_line = n
		current.text = current.text
			? current.text + " " + scanned.text.trim()
			: scanned.text.trim()

		if (state.string || state.depth > 0 || state.continued) continue

		lines.push(current)
		current = undefined
	}

	// a string or bracket left open runs to the end of the file
	if (current) lines.push(current)

	return lines
}

/** the words a statement starts with, enough of them to tell statements apart */
function leading_words(text: string): string[] {
	return text.split(/[^0-9a-zA-Z_]+/, 3).filter(Boolean)
}

/**
 * A string literal, or a name, then a string literal. Matches a say statement
 * and the say menuitem a menu can open with, but not a caption, which is a
 * string on its own.
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/parser.py#L1571
 */
const SAY = /^(?:(["'`])(?:\\.|(?!\1)[^\\])*\1|[a-zA-Z_][\w.]*)[^"'`]*["'`]/

/**
 * Statements that define something rather than doing it. Ren'Py runs them
 * during init, so warping to one leaves the game with nothing to play.
 */
const DEFINITIONS = new Set([
	"define",
	"default",
	"image",
	"layeredimage",
	"screen",
	"style",
	"transform",
	"testcase",
	"testsuite"
])

/**
 * Statements ren'py runs and carries straight on from. Creator-defined
 * statements can be anything at all, so a keyword missing here is read as one
 * that waits, which is the safer guess.
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/common/000statements.rpy
 */
const PASSING_STATEMENTS = new Set([
	"call",
	"camera",
	"hide",
	"jump",
	"nvl",
	"pass",
	"play",
	"queue",
	"return",
	"scene",
	"show",
	"stop",
	"voice",
	"window",
	"with"
])

/** what to call the statement on a line the parser dispatches no keyword on */
function name_of(text: string, first: string | undefined): string {
	if (first && (PASSING_STATEMENTS.has(first) || first === "pause"))
		return first

	// dialogue reads as a name or string and then the text being said, which a
	// statement taking a string argument does too, so the name is a guess
	return SAY.test(text) ? "say" : (first ?? "say")
}

/**
 * Sorts one logical line into the node ren'py makes of it, if any, and the
 * kind of block that follows it.
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/parser.py#L1618
 */
function classify(text: string, context: Context): Classified {
	const { runtime } = context

	// python, atl and screen language are not statements, and neither is
	// anything nested inside them
	if (context.kind === "opaque") return { block: context }

	if (context.kind === "menu") {
		// a choice's block holds statements, while the choice itself, along
		// with captions and the `set` and `with` clauses, is part of the menu
		if (text.endsWith(":")) return { block: { kind: "script", runtime } }

		if (SAY.test(text)) {
			return {
				statement: { keyword: "say", warpable: runtime, stops: true },
				block: { kind: "opaque", runtime }
			}
		}

		return { block: { kind: "opaque", runtime } }
	}

	const opaque: Context = { kind: "opaque", runtime }

	if (text.startsWith("$")) {
		return {
			statement: { keyword: "$", warpable: runtime, stops: false },
			block: opaque
		}
	}

	// a line opening with a string is narration, and the words inside it are
	// text rather than a keyword the parser dispatches on
	if (QUOTES.includes(text[0])) {
		return {
			statement: { keyword: "say", warpable: runtime, stops: true },
			block: opaque
		}
	}

	const [first, second, third] = leading_words(text)

	switch (first) {
		// a label's body runs when the game reaches it, whether the label was
		// declared at init or not
		case "label":
			return {
				statement: { keyword: "label", warpable: true, stops: false },
				block: { kind: "script", runtime: true }
			}

		case "init":
			if (second === "label") {
				return {
					statement: { keyword: "init label", warpable: true, stops: false },
					block: { kind: "script", runtime: true }
				}
			}

			if (second === "python") {
				return {
					statement: {
						keyword: "init python",
						warpable: false,
						stops: false
					},
					block: opaque
				}
			}

			if (second === "offset") {
				return {
					statement: {
						keyword: "init offset",
						warpable: false,
						stops: false
					},
					block: opaque
				}
			}

			return {
				statement: { keyword: "init", warpable: false, stops: false },
				block: { kind: "script", runtime: false }
			}

		// `python early` is read before the script runs, the rest is a node in
		// the flow like any other
		case "python":
			return {
				statement: {
					keyword: second === "early" ? "python early" : "python",
					warpable: runtime && second !== "early",
					stops: false
				},
				block: opaque
			}

		case "if":
		case "while":
			return {
				statement: { keyword: first, warpable: runtime, stops: false },
				block: { kind: "script", runtime }
			}

		// ren'py folds these into the `if` statement above them, so there is no
		// node of their own to warp to
		case "elif":
		case "else":
			return { block: { kind: "script", runtime } }

		case "menu":
			return {
				statement: { keyword: "menu", warpable: runtime, stops: true },
				block: { kind: "menu", runtime }
			}

		// `extend` says the line above it again with more text on the end, and
		// a warp leaves it nothing to add to
		// @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/common/00library.rpy#L230
		case "extend":
			return {
				statement: { keyword: "extend", warpable: false, stops: true },
				block: opaque
			}

		// `call screen` shows a screen and waits on it, while calling a label
		// leaves for the label
		case "call":
			return {
				statement: {
					keyword: second === "screen" ? "call screen" : "call",
					warpable: runtime,
					stops: second === "screen"
				},
				block: opaque
			}

		// a translation only runs in its own language, so ren'py has nothing to
		// play after warping into one. the identifier past the language says
		// whether the block holds statements or python, style or string pairs
		case "translate":
			return {
				statement: { keyword: "translate", warpable: false, stops: false },
				block: ["python", "style", "strings"].includes(third)
					? opaque
					: { kind: "script", runtime: false }
			}

		case "rpy":
			return {
				statement: {
					keyword: `rpy ${second ?? ""}`.trim(),
					warpable: false,
					stops: false
				},
				block: opaque
			}
	}

	if (DEFINITIONS.has(first)) {
		return {
			statement: { keyword: first, warpable: false, stops: false },
			block: opaque
		}
	}

	// dialogue, or one of the many statements that behave like it. a statement
	// the extension doesn't know is a creator-defined one, which ren'py makes a
	// node of just the same
	return {
		statement: {
			keyword: name_of(text, first),
			warpable: runtime,
			stops: !PASSING_STATEMENTS.has(first)
		},
		block: opaque
	}
}

/**
 * Reads the statements ren'py's parser would find in the script, in the order
 * they appear.
 */
export function parse_statements(document: LineSource): Statement[] {
	const statements: Statement[] = []
	const stack: { indent: number; context: Context }[] = [
		{ indent: 0, context: { kind: "script", runtime: true } }
	]
	let previous: { indent: number; block: Context } | undefined

	for (const line of logical_lines(document)) {
		if (previous && line.indent > previous.indent) {
			stack.push({ indent: line.indent, context: previous.block })
		} else {
			// a dedent closes every block indented past this line
			while (stack.length > 1 && line.indent < stack[stack.length - 1].indent) {
				stack.pop()
			}
		}

		const { statement, block } = classify(
			line.text,
			stack[stack.length - 1].context
		)

		if (statement) {
			statements.push({
				line: line.line,
				warp_line: line.warp_line,
				end_line: line.end_line,
				...statement
			})
		}

		previous = { indent: line.indent, block }
	}

	return statements
}

/**
 * The statement ren'py warps to when asked for editor `line`, which is the last
 * one starting at or before it. Ren'Py gives up entirely if there is none.
 * @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/warp.py#L136
 */
export function warp_target(
	statements: readonly Statement[],
	line: number
): Statement | undefined {
	let target: Statement | undefined

	for (const statement of statements) {
		if (statement.line > line) break

		target = statement
	}

	return target
}

/**
 * Turns a line ren'py reports back into the editor line it sits on, undoing
 * the miscount {@link scan} describes. Lines ren'py never lost come back
 * unchanged, which is every line in most files.
 */
export function editor_line(
	statements: readonly Statement[],
	warp_line: number
): number {
	let skew = 0

	// statements come in order and ren'py only ever falls further behind, so
	// the last one at or before the reported line carries the skew that applies
	for (const statement of statements) {
		if (statement.warp_line > warp_line) break

		skew = statement.line - statement.warp_line
	}

	return warp_line + skew
}

/** the first statement the game comes to rest on at or after editor `line` */
export function next_resting_statement(
	statements: readonly Statement[],
	line: number
): Statement | undefined {
	return statements.find(
		(statement) =>
			statement.line >= line && statement.warpable && statement.stops
	)
}

/** why warping to `line` was refused, in words for the user */
export function warp_refusal(
	target: Statement | undefined,
	line: number
): string {
	if (target === undefined) return `Nothing to warp to on line ${line + 1}`

	if (!target.warpable) return `Can't warp to ${target.keyword} statements`

	return `Ren'Py wouldn't stay on ${target.keyword} statements`
}

/** how many documents to keep parsed at a time */
const CACHE_SIZE = 8

const cache = new Map<string, { version: number; statements: Statement[] }>()

/** reads the statements of a document, parsing it again when it changes */
export function get_statements(document: CachedSource): readonly Statement[] {
	const key = document.uri.toString()
	const hit = cache.get(key)

	if (hit?.version === document.version) {
		// re-insert so a document in use outlives the ones that aren't
		cache.delete(key)
		cache.set(key, hit)

		return hit.statements
	}

	const statements = parse_statements(document)

	cache.delete(key)
	cache.set(key, { version: document.version, statements })

	for (const stale of Array.from(cache.keys()).slice(0, -CACHE_SIZE)) {
		cache.delete(stale)
	}

	return statements
}
