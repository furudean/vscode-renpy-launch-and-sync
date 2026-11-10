import { ExtensionContext } from "vscode"
import * as vscode from "vscode"
import { get_logger } from "./log"
import p_filter from "p-filter"
import { path_is_sdk } from "./sdk"
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises"
import path from "upath"
import { basename, join } from "node:path"
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import extract from "extract-zip"
import {
	find_sdk_in_nginx_dir,
	find_sdk_in_nightly_index,
	get_sum_for_sdk,
	list_nightly_sdks,
	list_remote_sdks,
	RemoteSdk
} from "./api"

const logger = get_logger()

class ChecksumError extends Error {}

async function with_retry_prompt<T>(
	failure_message: string,
	fn: () => Thenable<T>
): Promise<T | undefined> {
	for (;;) {
		try {
			return await fn()
		} catch (error) {
			if (error instanceof vscode.CancellationError) return undefined

			logger.error(`${failure_message}:`, error)
			const message = `${failure_message}: ${error instanceof Error ? error.message : error}`

			if (error instanceof ChecksumError) {
				vscode.window
					.showErrorMessage(message, "See logs")
					.then((selection) => {
						if (selection === "See logs") logger.show()
					})
				return undefined
			}

			const selection = await vscode.window.showErrorMessage(
				message,
				"Retry",
				"See logs"
			)
			if (selection === "See logs") logger.show()
			if (selection !== "Retry") return undefined
		}
	}
}

function abort_signal(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController()
	token.onCancellationRequested(() =>
		controller.abort(new vscode.CancellationError())
	)
	return controller.signal
}

async function find_remote_sdk_by_name(
	version: string,
	signal: AbortSignal
): Promise<{ url: URL; nightly: boolean } | undefined> {
	let error: unknown
	const settle = (listing: Promise<RemoteSdk[]>) =>
		listing.catch((e) => {
			error = e
			return []
		})

	const [stable, nightly] = await Promise.all([
		settle(list_remote_sdks(signal)),
		settle(list_nightly_sdks(signal))
	])

	const stable_match = stable.find((sdk) => sdk.name === version)
	if (stable_match) return { url: stable_match.url, nightly: false }

	const nightly_match = nightly.find((sdk) => sdk.name === version)
	if (nightly_match) return { url: nightly_match.url, nightly: true }

	if (error) throw error
	return undefined
}

async function find_sdk_archive_url(
	version: string,
	signal: AbortSignal
): Promise<URL | undefined> {
	const remote = await find_remote_sdk_by_name(version, signal)
	if (!remote) {
		vscode.window.showErrorMessage(
			`Could not find Ren'Py SDK "${version}" to download.`
		)
		return undefined
	}

	return remote.nightly
		? await find_sdk_in_nightly_index(remote.url, signal)
		: await find_sdk_in_nginx_dir(remote.url, signal)
}

// tracks in-flight downloads by version so two callers racing on the same
// undownloaded version share one download instead of both unpacking the
// same archive at once
const in_flight_sdk_downloads = new Map<string, Promise<string | undefined>>()

async function ensure_sdk_download_permission(
	context: ExtensionContext,
	version: string
): Promise<boolean> {
	if (context.globalState.get<boolean>("renpyWarp.alwaysDownloadSdk"))
		return true

	const selection = await vscode.window.showInformationMessage(
		`Ren'Py Warp and Sync wants to download Ren'Py ${version}`,
		"Always download",
		"Download this time",
		"Stop"
	)

	if (selection === "Always download") {
		await context.globalState.update("renpyWarp.alwaysDownloadSdk", true)
		return true
	}

	return selection === "Download this time"
}

export async function get_or_download_sdk_path(
	version: string,
	context: ExtensionContext,
	allow_download = true
): Promise<string | undefined> {
	const existing = await get_downloaded_sdk(version, context)
	if (existing) return existing

	logger.warn(`sdk version "${version}" is not downloaded`)
	if (!allow_download) return undefined

	const in_flight = in_flight_sdk_downloads.get(version)
	if (in_flight) return in_flight

	const download_promise = (async () => {
		const sdk_url = await with_retry_prompt(
			`Failed to look up Ren'Py ${version}`,
			() =>
				vscode.window.withProgress(
					{
						title: `Looking up Ren'Py ${version}`,
						location: vscode.ProgressLocation.Notification,
						cancellable: true
					},
					(_progress, token) =>
						find_sdk_archive_url(version, abort_signal(token))
				)
		)
		if (!sdk_url) return undefined

		if (!(await ensure_sdk_download_permission(context, version))) {
			return undefined
		}

		return await download_sdk(sdk_url, version, context)
	})()

	in_flight_sdk_downloads.set(version, download_promise)
	try {
		return await download_promise
	} finally {
		in_flight_sdk_downloads.delete(version)
	}
}

function get_md5_hash(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("md5")
		const stream = createReadStream(path)
		stream.on("error", reject)
		stream.on("data", (chunk) => hash.update(chunk))
		stream.on("end", () => resolve(hash.digest("hex")))
	})
}

let storage_dir: Promise<string> | undefined

function sdk_storage_dir(context: ExtensionContext): Promise<string> {
	storage_dir ??= migrate_old_sdk_storage(context.globalStorageUri.fsPath)
	return storage_dir
}

