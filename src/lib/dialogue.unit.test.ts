import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
	find_dialogue_range,
	type LineSource,
	type SaidRange
} from "./dialogue.ts"

function read(script: string): { document: LineSource; lines: string[] } {
	const lines = script.split("\n")

	return {
		lines,
		document: {
			lineCount: lines.length,
			lineAt: (n) => ({ text: lines[n] })
		}
	}
}

/**
 * Runs a script through the resolver and marks where the cursor lands with a
 * `|`, so a failure reads as the line the editor would show.
 */
function cursor(
	script: string,
	line: number,
	what: string,
	said?: SaidRange
): string | undefined {
	const { document, lines } = read(script)
	const range = find_dialogue_range(document, line, what, said)

	if (!range) return undefined

	const text = lines[range.end.line]

	return text.slice(0, range.end.column) + "|" + text.slice(range.end.column)
}

function selection(
	script: string,
	line: number,
	what: string,
	said?: SaidRange
): string | undefined {
	const { document, lines } = read(script)
	const range = find_dialogue_range(document, line, what, said)

	if (!range) return undefined

	const marked = lines.slice(range.start.line, range.end.line + 1)
	const last = marked.length - 1

	marked[last] =
		marked[last].slice(0, range.end.column) +
		"]" +
		marked[last].slice(range.end.column)
	marked[0] =
		marked[0].slice(0, range.start.column) +
		"[" +
		marked[0].slice(range.start.column)

	return marked.join("\n")
}

describe("say statements", () => {
	test("puts the cursor after the dialogue", () => {
		assert.equal(
			cursor(`    e "Hello, world!"`, 0, "Hello, world!"),
			`    e "Hello, world!|"`
		)
	})

	test("takes the say statement's text, not the character's name", () => {
		assert.equal(
			cursor(`    "Sylvie" "Hi there!"`, 0, "Hi there!"),
			`    "Sylvie" "Hi there!|"`
		)
	})

	test("ignores say arguments", () => {
		assert.equal(
			cursor(`    e "Hi" (what_color="#f00")`, 0, "Hi"),
			`    e "Hi|" (what_color="#f00")`
		)
	})

	test("ignores say arguments that tie with the dialogue", () => {
		// dialogue that is only markup matches anything, and so does an empty
		// argument, so the argument must be out of the running entirely
		assert.equal(
			cursor(`    e "[line]" (what_suffix="")`, 0, "anything"),
			`    e "[line]|" (what_suffix="")`
		)
	})

	test("ignores a comment repeating the dialogue", () => {
		assert.equal(
			cursor(`    e "Hello" # "Hello"`, 0, "Hello"),
			`    e "Hello|" # "Hello"`
		)
	})

	test("reads dialogue passed to `renpy.say()`", () => {
		assert.equal(
			cursor(`    $ renpy.say(e, "Hi there!")`, 0, "Hi there!"),
			`    $ renpy.say(e, "Hi there!|")`
		)
	})

	test("reads every string delimiter ren'py allows", () => {
		assert.equal(cursor(`    e 'single'`, 0, "single"), `    e 'single|'`)
		assert.equal(cursor("    e `tick`", 0, "tick"), "    e `tick|`")
	})

	test("handles an empty say statement", () => {
		assert.equal(cursor(`    e ""`, 0, ""), `    e "|"`)
	})

	test("gives up on dialogue the script doesn't contain", () => {
		// the game transformed its text, or translated it
		assert.equal(cursor(`    e "Good morning"`, 0, "Bonjour"), undefined)
	})

	test("gives up on a line past the end of the file", () => {
		assert.equal(cursor(`    e "hi"`, 9, "hi"), undefined)
	})

	test("follows a string onto the lines below it", () => {
		const script = [`    e "Hello,`, `        world!"`].join("\n")

		assert.equal(
			selection(script, 0, "Hello, world!"),
			[`    e "[Hello,`, `        world!]"`].join("\n")
		)
	})

	test("follows a string past an escaped newline", () => {
		const script = [`    e "Hello, \\`, `        world!"`].join("\n")

		assert.equal(
			selection(script, 0, "Hello, world!"),
			[`    e "[Hello, \\`, `        world!]"`].join("\n")
		)
	})

	test("leaves a string on the next line alone", () => {
		assert.equal(
			cursor([`    e "Hello"`, `    "Hello"`].join("\n"), 0, "Hello"),
			`    e "Hello|"`
		)
	})
})

