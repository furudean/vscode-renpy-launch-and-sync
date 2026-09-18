import { homedir } from "node:os"
import fs from "node:fs/promises"
import {
	find_projects_in_workspaces,
	is_explicit_path,
	path_exists,
	resolve_path
} from "./path"
import * as vscode from "vscode"
import path, { basename } from "upath"
import tildify from "tildify"
import { parse as semver_parse } from "semver"
import { get_logger } from "./log"
import {
	get_downloaded_sdk,
	get_or_download_sdk_path,
	list_downloaded_sdks,
	uninstall_sdk
} from "./download"
import open from "open"
import { get_executable, get_version } from "./sh"
import {
	list_nightly_sdks,
	list_remote_sdks,
	RemoteSdk,
	semver_compare,
	sort_remote_sdks
} from "./api"

export const logger = get_logger()

export async function write_version_file(
	dir: string,
	value: string
): Promise<void> {
	await fs.writeFile(path.join(dir, ".renpy-version"), value + "\n", "utf-8")
}

export async function default_version_root(): Promise<string | undefined> {
	const projects = await find_projects_in_workspaces()
	if (projects.length > 0) return projects[0]
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

export async function resolve_version_file_value(
	value: string,
	context: vscode.ExtensionContext,
	allow_download = true
): Promise<string | undefined> {
	if (is_explicit_path(value)) {
		return resolve_path(value)
	}
	return await get_or_download_sdk_path(value, context, allow_download)
}

async function resolve_version_write_root(
	project_root?: string
): Promise<string | undefined> {
	const { search_root, version_file } = await find_version_file(project_root)
	return version_file ? path.dirname(version_file) : search_root
}

async function write_version_selection_for_path(
	sdk_path: string,
	project_root: string | undefined,
	context: vscode.ExtensionContext
): Promise<void> {
	const downloaded = await list_downloaded_sdks(context)
	const resolved = resolve_path(sdk_path)
	const value = downloaded.some((p) => resolve_path(p) === resolved)
		? basename(sdk_path)
		: tildify(sdk_path)

	const write_root = await resolve_version_write_root(project_root)
	if (!write_root) return
	await write_version_file(write_root, value)
}

const SdkAction = {
	/** an already-resolved sdk on disk - a download, or a custom path in use */
	Path: Symbol("Path"),
	/** a version name, which may or may not be downloaded yet */
	SelectVersion: Symbol("SelectVersion"),
	SystemFilePicker: Symbol("SystemFilePicker")
} as const

type SdkAction = (typeof SdkAction)[keyof typeof SdkAction]

interface SdkQuickPickItem extends vscode.QuickPickItem {
	action?: SdkAction
	path?: string
	version?: string
	url?: URL
	nightly?: boolean
}

interface RemoteSdkCatalog {
	filtered_sdks: RemoteSdk[]
	all_valid_sdks: RemoteSdk[]
	nightly_sdks: RemoteSdk[]
}

type StoredRemoteSdk = Omit<RemoteSdk, "url" | "semver"> & {
	url: string
	semver: string | null
}

type StoredRemoteSdkCatalog = {
	[K in keyof RemoteSdkCatalog]: StoredRemoteSdk[]
}

const REMOTE_SDK_CATALOG_STORAGE_KEY = "renpyWarp.remoteSdkCatalog"

function serialize_remote_sdk(sdk: RemoteSdk): StoredRemoteSdk {
	return {
		name: sdk.name,
		url: sdk.url.href,
		semver: sdk.semver?.version ?? null
	}
}

function deserialize_remote_sdk(sdk: StoredRemoteSdk): RemoteSdk {
	return {
		name: sdk.name,
		url: new URL(sdk.url),
		semver: sdk.semver ? semver_parse(sdk.semver) : null
	}
}

/**
 * the last successfully fetched remote sdk listing. persisted to global storage
 */
let cached_remote_catalog: RemoteSdkCatalog | undefined

/**
 * loads the persisted remote sdk catalog into memory, if one hasn't already
 * been fetched this session
 */
function load_cached_remote_catalog(context: vscode.ExtensionContext): void {
	if (cached_remote_catalog) return

	const stored = context.globalState.get<StoredRemoteSdkCatalog>(
		REMOTE_SDK_CATALOG_STORAGE_KEY
	)
	if (!stored) return

	cached_remote_catalog = {
		filtered_sdks: stored.filtered_sdks.map(deserialize_remote_sdk),
		all_valid_sdks: stored.all_valid_sdks.map(deserialize_remote_sdk),
		nightly_sdks: stored.nightly_sdks.map(deserialize_remote_sdk)
	}
}

async function fetch_remote_sdk_catalog(
	context: vscode.ExtensionContext
): Promise<RemoteSdkCatalog | undefined> {
	try {
		const [remote_sdks, nightly_sdks] = await Promise.all([
			list_remote_sdks(),
			list_nightly_sdks()
		])

		if (remote_sdks.length === 0) return undefined

		const all_valid_sdks = remote_sdks

		const filtered_sdks =
			highest_patch_per_minor(all_valid_sdks).sort(sort_remote_sdks)

		cached_remote_catalog = { filtered_sdks, all_valid_sdks, nightly_sdks }

		await context.globalState.update(REMOTE_SDK_CATALOG_STORAGE_KEY, {
			filtered_sdks: filtered_sdks.map(serialize_remote_sdk),
			all_valid_sdks: all_valid_sdks.map(serialize_remote_sdk),
			nightly_sdks: nightly_sdks.map(serialize_remote_sdk)
		} satisfies StoredRemoteSdkCatalog)

		return cached_remote_catalog
	} catch (error) {
		logger.warn("failed to fetch remote sdk catalog:", error)
		return undefined
	}
}

/**
 * drops unsupported (pre-7.0) versions and collapses each minor version down
 * to its highest patch
 */
function highest_patch_per_minor(sdks: RemoteSdk[]): RemoteSdk[] {
	return Array.from(
		sdks
			.filter((sdk) => semver_compare(sdk.name, "7.0.0") <= 0)
			.reduce((map, sdk) => {
				const minor = `${sdk.semver!.major}.${sdk.semver!.minor}`
				const existing = map.get(minor)

				if (
					!existing ||
					(sdk.semver &&
						existing.semver &&
						sdk.semver.compare(existing.semver) > 0)
				) {
					map.set(minor, sdk)
				}
				return map
			}, new Map<string, RemoteSdk>())
			.values()
	)
}

export async function path_is_sdk(sdk_path: string): Promise<boolean> {
	return await path_exists(path.join(sdk_path, "renpy.py"))
}

async function find_version_file(
	project_root?: string
): Promise<{ search_root?: string; version_file?: string }> {
	const search_root = project_root ?? (await default_version_root())
	if (!search_root) return { search_root: undefined, version_file: undefined }

	const workspace_folder = vscode.workspace.getWorkspaceFolder(
		vscode.Uri.file(search_root)
	)
	const stop_at = resolve_path(
		workspace_folder ? workspace_folder.uri.fsPath : search_root
	)

	let dir = resolve_path(search_root)
	while (true) {
		const candidate = path.join(dir, ".renpy-version")
		if (await path_exists(candidate)) {
			return { search_root, version_file: candidate }
		}

		if (dir === stop_at) return { search_root, version_file: undefined }

		const parent = path.dirname(dir)
		if (parent === dir) return { search_root, version_file: undefined }
		dir = parent
	}
}

export async function get_version_file_raw_value(
	project_root?: string
): Promise<{ version_file?: string; raw_value?: string }> {
	const { version_file } = await find_version_file(project_root)

	const raw_value = version_file
		? (await fs.readFile(version_file, "utf-8")).trim()
		: undefined

	return { version_file, raw_value }
}

export async function get_sdk_path(
	context: vscode.ExtensionContext,
	prompt = true,
	project_root?: string,
	precomputed?: { version_file?: string; raw_value?: string }
): Promise<string | undefined> {
	const { version_file, raw_value } =
		precomputed ?? (await get_version_file_raw_value(project_root))

	logger.debug("raw sdk version/path:", raw_value, "from", version_file)

	if (!raw_value) {
		if (!prompt) return undefined

		const picked = (await vscode.commands.executeCommand(
			"renpyWarp.setSdkPath",
			project_root ?? (await default_version_root())
		)) as string | undefined
		if (picked) return picked

		// the picker only records a version that isn't downloaded yet rather
		// than resolving it itself - re-read the file it just wrote and
		// resolve normally, which downloads it since prompt/allow_download is
		// true here
		const retry = await get_version_file_raw_value(project_root)
		if (!retry.raw_value) return undefined

		return await resolve_version_file_value(retry.raw_value, context, prompt)
	}

	const resolved = await resolve_version_file_value(raw_value, context, prompt)

	if (!resolved && prompt) {
		logger.warn(
			`could not resolve Ren'Py SDK "${raw_value}" from ${version_file}`
		)
	}

	return resolved
}

export async function prompt_sdk_quick_pick(
	context: vscode.ExtensionContext,
	project_root?: string
): Promise<string | void> {
	load_cached_remote_catalog(context)

	const current_sdk_path = await get_sdk_path(context, false, project_root)
	let downloaded_sdks = await list_downloaded_sdks(context)
	let catalog = cached_remote_catalog
	let expanded = false
	let nightly_expanded = false

	// a custom sdk path currently in use that the extension didn't download
	// itself. computed once up front since it never changes for this picker
	let current_custom_label: string | undefined
	if (
		current_sdk_path &&
		!downloaded_sdks.some(
			(p) => resolve_path(p) === resolve_path(current_sdk_path)
		)
	) {
		current_custom_label = tildify(current_sdk_path)
		const executable = await get_executable(current_sdk_path)
		const version = executable && get_version(executable)?.semver
		if (version) current_custom_label += ` (${version})`
	}

	function downloaded_path_for(name: string): string | undefined {
		return downloaded_sdks.find((p) => basename(p) === name)
	}

	function parse_nightly_build_date(name: string): string | undefined {
		const match = name.match(/\.(\d{2})(\d{2})(\d{2})(\d{2})\+nightly/)
		if (!match) return undefined

		const [, yy, mm, dd, seq] = match
		const date = new Date(2000 + Number(yy), Number(mm) - 1, Number(dd))
		const formatted = date.toLocaleDateString("en-US", {
			year: "numeric",
			month: "short",
			day: "numeric"
		})

		return seq === "01" ? formatted : `${formatted} (build ${Number(seq)})`
	}

	function version_item(
		name: string,
		opts: { sdk_path?: string; url?: URL; nightly?: boolean } = {}
	): SdkQuickPickItem {
		const is_current = opts.sdk_path === current_sdk_path && !!opts.sdk_path
		const buttons: vscode.QuickInputButton[] = []

		if (opts.sdk_path) {
			buttons.push(
				{ iconPath: new vscode.ThemeIcon("folder"), tooltip: "Show directory" },
				{ iconPath: new vscode.ThemeIcon("trash"), tooltip: "Delete" }
			)
		} else if (opts.url) {
			buttons.push({
				iconPath: new vscode.ThemeIcon("globe"),
				tooltip: "Show download in browser"
			})
		}

		const nightly_date = opts.nightly
			? parse_nightly_build_date(name)
			: undefined
		const label = nightly_date ?? name

		const status = is_current
			? "(selected)"
			: opts.sdk_path
				? "(downloaded)"
				: undefined
		const description = nightly_date
			? [status, name].filter(Boolean).join(" · ")
			: status

		return {
			label,
			description,
			iconPath: is_current
				? new vscode.ThemeIcon("check")
				: opts.sdk_path
					? new vscode.ThemeIcon("cloud-download")
					: new vscode.ThemeIcon("blank"),
			action: SdkAction.SelectVersion,
			path: opts.sdk_path,
			version: name,
			url: opts.url,
			nightly: opts.nightly,
			buttons
		}
	}

	function build_items(): SdkQuickPickItem[] {
		const items: SdkQuickPickItem[] = []

		// always shown, so it never vanishes from the list
		if (current_sdk_path && current_custom_label) {
			items.push(
				{
					label: current_custom_label,
					description: "(selected)",
					iconPath: new vscode.ThemeIcon("check"),
					action: SdkAction.Path,
					path: current_sdk_path,
					buttons: [
						{
							iconPath: new vscode.ThemeIcon("folder"),
							tooltip: "Show directory"
						}
					]
				},
				{ label: "", kind: vscode.QuickPickItemKind.Separator }
			)
		}

		if (!catalog) {
			// current_sdk_path is intentionally kept in this list (rather than
			// filtered out) - version_item marks it as selected, and it's the
			// only place a managed current sdk is shown when offline
			items.push(
				...downloaded_sdks
					.sort((a, b) => semver_compare(basename(a), basename(b)))
					.map((p) => version_item(basename(p), { sdk_path: p }))
			)
		} else {
			// a search term should match against everything, including
			// versions collapsed behind "Show all versions" - only the unfiltered
			// browse view hides them
			const is_searching = quick_pick.value !== ""
			const sdks_to_show =
				expanded || is_searching
					? catalog.all_valid_sdks
					: catalog.filtered_sdks

			const map_remote = (sdk: RemoteSdk, nightly = false) =>
				version_item(sdk.name, {
					sdk_path: downloaded_path_for(sdk.name),
					url: sdk.url,
					nightly
				})

			const RECENT_NIGHTLY_COUNT = 5
			const recent_nightlies = catalog.nightly_sdks.slice(
				0,
				RECENT_NIGHTLY_COUNT
			)
			const older_nightlies = catalog.nightly_sdks.slice(RECENT_NIGHTLY_COUNT)
			const nightly_expanded_view = nightly_expanded || is_searching

			items.push(
				...sdks_to_show.map((sdk) => map_remote(sdk)),
				...(expanded || is_searching
					? []
					: [
							{
								label: "Show all versions",
								iconPath: new vscode.ThemeIcon("more")
							}
						]),
				{ label: "Nightly builds", kind: vscode.QuickPickItemKind.Separator },
				...recent_nightlies.map((sdk) => map_remote(sdk, true)),
				...(nightly_expanded_view
					? older_nightlies.map((sdk) => map_remote(sdk, true))
					: older_nightlies.length > 0
						? [
								{
									label: "Show older",
									iconPath: new vscode.ThemeIcon("more")
								}
							]
						: [])
			)
		}

		items.push(
			{ label: "", kind: vscode.QuickPickItemKind.Separator },
			{
				label: "$(file-directory) Enter SDK path...",
				action: SdkAction.SystemFilePicker,
				alwaysShow: true
			}
		)

		return items
	}

	const idle_placeholder = "Select Ren'Py SDK version"
	const fetching_placeholder = "Fetching new versions..."

	const quick_pick = vscode.window.createQuickPick<SdkQuickPickItem>()
	quick_pick.placeholder = fetching_placeholder
	quick_pick.keepScrollPosition = true
	quick_pick.matchOnDescription = true
	quick_pick.busy = !catalog
	quick_pick.items = build_items()

	function render() {
		quick_pick.items = build_items()
	}

	let settled = false
	let disposed = false
	let focus_regained_listener: vscode.Disposable | undefined

	// "Show directory"/"Show download in browser" hand focus to another app,
	// which would otherwise dismiss the picker as a focus-out. Ride out just
	// that handoff, then go back to normal dismiss-on-blur once vscode
	// regains focus
	function keep_open_through_external_focus_loss() {
		quick_pick.ignoreFocusOut = true
		focus_regained_listener?.dispose()
		focus_regained_listener = vscode.window.onDidChangeWindowState((state) => {
			if (!state.focused) return
			quick_pick.ignoreFocusOut = false
			focus_regained_listener?.dispose()
			focus_regained_listener = undefined
		})
	}

	// switch the item set between the collapsed and full catalog right when
	// a search starts/clears - vscode's own fuzzy filter does the matching
	// against whatever's currently in `items`, so this is the only point a
	// re-render is needed for search to reach everything
	let was_searching = false
	quick_pick.onDidChangeValue((value) => {
		const is_searching = value !== ""
		if (is_searching !== was_searching) {
			was_searching = is_searching
			render()
		}
	})

	quick_pick.onDidTriggerItemButton(async (e) => {
		switch (e.button.tooltip) {
			case "Show directory": {
				if (!e.item.path) throw new Error("item path is undefined")
				keep_open_through_external_focus_loss()
				await open(e.item.path)
				break
			}
			case "Delete": {
				if (!e.item.path) throw new Error("item path is undefined")
				await uninstall_sdk(e.item.path, context)
				if (e.item.path === current_sdk_path) {
					const { version_file } = await find_version_file(project_root)
					if (version_file) {
						await fs.rm(version_file, { force: true })
					}
				}
				downloaded_sdks = await list_downloaded_sdks(context)
				render()
				break
			}
			case "Show download in browser": {
				if (!e.item.url) throw new Error("item url is undefined")
				keep_open_through_external_focus_loss()
				await open(e.item.url.toString())
				break
			}
			default:
				throw new Error(`unexpected button tooltip: ${e.button.tooltip}`)
		}
	})

	quick_pick.show()

	// refresh the catalog in the background so the next time this opens (or,
	// if it's still open and the user hasn't typed a filter, right now) it
	// reflects anything new. never blocks the picker, and never downloads
	fetch_remote_sdk_catalog(context).then((fresh) => {
		if (settled || disposed) return
		if (fresh) {
			catalog = fresh
			if (quick_pick.value === "") render()
		}
		quick_pick.busy = false
		quick_pick.placeholder = idle_placeholder
	})

	const result = await new Promise<string | void>((resolve) => {
		quick_pick.onDidAccept(async () => {
			const selection = quick_pick.selectedItems[0]
			if (!selection) return

			if (!selection.action && selection.label === "Show all versions") {
				expanded = true
				render()
				return
			}

			if (!selection.action && selection.label === "Show older") {
				nightly_expanded = true
				render()
				return
			}

			settled = true
			quick_pick.hide()

			switch (selection.action) {
				case SdkAction.SystemFilePicker: {
					const fs_path = await prompt_sdk_file_picker()
					if (fs_path) {
						await write_version_selection_for_path(
							fs_path,
							project_root,
							context
						)
					}
					resolve(fs_path)
					return
				}

				case SdkAction.Path: {
					if (!selection.path) return resolve(undefined)

					await write_version_selection_for_path(
						selection.path,
						project_root,
						context
					)
					resolve(selection.path)
					return
				}

				case SdkAction.SelectVersion: {
					if (selection.path) {
						await write_version_selection_for_path(
							selection.path,
							project_root,
							context
						)
						resolve(selection.path)
						return
					}

					// not downloaded - just record the choice
					if (selection.version) {
						const write_root = await resolve_version_write_root(project_root)
						if (write_root) {
							await write_version_file(write_root, selection.version)
						}
					}
					resolve(undefined)
					return
				}

				default:
					resolve(undefined)
			}
		})

		quick_pick.onDidHide(() => {
			if (!settled) resolve(undefined)
			disposed = true
			focus_regained_listener?.dispose()
			quick_pick.dispose()
		})
	})

	return result
}

export async function prompt_sdk_file_picker(): Promise<string | undefined> {
	const input_path = await vscode.window.showOpenDialog({
		openLabel: "Select Ren'Py SDK",
		defaultUri: vscode.Uri.file(homedir()),
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false
	})
	if (typeof input_path === "undefined" || input_path.length === 0) return

	const fs_path = input_path[0].fsPath
	const is_sdk = await path_is_sdk(fs_path)

	if (!is_sdk) {
		const err_selection = await vscode.window.showErrorMessage(
			"Path is not a Ren'Py SDK",
			"Reselect"
		)
		if (err_selection === "Reselect") return prompt_sdk_file_picker()

		return
	}

	return fs_path
}
