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

	at(index: number): AnyProcess | undefined {
		return Array.from(this).at(index)
	}

	async kill_all() {
		await Promise.all(Array.from(this).map((process) => process.kill()))
	}

	clear() {
		const processes = Array.from(this)
		this.processes.clear()

		for (const process of processes) {
			if (process instanceof ManagedProcess) {
				process.kill().catch((error) => {
					logger.error(`failed to kill process ${process.pid}:`, error)
				})
			} else {
				process.dispose()
			}
		}
	}

	dispose() {
		for (const process of this) {
			process.dispose()
		}
	}
}
