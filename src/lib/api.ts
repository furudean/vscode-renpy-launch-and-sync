import { SemVer, parse as semver_parse } from "semver"

export interface RemoteSdk {
	name: string
	url: URL
	semver: SemVer | null
}

interface Link {
	href: string
	text: string
}

function find_links(html: string): Link[] {
	const anchors = html.matchAll(/<a\s[^>]*?href="([^"]*)"[^>]*>(.*?)<\/a>/gs)

	return Array.from(anchors, ([, href, text]) => ({ href, text: text.trim() }))
}

async function fetch_and_parse_nginx_directory(
	url: string | URL,
	signal?: AbortSignal
): Promise<URL[]> {
	const request = await fetch(url, { signal })
	if (!request.ok) {
		throw new Error(
			`${url} responded with ${request.status} ${request.statusText}`
		)
	}
	const text = await request.text()

	const links = find_links(text)

	return links.map((link) => new URL(link.href, url)).slice(1) // first anchor is the parent directory link
}

function fix_broken_semver(name: string): string {
	// 8.6.0.26021201+nightly.master -> 8.6.0--26021201+nightly.master
	if (name.match(/^\d+\.\d+\.\d+\.\d+\+/)) {
		return name.replace(/^(\d+\.\d+\.\d+)\.(\d+\+)/, "$1--$2")
	}
	// 4.0
	if (name.match(/^\d+\.\d+$/)) {
		return `${name}.0` // add patch version if missing
	}
	// 5.1.4a
	if (name.match(/^\d+\.\d+\.\d+[a-z]$/)) {
		return `${name.slice(0, -1)}--${name.slice(-1)}` // convert 5.1.4a to 5.1.4-a
	}
	// 6.99.14.1 6.99.14.2 etc
	if (name.match(/^\d+\.\d+\.\d+(\.\d+)?$/)) {
		return `${name.split(".").slice(0, 3).join(".")}--${name
			.split(".")
			.slice(3)
			.join(".")}` // 6.99.14--1
	}

	return name
}

export function semver_compare(a: string, b: string): number {
	const semver_a = semver_parse(fix_broken_semver(a))
	const semver_b = semver_parse(fix_broken_semver(b))

	if (semver_a && semver_b) {
		return semver_b.compare(semver_a) // both are valid semvers, compare them (reversed for descending order)
	} else if (semver_a) {
		return -1 // a is a valid semver, b is not
	}
	if (semver_b) {
		return 1 // b is a valid semver, a is not
	}

	return a.localeCompare(b) // neither are valid semvers, compare by name
}

export function sort_remote_sdks(a: RemoteSdk, b: RemoteSdk): number {
	return semver_compare(a.name, b.name)
}

interface Channels {
	releases: { channel: string; split_version: number[] }[]
}

export async function fetch_stable_version(): Promise<string | undefined> {
	const request = await fetch("https://renpy.org/channels.json")
	if (!request.ok) return undefined

	const { releases } = (await request.json()) as Channels
	const release = releases.find((c) => c.channel === "Release")

	return release?.split_version.slice(0, 3).join(".")
}

export function drop_unreleased(
	sdks: RemoteSdk[],
	stable_version: string
): RemoteSdk[] {
	return sdks.filter((sdk) => semver_compare(sdk.name, stable_version) >= 0)
}

export async function list_remote_sdks(
	signal?: AbortSignal
): Promise<RemoteSdk[]> {
	const urls = await fetch_and_parse_nginx_directory(
		"https://renpy.org/dl/",
		signal
	)

	const sdks = urls
		.map((url) => {
			const version = decodeURIComponent(url.pathname.split("/")[2])
			return {
				name: version,
				url: url,
				semver: semver_parse(fix_broken_semver(version))
			}
		})
		.sort(sort_remote_sdks)

	return sdks
}

const NIGHTLY_INDEX_URL = "https://nightly.renpy.org/"

export async function list_nightly_sdks(
	signal?: AbortSignal
): Promise<RemoteSdk[]> {
	const request = await fetch(NIGHTLY_INDEX_URL, { signal })
	if (!request.ok) {
		throw new Error(
			`${NIGHTLY_INDEX_URL} responded with ${request.status} ${request.statusText}`
		)
	}
	const text = await request.text()

	// the permalink and documentation links share the table with the builds
	const versions = find_links(text)
		.filter((link) => link.text.includes("+nightly"))
		.map((link) => ({
			name: link.text,
			url: new URL(link.href, NIGHTLY_INDEX_URL),
			semver: semver_parse(fix_broken_semver(link.text))
		}))
		.sort(sort_remote_sdks)

	return versions
}

export async function find_sdk_in_nginx_dir(
	directory: string | URL,
	signal?: AbortSignal
): Promise<URL> {
	const dir = await fetch_and_parse_nginx_directory(directory, signal)

	const sdk = dir.find((url) => url.pathname.endsWith("-sdk.zip"))

	if (!sdk) {
		throw new Error(
			`No SDK found in directory ${directory}. Please check the URL or directory path.`
		)
	}

	return sdk
}

export async function find_sdk_in_nightly_index(
	url: string | URL,
	signal?: AbortSignal
): Promise<URL> {
	url = new URL(url)
	const request = await fetch(url, { signal })
	if (!request.ok) {
		throw new Error(
			`${url} responded with ${request.status} ${request.statusText}`
		)
	}
	const text = await request.text()

	const base = new URL(url)
	if (!base.pathname.endsWith("/")) base.pathname += "/"

	const dir = find_links(text).map((link) => new URL(link.href, base))

	const sdk = dir.find((url) => url.pathname.endsWith("-sdk.zip"))

	if (!sdk) {
		throw new Error(`No SDK found in ${url}`)
	}

	return sdk
}

export async function get_sum_for_sdk(
	url: URL,
	signal?: AbortSignal
): Promise<string | undefined> {
	const sums_url = new URL("./checksums.txt", url.href)

	const response = await fetch(sums_url, { signal })
	if (response.status === 404) return undefined
	if (!response.ok) {
		throw new Error(
			`${sums_url} responded with ${response.status} ${response.statusText}`
		)
	}

	const file_text = await response.text()

	const md5_section = file_text.split("# md5")[1]?.split("# sha1")[0]
	if (!md5_section) throw new Error(`no md5 section found in ${sums_url}`)

	const checksum_pattern = /^([a-fA-F0-9]+)\s+renpy-[\d.]+-sdk\.zip$/m
	const match = md5_section.match(checksum_pattern)
	if (!match) throw new Error(`no checksum found for renpy-sdk in ${sums_url}`)

	return match[1]
}
