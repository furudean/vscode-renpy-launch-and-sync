import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import { Socket } from "node:net"
import { userInfo } from "node:os"
import path from "upath"

const DELIMITER = 0x00

export const PIPE_NAMESPACE = "\\\\.\\pipe\\"
export const PIPE_PREFIX = "renpy-warp-"

export function get_ipc_dir(): string {
	if (process.platform === "darwin") {
		return path.join(
			userInfo().homedir,
			"Library",
			"Application Support",
			"renpy-warp"
		)
	}

	const runtime_dir = get_runtime_dir()
	const flatpak_id = process.env.FLATPAK_ID

	if (!runtime_dir) return path.join("/tmp", `renpy-warp-${userInfo().uid}`)

	if (flatpak_id) {
		return path.join(runtime_dir, "app", flatpak_id, "renpy-warp")
	}

	return path.join(runtime_dir, "renpy-warp")
}

function get_runtime_dir(): string | undefined {
	if (process.env.XDG_RUNTIME_DIR) return process.env.XDG_RUNTIME_DIR

	const dir = `/run/user/${userInfo().uid}`

	return existsSync(dir) ? dir : undefined
}

export function get_ipc_path(pid: number = process.pid): string {
	if (process.platform === "win32") {
		return `${PIPE_NAMESPACE}${PIPE_PREFIX}${pid}`
	}

	return path.join(get_ipc_dir(), `${pid}.sock`)
}

export function encode_frame(message: unknown): Buffer {
	return Buffer.concat([
		Buffer.from(JSON.stringify(message), "utf8"),
		Buffer.of(DELIMITER)
	])
}

export class FrameDecoder {
	private pending: Buffer[] = []

	push(chunk: Buffer): string[] {
		const frames: string[] = []
		let start = 0
		let end = chunk.indexOf(DELIMITER, start)

		while (end !== -1) {
			this.pending.push(chunk.subarray(start, end))
			frames.push(Buffer.concat(this.pending).toString("utf8"))
			this.pending = []

			start = end + 1
			end = chunk.indexOf(DELIMITER, start)
		}

		if (start < chunk.length) this.pending.push(chunk.subarray(start))

		return frames
	}
}

/**
 * a framed json connection to one rpe. emits `message` for each frame,
 * `close` once the socket is gone, and `error`
 */
export class WarpConnection extends EventEmitter {
	private socket: Socket
	private decoder = new FrameDecoder()
	private closing = false

	constructor(socket: Socket) {
		super()
		this.socket = socket

		socket.on("data", (chunk) => {
			for (const frame of this.decoder.push(chunk)) {
				let message: unknown

				try {
					message = JSON.parse(frame)
				} catch (error) {
					this.emit("error", error)
					continue
				}

				this.emit("message", message)
			}
		})
		socket.on("close", () => this.emit("close"))
		socket.on("error", (error) => this.emit("error", error))
	}

	get open(): boolean {
		return !this.closing && !this.socket.destroyed && this.socket.writable
	}

	send(message: unknown): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.open) {
				reject(new Error("connection is closed"))
				return
			}

			this.socket.write(encode_frame(message), (error) => {
				if (error) {
					reject(error)
				} else {
					resolve()
				}
			})
		})
	}

	close({ reconnect = true }: { reconnect?: boolean } = {}): void {
		if (!this.open) return
		this.closing = true

		if (!reconnect) {
			this.socket.write(encode_frame({ type: "close", reconnect: false }))
		}

		this.socket.end()
		setTimeout(() => this.socket.destroy(), 1000).unref()
	}
}
