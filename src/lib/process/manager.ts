import { AnyProcess } from "."
import { EventEmitter } from "node:events"

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

	/**
	 * managed processes are keyed by nonce and unmanaged ones by pid, so a
	 * lookup by pid has to walk the values
	 */
	find_by_pid(pid: number): AnyProcess | undefined {
		for (const process of this) {
			if (process.pid === pid) return process
		}

		return undefined
	}

	/** drops a process from tracking without emitting `exit` for it */
	remove_process(process: AnyProcess): void {
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

	/**
	 * drops every process. each one gets an `exit` so the debug session and
	 * the decorations watching it unwind, though the games stay running
	 */
	clear() {
		for (const process of Array.from(this)) {
			process.emit("exit")
			process.dispose()
		}
		this.processes.clear()
	}

	dispose() {
		for (const process of this) {
			process.dispose()
		}
	}
}
