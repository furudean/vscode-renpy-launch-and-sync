import { test, describe, beforeEach, afterEach, mock } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
	find_sdk_in_nginx_dir,
	find_sdk_in_nightly_index,
	get_sum_for_sdk,
	list_nightly_sdks,
	list_remote_sdks,
	semver_compare
} from "./api.ts"

const fixtures = join(
	import.meta.dirname,
	"..",
	"..",
	"test",
	"fixtures",
	"api"
)

// snapshots of the pages the extension scrapes, keyed by url
const pages: Record<string, string> = {
	"https://renpy.org/dl/": "dl.html",
	"https://renpy.org/dl/8.5.3/": "dl-8.5.3.html",
	"https://renpy.org/dl/8.5.3/checksums.txt": "checksums.txt",
	"https://nightly.renpy.org/": "nightly.html",
	"https://nightly.renpy.org/8.6.0.26091304+nightly/":
		"nightly-8.6.0.26091304.html"
}

async function fake_fetch(input: string | URL, init?: RequestInit) {
	const url = input.toString()
	const file = pages[url]

	if (!file) return new Response("not found", { status: 404 })

	const body =
		init?.method === "HEAD" ? null : await readFile(join(fixtures, file))

	return new Response(body, { status: 200 })
}

describe("remote sdk index", () => {
	beforeEach(() => {
		mock.method(globalThis, "fetch", fake_fetch)
	})
	afterEach(() => {
		mock.restoreAll()
	})

	test("lists releases newest first", async () => {
		const sdks = await list_remote_sdks()
		const names = sdks.map((sdk) => sdk.name)

		assert.ok(names.includes("8.5.3"))
		assert.ok(names.includes("4.0"))
		assert.ok(names.indexOf("8.5.3") < names.indexOf("8.4.0"))
		assert.ok(names.indexOf("8.4.0") < names.indexOf("7.8.7"))

		// non-version directories sort to the back rather than being dropped
		assert.ok(names.indexOf("steam") > names.indexOf("4.0"))
	})

	test("points each release at its directory", async () => {
		const sdks = await list_remote_sdks()
		const sdk = sdks.find((sdk) => sdk.name === "8.5.3")

		assert.equal(sdk?.url.href, "https://renpy.org/dl/8.5.3/")
		assert.equal(sdk?.semver?.major, 8)
		assert.equal(sdk?.semver?.minor, 5)
	})

	test("finds the sdk archive in a release directory", async () => {
		const url = await find_sdk_in_nginx_dir("https://renpy.org/dl/8.5.3/")

		assert.equal(url.href, "https://renpy.org/dl/8.5.3/renpy-8.5.3-sdk.zip")
	})

	test("lists nightlies from both columns", async () => {
		const sdks = await list_nightly_sdks()
		const names = sdks.map((sdk) => sdk.name)

		assert.ok(names.some((name) => name.startsWith("8.6.0.")))
		assert.ok(names.some((name) => name.startsWith("8.5.4.")))
		assert.ok(names.every((name) => name.includes("+nightly")))

		// the header and permalink rows are not versions
		assert.ok(!names.includes("permalink"))
		assert.ok(!names.includes("documentation"))

		assert.equal(sdks[0].url.href, `https://nightly.renpy.org/${names[0]}`)
	})

	test("finds the sdk archive in a nightly build", async () => {
		const url = await find_sdk_in_nightly_index(
			"https://nightly.renpy.org/8.6.0.26091304+nightly/"
		)

		assert.equal(
			url.href,
			"https://nightly.renpy.org/8.6.0.26091304+nightly/renpy-8.6.0.26091304+nightly-sdk.zip"
		)
	})

	test("reads the md5 for the sdk archive", async () => {
		const sum = await get_sum_for_sdk(
			new URL("https://renpy.org/dl/8.5.3/renpy-8.5.3-sdk.zip")
		)

		assert.equal(sum, "dfa68338642f3b14f3e343dae5500381")
	})

	test("has no checksum for a release without one", async () => {
		const sum = await get_sum_for_sdk(
			new URL("https://renpy.org/dl/4.0/renpy-4.0-sdk.zip")
		)

		assert.equal(sum, undefined)
	})
})

describe("semver_compare", () => {
	const sorted = (names: string[]) => [...names].sort(semver_compare)

	test("orders versions descending", () => {
		assert.deepEqual(sorted(["7.8.7", "8.5.3", "8.4.0"]), [
			"8.5.3",
			"8.4.0",
			"7.8.7"
		])
	})

	test("handles ren'py's odd version shapes", () => {
		assert.deepEqual(
			sorted(["4.0", "5.1.4a", "5.1.4", "6.99.14.1", "6.99.14"]),
			["6.99.14.1", "6.99.14", "5.1.4a", "5.1.4", "4.0"]
		)
	})

	test("keeps nightlies next to the release they build on", () => {
		assert.deepEqual(sorted(["8.5.4", "8.6.0.26091304+nightly", "8.6.1"]), [
			"8.6.1",
			"8.6.0.26091304+nightly",
			"8.5.4"
		])
	})

	test("sorts non-versions last, alphabetically", () => {
		assert.deepEqual(sorted(["tmp", "8.5.3", "steam"]), [
			"8.5.3",
			"steam",
			"tmp"
		])
	})
})
