import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { sep } from "node:path"
import { shrink_path } from "./path.ts"

describe("shorten_path", () => {
	test("leaves a path that fits alone", () => {
		assert.equal(
			shrink_path("~/Code/renpy-8.3.4-sdk", 40),
			"~/Code/renpy-8.3.4-sdk"
		)
	})

	test("shrinks the longest directory first", () => {
		assert.equal(
			shrink_path("~/Code/development/renpy-8.3.4-sdk", 30),
			"~/Code/devel../renpy-8.3.4-sdk"
		)
	})

	test("evens out directories before shrinking further", () => {
		assert.equal(
			shrink_path("~/aaaaaaaa/bbbbbbbb/cccccccc/sdk", 26),
			"~/aaaa../bbbb../cccc../sdk"
		)
	})

	test("breaks ties toward the middle", () => {
		assert.equal(
			shrink_path("/aaaaaa/bbbbbb/cccccc/sdk", 24),
			"/aaaaaa/bbb../cccccc/sdk"
		)
	})

	test("never shortens the last part", () => {
		assert.equal(
			shrink_path("~/Code/renpy-8.3.4-sdk-with-a-long-name", 10),
			"~/C../renpy-8.3.4-sdk-with-a-long-name"
		)
	})

	test("joins with the platform separator", () => {
		assert.equal(
			shrink_path("C:\\Users\\someone\\Downloads\\renpy-sdk", 30),
			["C:", "Users", "som..", "Dow..", "renpy-sdk"].join(sep)
		)
	})
})
