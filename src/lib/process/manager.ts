import { AnyProcess, ManagedProcess } from "."
import { EventEmitter } from "node:events"
import { get_logger } from "../log"

const logger = get_logger()

export class ProcessManager {
	private processes = new Map<number, AnyProcess>()

	private emitter = new EventEmitter()
	private emit = this.emitter.emit.bind(this.emitter)
	on = this.emitter.on.bind(this.emitter)
	off = this.emitter.off.bind(this.emitter)
	once = this.emitter.once.bind(this.emitter)

	constructor() {}

	[Symbol.iterator]() {
		return this.processes.values()
	}

	get length() {
		return this.processes.size
	}

	async add(id: number, process: AnyProcess) {
		this.processes.set(id, process)

		this.emit("attach", process)

		process.once("exit", () => {
			this.processes.delete(id)
			this.emit("exit", process)
		})
	}

	get(id: number): AnyProcess | undefined {
		return this.processes.get(id)
	}

	find_by_pid(pid: number): AnyProcess | undefined {
		for (const process of this) {
			if (process.pid === pid) return process
		}

		return undefined
	}

	forget(process: AnyProcess): void {
		for (const [id, candidate] of this.processes) {
			if (candidate === process) {
				this.processes.delete(id)
				return
			}
		}
	}

	find_by_debug_session(session_id: string): AnyProcess | undefined {
		for (const process of this) {
			if (process.debug_session_id === session_id) return process
		}

		return undefined
	}

	newest(
		predicate: (process: AnyProcess) => boolean = () => true
	): AnyProcess | undefined {
		let newest: AnyProcess | undefined

		// a map iterates in insertion order
		for (const process of this) {
			if (predicate(process)) newest = process
		}

		return newest
	}

	async kill_all() {
		await Promise.all(Array.from(this).map((process) => process.kill()))
	}

	disconnect_all() {
		for (const [id, process] of Array.from(this.processes)) {
			if (process instanceof ManagedProcess) {
				process.socket?.close()
				continue
			}

			process.emit("exit")
			process.dispose()
			this.processes.delete(id)
		}
	}

	dispose() {
		for (const process of this) {
			if (process instanceof ManagedProcess) {
				process.kill().catch((error) => {
					logger.error(`failed to kill process ${process.pid}:`, error)
				})
			} else {
				process.dispose()
			}
		}
	}
}
