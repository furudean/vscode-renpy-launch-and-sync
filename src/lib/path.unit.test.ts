import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { sep } from "node:path"
import { is_same_path, shrink_path } from "./path.ts"

function native(unix_path: string): string {
	return unix_path.split("/").join(sep)
}

describe("shorten_path", () => {
	test("leaves a path that fits alone", () => {
		assert.equal(
			shrink_path("~/Code/renpy-8.3.4-sdk", 40),
			native("~/Code/renpy-8.3.4-sdk")
		)
	})

	test("shrinks the longest directory first", () => {
		assert.equal(
			shrink_path("~/Code/development/renpy-8.3.4-sdk", 30),
			native("~/Code/devel../renpy-8.3.4-sdk")
		)
	})

	test("evens out directories before shrinking further", () => {
		assert.equal(
			shrink_path("~/aaaaaaaa/bbbbbbbb/cccccccc/sdk", 26),
			native("~/aaaa../bbbb../cccc../sdk")
		)
	})

	test("breaks ties toward the middle", () => {
		assert.equal(
			shrink_path("/aaaaaa/bbbbbb/cccccc/sdk", 24),
			native("/aaaaaa/bbb../cccccc/sdk")
		)
	})

	test("never shortens the last part", () => {
		assert.equal(
			shrink_path("~/Code/renpy-8.3.4-sdk-with-a-long-name", 10),
			native("~/C../renpy-8.3.4-sdk-with-a-long-name")
		)
	})

	test("joins with the platform separator", () => {
		assert.equal(
			shrink_path("C:\\Users\\someone\\Downloads\\renpy-sdk", 30),
			["C:", "Users", "som..", "Dow..", "renpy-sdk"].join(sep)
		)
	})
})

describe("is_same_path", () => {
	test("matches however the path is spelled", () => {
		assert.equal(is_same_path("/a/b", "/a/b/"), true)
		assert.equal(is_same_path("/a/b", "/a/c/../b"), true)
	})

	test("tells a project from one nested inside it", () => {
		assert.equal(is_same_path("/a/b", "/a/b/other"), false)
		assert.equal(is_same_path("/a/b/other", "/a/b"), false)
	})
})