// earlier versions downloaded sdks through the file downloader extension
async function migrate_old_sdk_storage(root: string): Promise<string> {
	const dir = join(root, "sdks")
	const legacy_dir = join(root, "file-downloader-downloads")

	let entries
	try {
		entries = await readdir(legacy_dir, { withFileTypes: true })
	} catch {
		return dir
	}

	await mkdir(dir, { recursive: true })

	let moved_all = true
	for (const entry of entries) {
		if (!entry.isDirectory()) continue

		try {
			await rename(join(legacy_dir, entry.name), join(dir, entry.name))
			logger.info(`moved sdk ${entry.name} to ${dir}`)
		} catch (error) {
			moved_all = false
			logger.error(`failed to move sdk ${entry.name} to ${dir}:`, error)
		}
	}

	if (moved_all) await rm(legacy_dir, { recursive: true, force: true })

	return dir
}

async function download_file(
	url: URL,
	file: string,
	signal: AbortSignal,
	on_progress: (fraction: number) => void
): Promise<void> {
	const response = await fetch(url, { signal })
	if (!response.ok || !response.body) {
		throw new Error(
			`${url} responded with ${response.status} ${response.statusText}`
		)
	}

	const total = Number(response.headers.get("content-length"))
	let received = 0

	await pipeline(
		Readable.fromWeb(response.body),
		async function* (chunks: AsyncIterable<Buffer>) {
			for await (const chunk of chunks) {
				received += chunk.length
				if (total) on_progress(received / total)
				yield chunk
			}
		},
		createWriteStream(file)
	)
}

export async function download_sdk(
	sdk_url: string | URL,
	sdk_name: string,
	context: ExtensionContext,
	validate = true
): Promise<string | undefined> {
	const url = new URL(sdk_url)

	return with_retry_prompt(`Failed to download Ren'Py ${sdk_name}`, () =>
		vscode.window.withProgress(
			{
				title: `Downloading and installing Ren'Py ${sdk_name}`,
				location: vscode.ProgressLocation.Notification,
				cancellable: true
			},
			async function (progress, cancelation_token) {
				const signal = abort_signal(cancelation_token)

				const dir = await sdk_storage_dir(context)
				await mkdir(dir, { recursive: true })
				const archive = join(dir, sdk_name + ".zip")

				let reported = 0

				try {
					await download_file(url, archive, signal, function (fraction) {
						progress.report({ increment: fraction * 100 - reported })
						reported = fraction * 100
					})
				} catch (error) {
					await rm(archive, { force: true })
					if (cancelation_token.isCancellationRequested) {
						throw new vscode.CancellationError()
					}
					throw error
				}

				if (validate) {
					progress.report({
						message: "Validating checksum",
						increment: -1000
					})
					const sum = await get_sum_for_sdk(url, signal)

					if (sum) {
						const hash = await get_md5_hash(archive)

						if (hash !== sum) {
							await rm(archive, { force: true })
							throw new ChecksumError(
								`checksum mismatch for ${archive}: expected ${sum}, got ${hash}`
							)
						}
					} else {
						logger.warn("no checksum found, skipping validation")
					}
				}

				progress.report({
					message: "Extracting archive",
					increment: -1000
				})
				const sdk_path = await unpack_sdk_archive(archive, sdk_name)

				return sdk_path
			}
		)
	)
}

async function unpack_sdk_archive(archive_path: string, sdk_name: string) {
	const root = path.dirname(archive_path)
	const zip_path = path.join(root, sdk_name + "_tmp")

	// clean up any previous incomplete extraction
	await rm(zip_path, { recursive: true, force: true })
	await mkdir(zip_path, { recursive: true })

	await extract(archive_path, { dir: zip_path, defaultFileMode: 0o744 })

	const files = await readdir(zip_path, { withFileTypes: true })
	if (files.length !== 1 || !files[0].isDirectory()) {
		throw new Error(
			`expected single directory in ${zip_path}, found ${files.length}`
		)
	}

	const sdk_folder_path = path.join(zip_path, files[0].name)
	const final_path = path.join(root, sdk_name)
	await rm(final_path, { recursive: true, force: true })
	await cp(sdk_folder_path, final_path, {
		recursive: true,
		force: true
	})
	await rm(zip_path, { recursive: true, force: true })
	await rm(archive_path)
	return final_path
}

export async function list_downloaded_sdks(
	context: ExtensionContext
): Promise<string[]> {
	const dir = await sdk_storage_dir(context)
	const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return []
		throw error
	})

	return p_filter(
		names.map((name) => join(dir, name)),
		path_is_sdk
	)
}

export async function get_downloaded_sdk(
	name: string,
	context: ExtensionContext
): Promise<string | undefined> {
	const downloaded_sdks = await list_downloaded_sdks(context)
	return downloaded_sdks.find((sdk_path) => basename(sdk_path) === name)
}

export async function uninstall_sdk(
	sdk_path: string,
	context: ExtensionContext
): Promise<void> {
	const downloaded = await list_downloaded_sdks(context)

	if (!downloaded.includes(sdk_path)) {
		throw new Error(`SDK not found at path: ${sdk_path}`)
	}

	try {
		await rm(sdk_path, { recursive: true, force: true })
		vscode.window.showInformationMessage(
			`Ren'Py SDK at ${basename(sdk_path)} uninstalled`
		)
	} catch (error) {
		logger.error(`Failed to uninstall SDK at ${sdk_path}:`, error)
		vscode.window.showErrorMessage(
			`Failed to uninstall SDK at ${sdk_path}: ${
				error instanceof Error ? error.message : "Unknown error"
			}`
		)
	}
}
