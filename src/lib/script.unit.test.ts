import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
	editor_line,
	get_statements,
	next_resting_statement,
	parse_statements,
	warp_target,
	type Statement
} from "./script.ts"
import type { LineSource } from "./dialogue.ts"

function read(script: string): LineSource {
	const lines = script.split("\n")

	return {
		lineCount: lines.length,
		lineAt: (n) => ({ text: lines[n] })
	}
}

/** the statements of a script, as `line keyword` pairs */
function statements(script: string): string[] {
	return parse_statements(read(script)).map(
		(statement) =>
			`${statement.line} ${statement.keyword}` +
			(statement.warpable ? "" : " (no warp)") +
			(statement.end_line === statement.line ? "" : `-${statement.end_line}`) +
			(statement.warp_line === statement.line
				? ""
				: ` (ren'py calls it ${statement.warp_line})`)
	)
}

/** the statement ren'py would warp to, as the `line keyword` it starts at */
function target(script: string, line: number): string | undefined {
	const found = warp_target(parse_statements(read(script)), line)

	if (!found) return undefined

	return `${found.line} ${found.keyword}` + (found.warpable ? "" : " (no warp)")
}

/** whether following the cursor would warp to `line`, and where */
function warp(script: string, line: number): string | undefined {
	const target = warp_target(parse_statements(read(script)), line)

	if (!target?.warpable || !target.stops) return undefined

	return `${target.line} ${target.keyword}`
}

describe("logical lines", () => {
	test("skips blank lines and comments", () => {
		const script = [
			`# a comment`,
			``,
			`label start:`,
			`    # another comment`,
			`    e "Hello!"`
		].join("\n")

		assert.deepEqual(statements(script), ["2 label", "4 say"])
	})

	test("reads past a comment on a statement's line", () => {
		assert.deepEqual(statements(`label start: # go`), ["0 label"])
	})

	test("keeps a string holding a comment character whole", () => {
		assert.deepEqual(statements(`e "one # two"`), ["0 say"])
	})

	test("takes a monologue block as the one statement it is", () => {
		const script = [
			`label ch1:`,
			`    """`,
			`    First paragraph.`,
			``,
			`    Second paragraph.`,
			`    """`,
			`    e "after"`
		].join("\n")

		assert.deepEqual(statements(script), ["0 label", "1 say-5", "6 say"])
	})

	test("names a monologue block a say, whatever it opens with", () => {
		const script = [
			`label ch1:`,
			`    """`,
			`    play the game, they said.`,
			`    """`
		].join("\n")

		assert.deepEqual(statements(script), ["0 label", "1 say-3"])
	})

	test("takes a string spanning lines as one statement", () => {
		const script = [`e "one`, `two"`, `e "three"`].join("\n")

		assert.deepEqual(statements(script), ["0 say-1", "2 say"])
	})

	test("carries a statement across open brackets", () => {
		const script = [
			`define e = Character(`,
			`    "Eileen",`,
			`    color="#c8ffc8"`,
			`)`,
			`label start:`
		].join("\n")

		assert.deepEqual(statements(script), ["0 define (no warp)-3", "4 label"])
	})

	test("carries a statement across a backslash", () => {
		const script = [`$ x = 1 + \\`, `    2`, `e "hi"`].join("\n")

		assert.deepEqual(statements(script), ["0 $-1", "2 say"])
	})

	test("reads an escaped quote as text rather than the end of a string", () => {
		assert.deepEqual(statements(`e "she said \\"no\\"" # done`), ["0 say"])
	})

	test("follows ren'py past a string that escapes the end of a line", () => {
		// ren'py steps over an escaped character without checking whether it
		// was a newline, so its counter drops the line and every statement
		// below is one lower than where it sits in the editor
		// @see https://github.com/renpy/renpy/blob/8.5.3.26051504/renpy/lexer.py#L404
		const script = [
			`define TEXT = _("""\\`,
			`some text`,
			`""")`,
			`label start:`,
			`    e "Hello!"`
		].join("\n")

		assert.deepEqual(statements(script), [
			"0 define (no warp)-2",
			"3 label (ren'py calls it 2)",
			"4 say (ren'py calls it 3)"
		])
	})

	test("keeps count when the escaped character isn't the newline", () => {
		// the backslash escapes the second backslash, leaving the newline for
		// ren'py to count as usual
		const script = [
			`define TEXT = _("""a\\\\`,
			`some text`,
			`""")`,
			`label start:`
		].join("\n")

		assert.deepEqual(statements(script), ["0 define (no warp)-2", "3 label"])
	})

	test("stops at the end of the file on an unterminated string", () => {
		assert.deepEqual(statements([`e "never ends`, `and ends`].join("\n")), [
			"0 say-1"
		])
	})
})

