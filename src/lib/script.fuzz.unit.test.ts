import { test } from "node:test"
import assert from "node:assert/strict"
import fc from "fast-check"
import { editor_line, parse_statements, warp_target } from "./script.ts"
import type { LineSource } from "./dialogue.ts"

function read(script: string): LineSource {
	const lines = script.split("\n")

	return {
		lineCount: lines.length,
		lineAt: (n) => ({ text: lines[n] })
	}
}

// the characters `scan`'s state machine actually branches on — quotes,
// brackets, backslashes and the comment marker. random unicode text mostly
// skips those branches, so the alphabet is narrowed to hit them often
const ALPHABET = [
	'"',
	"'",
	"`",
	"\\",
	"(",
	")",
	"[",
	"]",
	"{",
	"}",
	"#",
	"\n",
	" ",
	"a",
	"0",
	":"
]

const script = fc
	.array(fc.constantFrom(...ALPHABET), { maxLength: 200 })
	.map((chars) => chars.join(""))

test("never throws on arbitrary text", () => {
	fc.assert(
		fc.property(script, (text) => {
			parse_statements(read(text))
		})
	)
})

test("keeps every statement's lines in range and in order", () => {
	fc.assert(
		fc.property(script, (text) => {
			const document = read(text)
			const statements = parse_statements(document)

			let previous_end = -1

			for (const statement of statements) {
				assert.ok(statement.line <= statement.end_line)
				assert.ok(statement.end_line < document.lineCount)
				assert.ok(
					statement.warp_line <= statement.line,
					"ren'py's count only falls behind, never ahead"
				)
				assert.ok(
					statement.line > previous_end,
					"a statement starts after the one before it ends"
				)

				previous_end = statement.end_line
			}
		})
	)
})

test("warp_target never returns a statement past the requested line", () => {
	fc.assert(
		fc.property(script, fc.nat({ max: 200 }), (text, line) => {
			const statements = parse_statements(read(text))
			const target = warp_target(statements, line)

			if (target) assert.ok(target.line <= line)
		})
	)
})

test("editor_line inverts the warp_line every statement reports", () => {
	fc.assert(
		fc.property(script, (text) => {
			const statements = parse_statements(read(text))

			for (const statement of statements) {
				assert.equal(
					editor_line(statements, statement.warp_line),
					statement.line
				)
			}
		})
	)
})