describe("text ren'py has already processed", () => {
	test("matches around interpolation", () => {
		const script = `    e "Hello, [name]!"`

		assert.equal(cursor(script, 0, "Hello, [name]!"), `    e "Hello, [name]!|"`)
		assert.equal(cursor(script, 0, "Hello, Meri!"), `    e "Hello, [name]!|"`)
	})

	test("matches around text tags dropped from the displayed text", () => {
		const script = `    e "Hi {b}there{/b}{w} friend."`

		assert.equal(
			cursor(script, 0, "Hi {b}there{/b} friend."),
			`    e "Hi {b}there{/b}{w} friend.|"`
		)
	})

	test("expands the escapes the lexer expands", () => {
		assert.equal(
			cursor(`    e "she said \\"no\\""`, 0, 'she said "no"'),
			`    e "she said \\"no\\"|"`
		)
		assert.equal(
			cursor(`    e "50\\{50 chance"`, 0, "50{{50 chance"),
			`    e "50\\{50 chance|"`
		)
		assert.equal(
			cursor(`    e "50{{50 chance"`, 0, "50{{50 chance"),
			`    e "50{{50 chance|"`
		)
		assert.equal(
			cursor(`    e "100\\% sure"`, 0, "100%% sure"),
			`    e "100\\% sure|"`
		)
		assert.equal(cursor(`    e "caf\\u00e9"`, 0, "café"), `    e "caf\\u00e9|"`)
		assert.equal(
			cursor(`    e "one\\ntwo"`, 0, "one\ntwo"),
			`    e "one\\ntwo|"`
		)
	})

	test("gives up on interpolation holding brackets of its own", () => {
		// `[items[0]]` doesn't parse as one piece, so the line falls back to
		// the plain end-of-line cursor rather than landing somewhere wrong
		assert.equal(
			cursor(`    e "you have [items[0]] left"`, 0, "you have 3 left"),
			undefined
		)
	})

	test("collapses whitespace the way the lexer does", () => {
		assert.equal(
			cursor(`    e "a  double   space"`, 0, "a double space"),
			`    e "a  double   space|"`
		)
	})
})

describe("monologue blocks", () => {
	// ren'py reports every say statement in a block on the line it opens on, so
	// the dialogue is the only thing telling them apart
	const script = [
		`label ch1:`,
		`    """`,
		`    "What time is it? The clock in the truck doesn't work."`,
		``,
		`    "It's 6:13."`,
		``,
		`    "That's not so bad. We start at 7. No problem."`,
		`    """`
	].join("\n")

	test("finds the paragraph being said", () => {
		assert.equal(cursor(script, 1, `"It's 6:13."`), `    "It's 6:13."|`)
		assert.equal(
			cursor(script, 1, `"That's not so bad. We start at 7. No problem."`),
			`    "That's not so bad. We start at 7. No problem."|`
		)
	})

	test("gives up rather than landing on the opening delimiter", () => {
		assert.equal(cursor(script, 1, "not in this block"), undefined)
	})

	test("ends a paragraph on its last line", () => {
		const wrapped = [
			`    e """`,
			`    one line`,
			`    and its continuation`,
			``,
			`    second paragraph`,
			`    """`
		].join("\n")

		assert.equal(
			cursor(wrapped, 0, "one line and its continuation"),
			`    and its continuation|`
		)
		assert.equal(
			cursor(wrapped, 0, "second paragraph"),
			`    second paragraph|`
		)
	})

	test("splits on a single newline when `rpy monologue single` is set", () => {
		const single = [
			`    """`,
			`    first line`,
			`    second line`,
			`    """`
		].join("\n")

		assert.equal(cursor(single, 0, "second line"), `    second line|`)
	})

	test("keeps the block whole when `rpy monologue none` is set", () => {
		const none = [`    """`, `    all of`, `    this at once`, `    """`].join(
			"\n"
		)

		assert.equal(cursor(none, 0, "all of this at once"), `    this at once|`)
	})

	test("reads text sharing a line with a delimiter", () => {
		const tight = [`    n """first bit`, `    continues here"""`].join("\n")

		assert.equal(
			cursor(tight, 0, "first bit continues here"),
			`    continues here|"""`
		)
	})

	test("skips `{clear}`, which is an nvl statement rather than dialogue", () => {
		const nvl = [
			`    """`,
			`    {clear}`,
			``,
			`    Actual dialogue.`,
			`    """`
		].join("\n")

		assert.equal(cursor(nvl, 0, "Actual dialogue."), `    Actual dialogue.|`)
	})

	test("prefers the paragraph with the most text in common", () => {
		// a paragraph of pure markup matches anything, so it must not win over
		// one that actually shares text
		const markup = [
			`    """`,
			`    [nickname]`,
			``,
			`    Hello, [nickname]!`,
			`    """`
		].join("\n")

		assert.equal(cursor(markup, 0, "Hello, Sylvie!"), `    Hello, [nickname]!|`)
	})

	test("stops looking for a delimiter that never comes", () => {
		const unclosed = [`    """`, ...Array(2000).fill(`    filler`)].join("\n")

		assert.equal(cursor(unclosed, 0, "nowhere to be found"), undefined)
	})
})