describe("what counts as warpable", () => {
	test("takes dialogue and flow statements", () => {
		const script = [
			`label start:`,
			`    scene bg room`,
			`    show eileen happy`,
			`    e "Hello!"`,
			`    $ x = 1`,
			`    play music "track.ogg"`,
			`    jump other`
		].join("\n")

		assert.deepEqual(statements(script), [
			"0 label",
			"1 scene",
			"2 show",
			"3 say",
			"4 $",
			"5 play",
			"6 jump"
		])
	})

	test("refuses statements that only define things", () => {
		const script = [
			`define e = Character("Eileen")`,
			`default points = 0`,
			`image bg room = "room.png"`,
			`transform bounce:`,
			`    yoffset 0`,
			`screen hud():`,
			`    text "hi"`,
			`style my_text:`,
			`    size 20`
		].join("\n")

		assert.deepEqual(statements(script), [
			"0 define (no warp)",
			"1 default (no warp)",
			"2 image (no warp)",
			"3 transform (no warp)",
			"5 screen (no warp)",
			"7 style (no warp)"
		])
	})

	test("swallows an image or transform's own ATL block", () => {
		const script = [
			`image eileen happy:`,
			`    "eileen_happy.png"`,
			`    zoom 1.0`,
			`transform bounce:`,
			`    block:`,
			`        yoffset 0`,
			`        pause 1.0`,
			`    repeat`,
			`label start:`,
			`    e "hi"`
		].join("\n")

		assert.deepEqual(statements(script), [
			"0 image (no warp)",
			"3 transform (no warp)",
			"8 label",
			"9 say"
		])
	})

	test("reads nothing out of a python block", () => {
		const script = [
			`label start:`,
			`    python:`,
			`        x = 1`,
			`        renpy.say(e, "not a statement")`,
			`    e "back in the script"`
		].join("\n")

		assert.deepEqual(statements(script), ["0 label", "1 python", "4 say"])
	})

	test("takes python in a namespace the same as any other python block", () => {
		const script = [
			`label start:`,
			`    python in mystore:`,
			`        x = 1`,
			`    e "after"`
		].join("\n")

		assert.deepEqual(statements(script), ["0 label", "1 python", "3 say"])
		assert.equal(warp(script, 1), undefined, "python runs straight through")
		assert.equal(warp(script, 3), "3 say")
	})

	test("refuses init blocks and what they hold", () => {
		const script = [
			`init python:`,
			`    x = 1`,
			`init 5:`,
			`    $ y = 2`,
			`    define z = 3`,
			`init offset = 2`,
			`python early:`,
			`    import os`
		].join("\n")

		assert.deepEqual(statements(script), [
			"0 init python (no warp)",
			"2 init (no warp)",
			"3 $ (no warp)",
			"4 define (no warp)",
			"5 init offset (no warp)",
			"6 python early (no warp)"
		])
	})

	test("takes init python's priority as still python, not script", () => {
		// a priority shifts "python" from the second leading word to the
		// third, e.g. `init 5 python:` — its body must stay opaque either way
		const script = [
			`init 5 python:`,
			`    x = 1`,
			`init -10 python:`,
			`    y = 2`,
			`init python hide:`,
			`    z = 3`
		].join("\n")

		assert.deepEqual(statements(script), [
			"0 init python (no warp)",
			"2 init python (no warp)",
			"4 init python (no warp)"
		])
	})

	test("doesn't let init python's priority leak a phantom label", () => {
		const script = [
			`init 5 python:`,
			`    label = "chapter1"`,
			`label start:`,
			`    e "hi"`
		].join("\n")

		assert.deepEqual(statements(script), [
			"0 init python (no warp)",
			"2 label",
			"3 say"
		])
		assert.equal(
			warp(script, 1),
			undefined,
			"the python line isn't a real label"
		)
	})

	test("takes a label declared inside an init block", () => {
		// the body of a label runs when the game reaches it, whenever the label
		// itself was declared
		const script = [
			`init python:`,
			`    x = 1`,
			`init label lazy:`,
			`    e "Hello!"`,
			`init:`,
			`    label nested:`,
			`        e "Also here"`
		].join("\n")

		assert.deepEqual(statements(script), [
			"0 init python (no warp)",
			"2 init label",
			"3 say",
			"4 init (no warp)",
			"5 label",
			"6 say"
		])
	})

	test("refuses translation blocks", () => {
		const script = [
			`translate french start_8a1b:`,
			`    e "Bonjour!"`,
			`translate french strings:`,
			`    old "Yes"`,
			`    new "Oui"`,
			`label start:`,
			`    e "Hello!"`
		].join("\n")

		assert.deepEqual(statements(script), [
			"0 translate (no warp)",
			"1 say (no warp)",
			"2 translate (no warp)",
			"5 label",
			"6 say"
		])
	})

	test("refuses a translation whose identifier isn't python, style or strings", () => {
		// any other identifier still names a translated label, which is
		// script rather than python, style pairs or string pairs
		const script = [`translate french chapter1:`, `    e "Bonjour!"`].join("\n")

		assert.deepEqual(statements(script), [
			"0 translate (no warp)",
			"1 say (no warp)"
		])
	})

	test("takes the branches of an if statement", () => {
		const script = [
			`label start:`,
			`    if points > 0:`,
			`        e "Good."`,
			`    elif points == 0:`,
			`        e "Fine."`,
			`    else:`,
			`        e "Bad."`,
			`    e "Done."`
		].join("\n")

		// `elif` and `else` are part of the if statement, so ren'py has no node
		// at those lines
		assert.deepEqual(statements(script), [
			"0 label",
			"1 if",
			"2 say",
			"4 say",
			"6 say",
			"7 say"
		])
	})

	test("takes a menu's choices but not its captions", () => {
		const script = [
			`label start:`,
			`    menu:`,
			`        e "What now?"`,
			`        "A caption on its own"`,
			`        set seen`,
			`        "Go left":`,
			`            e "Left it is."`,
			`        "Go right" if brave:`,
			`            e "Right it is."`
		].join("\n")

		assert.deepEqual(statements(script), [
			"0 label",
			"1 menu",
			"2 say",
			"6 say",
			"8 say"
		])
	})

	test("takes a menu nested inside a choice's block", () => {
		const script = [
			`label start:`,
			`    menu:`,
			`        "Outer":`,
			`            menu:`,
			`                "Inner":`,
			`                    e "chosen"`
		].join("\n")

		assert.deepEqual(statements(script), [
			"0 label",
			"1 menu",
			"3 menu",
			"5 say"
		])
		assert.equal(warp(script, 1), "1 menu", "the outer menu")
		assert.equal(warp(script, 3), "3 menu", "the inner menu")
		assert.equal(warp(script, 5), "5 say")
	})

	test("takes narration opening with a statement's name as narration", () => {
		// the words of a bare string are text, not a keyword, even one that
		// names a real flow statement like `play`
		const script = [`label start:`, `    "play the game, they said."`].join(
			"\n"
		)

		assert.deepEqual(statements(script), ["0 label", "1 say"])
		assert.equal(warp(script, 1), "1 say")
	})

	test("takes a creator-defined statement, but not the block it holds", () => {
		// what a statement the extension doesn't know does with its block is
		// anyone's guess, so warping lands on the statement itself
		const script = [
			`label start:`,
			`    example large:`,
			`        e "Shown as an example, and said."`,
			`    e "Back in the script."`
		].join("\n")

		assert.deepEqual(statements(script), ["0 label", "1 example", "3 say"])
	})
})

