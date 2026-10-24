import * as vscode from "vscode"
import path from "node:path"
import { get_logger } from "./log"
import { get_config } from "./config"
import os from "node:os"
import child_process from "node:child_process"
import { promisify } from "node:util"
import { path_exists, resolve_path } from "./path"
import fs from "node:fs/promises"
import find_process from "find-process"
import p_find from "p-locate"
import { path_is_sdk } from "./sdk"

const logger = get_logger()
const IS_WINDOWS = os.platform() === "win32"

export interface RenpyVersion {
	semver: string
	major: number
	minor: number
	patch: number
	rest: string | undefined
	display: string
	raw: string
}

const RENPY_VERSION_REGEX =
	/^(?:Ren'Py )?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:\.(?<rest>.*))?\s*$/

const version_cache = new Map<
	string,
	{ mtime: number; version: Promise<RenpyVersion> }
>()

async function executable_mtime(
	executable: string[]
): Promise<number | undefined> {
	try {
		return (await fs.stat(executable[0])).mtimeMs
	} catch {
		return undefined
	}
}

const exec_file = promisify(child_process.execFile)

async function read_version(executable: string[]): Promise<RenpyVersion> {
	logger.debug("getting version for", executable)
	const { stdout, stderr } = await exec_file(
		executable[0],
		[...executable.slice(1), "--version"],
		{ encoding: "utf-8" }
	)
	const output = [stdout, stderr].find((o) => o.length > 0)?.trim()

	if (output === undefined) {
		throw new Error("no output from version command")
	}

	const { major, minor, patch, rest } =
		RENPY_VERSION_REGEX.exec(output)?.groups ?? {}

	if (major === undefined || minor === undefined || patch === undefined) {
		throw new Error("bad version string: " + output)
	}

	const semver = `${major}.${minor}.${patch}`

	const display = rest?.includes("+") ? `${semver}.${rest}` : semver

	return {
		semver,
		major: Number(major),
		minor: Number(minor),
		patch: Number(patch),
		rest,
		display,
		raw: output
	}
}

/**
 * gets the cached version for an executable
 *
 * @param executable
 * base renpy.sh command
 */
export async function get_version(executable: string[]): Promise<RenpyVersion> {
	const key = executable.join("\u0000")
	const mtime = await executable_mtime(executable)
	const cached = version_cache.get(key)

	if (mtime !== undefined && cached?.mtime === mtime) return cached.version

	const version = read_version(executable)

	if (mtime !== undefined) {
		version_cache.set(key, { mtime, version })

		version.catch(() => {
			if (version_cache.get(key)?.version === version) {
				version_cache.delete(key)
			}
		})
	}

	return version
}

export function find_project_root(
	filename: string,
	haystack: string | null = null,
	depth: number = 1
): string | null {
	if (haystack) {
		haystack = path.resolve(haystack, "..")
	} else {
		haystack = path.dirname(filename)
	}

	if (path.basename(haystack) === "game") {
		return path.resolve(haystack, "..") // return parent
	}

	const workspace_root =
		vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? null

	if (
		haystack === workspace_root ||
		haystack === path.resolve("/") ||
		depth >= 10
	) {
		logger.info("exceeded recursion depth at", filename, haystack)
		return null
	}

	return find_project_root(filename, haystack, depth + 1)
}

export async function get_editor_path(
	sdk_path: string
): Promise<string | undefined> {
	const editor_setting = get_config("editor") as string
	let editor_path: string

	if (path.isAbsolute(editor_setting)) {
		editor_path = resolve_path(editor_setting)
	} else {
		// relative path to launcher
		editor_path = path.resolve(sdk_path, editor_setting)
	}

	if (!(await path_exists(editor_path))) {
		vscode.window
			.showErrorMessage(
				`Invalid Ren'Py editor path: '${editor_setting}' (resolved to '${editor_path}')`,
				"Open Settings"
			)
			.then((selection) => {
				if (!selection) return

				vscode.commands.executeCommand(
					"workbench.action.openSettings",
					"@ext:PaisleySoftworks.renpyWarp"
				)
			})
		return
	}

	return editor_path
}

/**
 * Returns the path to the CLI of the editor this extension is running in.
 */
export async function get_editor_cli_path(): Promise<string | undefined> {
	let application_name: string | undefined

	try {
		const product_json = await fs.readFile(
			path.join(vscode.env.appRoot, "product.json"),
			"utf-8"
		)
		application_name = JSON.parse(product_json).applicationName
	} catch (e) {
		logger.warn("could not read product.json:", e)
		return
	}

	if (!application_name) return

	const binary = IS_WINDOWS ? application_name + ".cmd" : application_name
	const cli_path = path.join(vscode.env.appRoot, "bin", binary)

	if (await path_exists(cli_path)) {
		logger.debug(`using '${cli_path}' as ren'py's editor binary`)
		return cli_path
	}

	// ren'py looks for visual studio code on its own.
	// forks get no such treatment, so try $PATH for those
	if (application_name === "code") {
		logger.warn(`'${cli_path}' does not exist, letting ren'py find an editor`)
		return undefined
	}

	logger.warn(
		`'${cli_path}' does not exist, falling back to '${binary}' on $PATH`
	)
	return binary
}

/**
 * Returns an array of executable commands to run the Ren'Py CLI.
 *
 * If not configured correctly, prompts the user with an error message.
 */
export async function get_executable(
	sdk_path: string,
	prompt = false,
	project_root?: string
): Promise<string[] | undefined> {
	if (!(await path_is_sdk(sdk_path))) {
		logger.debug("not valid sdk", sdk_path)

		if (prompt) {
			vscode.window
				.showErrorMessage("Ren'Py SDK path is invalid", "Update SDK Path")
				.then((selection) => {
					if (selection === "Update SDK Path") {
						vscode.commands.executeCommand("renpyWarp.setSdkPath", project_root)
					}
				})
		}

		return undefined
	}

	if (IS_WINDOWS) {
		// on windows, we call python.exe and pass renpy.py as an argument
		const machine_type = os.machine()

		const candidate_paths = [
			`lib/py3-windows-${machine_type}/python.exe`,
			`lib/py2-windows-${machine_type}/python.exe`,
			`lib/windows-${machine_type}/python.exe`
		]

		const executable = await p_find(candidate_paths, async (candidate) =>
			path_exists(path.join(sdk_path, candidate))
		)

		if (!executable) {
			logger.error(
				`could not find a valid python executable in ${candidate_paths}`
			)
			return undefined
		}

		return [path.join(sdk_path, executable), path.join(sdk_path, "renpy.py")]
	} else {
		// on all other systems, we call renpy.sh directly
		// https://www.renpy.org/doc/html/cli.html#command-line-interface
		return [path.join(sdk_path, "renpy.sh")]
	}
}

export async function process_finished(pid: number): Promise<boolean> {
	// find-process spawns powershell on windows, which is expensive to poll.
	// windows has no zombies, so a signal 0 probe is enough.
	if (IS_WINDOWS) {
		try {
			process.kill(pid, 0)
			return false
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH"
		}
	}

	const [proc] = await find_process("pid", pid)

	logger.trace(`process ${pid} status:`, proc)

	// defunct processes are zombies - they're dead, but still in the process
	// table. the renpy launcher will leave a defunct process behind until it's
	// closed, so we need to check for this specifically.
	return proc === undefined || proc.name === "<defunct>"
}