describe("dialogue pauses", () => {
	// at every pause, ren'py reports how much of the dialogue it has said,
	// counted in the characters of the text the lexer read

	test("selects the stretch of dialogue being said", () => {
		const script = `    e "Hi{w} there.{w} bye."`
		const what = `Hi{w} there.{w} bye.`

		assert.equal(
			selection(script, 0, what, { from: 0, to: what.indexOf("{w}") }),
			`    e "[Hi{w}] there.{w} bye."`
		)
		assert.equal(
			selection(script, 0, what, {
				from: what.indexOf("{w}"),
				to: what.lastIndexOf("{w}")
			}),
			`    e "Hi{w} [there.{w}] bye."`
		)
		assert.equal(
			selection(script, 0, what, {
				from: what.lastIndexOf("{w}"),
				to: what.length
			}),
			`    e "Hi{w} there.{w} [bye.]"`
		)
	})

	test("selects the whole dialogue when nothing pauses it", () => {
		assert.equal(
			selection(`    e "Hello, world!"`, 0, "Hello, world!"),
			`    e "[Hello, world!]"`
		)
	})

	test("selects the whole dialogue when a pause ends it", () => {
		const what = "Hello{w}"

		assert.equal(
			selection(`    e "Hello{w}"`, 0, what, { from: 5, to: what.length }),
			`    e "[Hello{w}]"`
		)
	})

	test("selects the stretch being said across lines", () => {
		const script = [`    e "Hi{w}`, `        there."`].join("\n")
		const what = "Hi{w} there."

		assert.equal(
			selection(script, 0, what, { from: 0, to: what.indexOf("{w}") }),
			`    e "[Hi{w}]`
		)
		assert.equal(
			selection(script, 0, what, {
				from: what.indexOf("{w}"),
				to: what.length
			}),
			`        [there.]"`
		)
	})

	test("lands where the script has no tag at all", () => {
		// a `say_menu_text_filter` puts pauses of its own into the dialogue, so
		// the position ren'py reports needn't sit on anything in particular
		const script = `    e "It was August. The window rolled down."`
		const what = `It was August. The window rolled down.`

		assert.equal(
			selection(script, 0, what, { from: 0, to: "It was August.".length }),
			`    e "[It was August.] The window rolled down."`
		)
	})

	test("counts the characters the lexer read, not the ones in the file", () => {
		// `\"` is one character to ren'py and two in the file, `\{` is two to
		// both, and a run of spaces is one
		assert.equal(
			cursor(
				`    e "she said \\"no\\" then{w} left"`,
				0,
				`she said "no" then{w} left`,
				{ from: 0, to: `she said "no" then`.length }
			),
			`    e "she said \\"no\\" then{w}| left"`
		)
		assert.equal(
			cursor(`    e "50\\{50  chance{w} ok"`, 0, `50{{50 chance{w} ok`, {
				from: 0,
				to: `50{{50 chance`.length
			}),
			`    e "50\\{50  chance{w}| ok"`
		)
	})

	test("falls back to the ends of the dialogue", () => {
		// the script is shorter than the text ren'py said, so a filter added
		// text of its own and the offsets can't be trusted
		assert.equal(
			selection(`    e "short"`, 0, "short", { from: 40, to: 80 }),
			`    e "[short]"`
		)
	})

	test("finds a pause inside a monologue block", () => {
		const block = [
			`    """`,
			`    first line{w} keeps going`,
			`    and ends here`,
			`    """`
		].join("\n")
		const paragraph = `first line{w} keeps going and ends here`

		assert.equal(
			selection(block, 0, paragraph, {
				from: 0,
				to: paragraph.indexOf("{w}")
			}),
			`    [first line{w}] keeps going`
		)
		assert.equal(
			cursor(block, 0, paragraph, {
				from: 0,
				to: `first line{w} keeps going and`.length
			}),
			`    and| ends here`
		)
		assert.equal(
			selection(block, 0, paragraph),
			[`    [first line{w} keeps going`, `    and ends here]`].join("\n")
		)
	})
})