describe("label, jump, call and return forms", () => {
	// @see https://www.renpy.org/doc/html/label.html
	test("takes a label's parameters as part of its declaration", () => {
		const script = [`label sample(a="default"):`, `    "a = [a]"`].join("\n")

		assert.deepEqual(statements(script), ["0 label", "1 say"])
		assert.equal(warp(script, 0), undefined, "the label runs into its body")
		assert.equal(warp(script, 1), "1 say")
	})

	test("takes a say's explicit id clause as part of the statement", () => {
		const script = [
			`label start:`,
			`    e "This used to have a typo." id start_61b861a2`
		].join("\n")

		assert.deepEqual(statements(script), ["0 label", "1 say"])
		assert.equal(warp(script, 1), "1 say")
	})

	test("takes a local label the same as any other", () => {
		const script = [
			`label global_label:`,
			`    "Under a global label.."`,
			`label .local_label:`,
			`    "..resides a local one."`
		].join("\n")

		assert.deepEqual(statements(script), [
			"0 label",
			"1 say",
			"2 label",
			"3 say"
		])
		assert.equal(warp(script, 1), "1 say")
		assert.equal(warp(script, 3), "3 say")
	})

	test("takes jump in its expression form", () => {
		const script = [
			`label start:`,
			`    jump expression "loop_" + "start"`
		].join("\n")

		assert.deepEqual(statements(script), ["0 label", "1 jump"])
		assert.equal(warp(script, 1), undefined, "jump leaves for another label")
	})

	test("takes call with an argument list", () => {
		const script = [`label start:`, `    call subroutine(2)`].join("\n")

		assert.deepEqual(statements(script), ["0 label", "1 call"])
		assert.equal(warp(script, 1), undefined, "call leaves for the called label")
	})

	test("takes return with a value", () => {
		const script = [`label start:`, `    return 5`].join("\n")

		assert.deepEqual(statements(script), ["0 label", "1 return"])
		assert.equal(warp(script, 1), undefined, "return leaves the label")
	})
})

