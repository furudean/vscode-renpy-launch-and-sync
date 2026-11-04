import path from "upath"
import { sep } from "node:path"

export function shrink_path(full_path: string, max_length: number): string {
	const parts = path.toUnix(full_path).split("/")
	const widths = parts.map((part) => part.length)
	const last = parts.length - 1
	const middle = last / 2

	let total = full_path.length

	while (total > max_length) {
		let pick = -1

		for (let i = 0; i < last; i++) {
			if (widths[i] <= 1 + "..".length) continue

			if (
				pick === -1 ||
				widths[i] > widths[pick] ||
				(widths[i] === widths[pick] &&
					Math.abs(i - middle) < Math.abs(pick - middle))
			) {
				pick = i
			}
		}

		if (pick === -1) break

		widths[pick]--
		total--
	}

	return parts
		.map((part, i) =>
			widths[i] < part.length
				? part.slice(0, widths[i] - "..".length) + ".."
				: part
		)
		.join(sep)
}
