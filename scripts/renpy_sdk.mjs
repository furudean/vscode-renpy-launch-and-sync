import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { access, mkdir, readdir, rename, rm } from "node:fs/promises"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import { join } from "node:path"
import extract from "extract-zip"
import { get_sum_for_sdk } from "../src/lib/api.ts"

export const SDK_VERSION = "8.5.3"

const SDK_ROOT = join(import.meta.dirname, "..", ".vscode-test", "renpy-sdk")

export const sdk_path = join(SDK_ROOT, `renpy-${SDK_VERSION}-sdk`)

async function exists(path) {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

function md5(path) {
	return new Promise((resolve, reject) => {
		const hash = createHash("md5")
		createReadStream(path)
			.on("error", reject)
			.on("data", (chunk) => hash.update(chunk))
			.on("end", () => resolve(hash.digest("hex")))
	})
}

/**
 * downloads and unpacks the pinned ren'py sdk into .vscode-test/ unless it is
 * already there. the sdk ships the_question and tutorial, which the e2e tests
 * open as their workspace.
 *
 * @returns {Promise<string>} absolute path to the sdk
 */
export async function ensure_sdk() {
	if (await exists(join(sdk_path, "renpy.py"))) return sdk_path

	const url = new URL(
		`https://renpy.org/dl/${SDK_VERSION}/renpy-${SDK_VERSION}-sdk.zip`
	)
	const archive = join(SDK_ROOT, `renpy-${SDK_VERSION}-sdk.zip`)
	const staging = sdk_path + "_tmp"

	await mkdir(SDK_ROOT, { recursive: true })

	console.log(`downloading ${url}`)
	const response = await fetch(url)
	if (!response.ok || !response.body) {
		throw new Error(`failed to download ${url}: ${response.status}`)
	}
	await pipeline(Readable.fromWeb(response.body), createWriteStream(archive))

	const expected = await get_sum_for_sdk(url)
	if (expected) {
		const actual = await md5(archive)
		if (actual !== expected) {
			throw new Error(`checksum mismatch: expected ${expected}, got ${actual}`)
		}
	}

	console.log(`extracting to ${sdk_path}`)
	await rm(staging, { recursive: true, force: true })
	await extract(archive, { dir: staging, defaultFileMode: 0o744 })

	const [top, ...rest] = await readdir(staging)
	if (top === undefined || rest.length > 0) {
		throw new Error(`expected a single directory in ${archive}`)
	}

	await rm(sdk_path, { recursive: true, force: true })
	await rename(join(staging, top), sdk_path)
	await rm(staging, { recursive: true, force: true })
	await rm(archive)

	return sdk_path
}

if (process.argv[1] === import.meta.filename) {
	console.log(await ensure_sdk())
}