describe("scene, show, hide and with", () => {
	test("takes hide, which leaves what runs after it on screen", () => {
		const script = [`label start:`, `    hide eileen`].join("\n")

		assert.deepEqual(statements(script), ["0 label", "1 hide"])
		assert.equal(warp(script, 1), undefined)
	})

	test("takes show with every clause on one line, no ATL block", () => {
		const script = [
			`label start:`,
			`    show eileen happy at Transform(xalign=0.5) onlayer master zorder 1`,
			`    e "hi"`
		].join("\n")

		assert.deepEqual(statements(script), ["0 label", "1 show", "2 say"])
		assert.equal(warp(script, 1), undefined, "show runs straight through")
		assert.equal(warp(script, 2), "2 say")
	})

	test("takes a transition on the same line as the statement it clauses", () => {
		const script = [`label start:`, `    scene bg room with dissolve`].join(
			"\n"
		)

		assert.deepEqual(statements(script), ["0 label", "1 scene"])
		assert.equal(warp(script, 1), undefined, "scene runs straight through")
	})

	test("takes a bare with as a statement of its own", () => {
		const script = [
			`label start:`,
			`    scene bg room`,
			`    with dissolve`
		].join("\n")

		assert.deepEqual(statements(script), ["0 label", "1 scene", "2 with"])
		assert.equal(warp(script, 2), undefined, "with runs straight through")
	})

	test("misreads dialogue from a character named after a flow keyword", () => {
		// `name_of` checks the flow keywords before it ever tries the SAY
		// pattern, so a character object literally named `jump`, `show`,
		// `scene` and so on shadows the keyword — a real, if rare, false
		// positive worth pinning down rather than leaving to guesswork
		const script = [`label start:`, `    jump "Hello!"`].join("\n")

		assert.deepEqual(statements(script), ["0 label", "1 jump"])
		assert.equal(
			warp(script, 1),
			undefined,
			"dialogue should stop here, but the misread jump never does"
		)
	})
})

describe("resolving a warp", () => {
	const script = [
		`# a script`,
		`define e = Character("Eileen")`,
		``,
		`label start:`,
		`    e "Hello!"`,
		`    """`,
		`    A monologue,`,
		`    and its second line.`,
		`    """`,
		`    e "Bye!"`
	].join("\n")

	test("lands on the statement the line belongs to", () => {
		assert.equal(target(script, 4), "4 say")
		assert.equal(target(script, 9), "9 say")
	})

	test("lands on the statement above a line with none of its own", () => {
		assert.equal(target(script, 2), "1 define (no warp)")
		assert.equal(target(script, 3), "3 label")
	})

	test("holds the cursor on the statement a monologue block opens", () => {
		// ren'py reports every paragraph on the line the block opens on, so the
		// whole block warps to one place
		assert.equal(target(script, 5), "5 say")
		assert.equal(target(script, 7), "5 say")
		assert.equal(target(script, 8), "5 say")
	})

	test("gives up above the first statement in the file", () => {
		assert.equal(target(script, 0), undefined)
	})

	test("hands ren'py its own line number, not the editor's", () => {
		// the cursor comes in as an editor line and the warp goes out as a
		// ren'py one, and a string escaping a newline pulls the two apart
		const script = [
			`define TEXT = _("""\\`,
			`some text`,
			`""")`,
			`label start:`,
			`    e "Hello!"`
		].join("\n")

		const found = warp_target(parse_statements(read(script)), 4)

		assert.equal(found?.line, 4)
		assert.equal(found?.warp_line, 3)
	})

	test("turns a line ren'py reports back into the editor's", () => {
		const drifted = [
			`define TEXT = _("""\\`,
			`some text`,
			`""")`,
			`label start:`,
			`    e "Hello!"`
		].join("\n")

		const statements = parse_statements(read(drifted))

		assert.equal(editor_line(statements, 2), 3, "the label")
		assert.equal(editor_line(statements, 3), 4, "the dialogue below it")
		assert.equal(editor_line(statements, 0), 0, "above the drift")
	})

	test("leaves a line alone when nothing has drifted", () => {
		const statements = parse_statements(read(script))

		for (const line of [0, 3, 4, 9]) {
			assert.equal(editor_line(statements, line), line)
		}
	})

	test("finds the first statement in the file the game rests on", () => {
		const statements = parse_statements(read(script))

		assert.equal(next_resting_statement(statements, 0)?.line, 4)
		assert.equal(next_resting_statement(statements, 5)?.line, 5)
		assert.equal(next_resting_statement(statements, 10), undefined)
	})
})

describe("where a warp leaves the game", () => {
	test("takes a line the game waits on", () => {
		const script = [
			`label start:`,
			`    e "Hello!"`,
			`    menu:`,
			`        "Yes":`,
			`            e "Good."`
		].join("\n")

		assert.equal(warp(script, 1), "1 say")
		assert.equal(warp(script, 2), "2 menu")
	})

	test("refuses a statement the game runs straight through", () => {
		// ren'py runs the show and carries on to the dialogue below it, so the
		// game would never be sitting where the cursor is
		const script = [
			`label start:`,
			`    show gallery:`,
			`        zoom 0.55`,
			`        xalign 0.5`,
			`    show elin flannel at elin_pos:`,
			`        xalign 0.4`,
			`    e "Hello!"`
		].join("\n")

		assert.equal(warp(script, 1), undefined)
		assert.equal(warp(script, 3), undefined, "inside the atl block")
		assert.equal(warp(script, 4), undefined)
		assert.equal(warp(script, 0), undefined, "the label runs into its body")
		assert.equal(warp(script, 6), "6 say")
	})

	test("refuses the statements that send the game elsewhere", () => {
		const script = [
			`label start:`,
			`    $ points += 1`,
			`    jump other`,
			`    if points > 0:`,
			`        e "Good."`,
			`    return`
		].join("\n")

		assert.equal(warp(script, 1), undefined)
		assert.equal(warp(script, 2), undefined)
		assert.equal(warp(script, 3), undefined)
		assert.equal(warp(script, 4), "4 say")
		assert.equal(warp(script, 5), undefined)
	})

	test("refuses `extend`, which says the line above it again", () => {
		const script = [
			`label start:`,
			`    e "Hello!"`,
			`    extend " Nice to meet you."`
		].join("\n")

		assert.deepEqual(statements(script), [
			"0 label",
			"1 say",
			"2 extend (no warp)"
		])
		assert.equal(warp(script, 2), undefined)
	})

	test("refuses a line the game can't play at all", () => {
		const script = [`screen hud():`, `    text "hi"`].join("\n")

		assert.equal(warp(script, 1), undefined)
	})

	test("waits on a creator-defined statement, which could be anything", () => {
		// `pause` and `call screen` both wait, and a statement the extension
		// doesn't know could do the same, so it gets the benefit of the doubt
		const script = [
			`label start:`,
			`    pause 2.0`,
			`    call screen inventory`,
			`    achieve first`
		].join("\n")

		assert.equal(warp(script, 1), "1 pause")
		assert.equal(warp(script, 2), "2 call screen")
		assert.equal(warp(script, 3), "3 achieve")
	})
})

describe("the statement cache", () => {
	test("parses a document again once it changes", () => {
		let text = `label start:`
		let version = 0

		const document = {
			uri: { toString: () => "file:///script.rpy" },
			get version() {
				return version
			},
			get lineCount() {
				return text.split("\n").length
			},
			lineAt: (n: number) => ({ text: text.split("\n")[n] })
		}

		const first = get_statements(document)

		assert.equal(get_statements(document), first, "same document, same parse")

		text = [`label start:`, `    e "Hello!"`].join("\n")
		version = 1

		const second = get_statements(document) as Statement[]

		assert.equal(second.length, 2)
	})
})
