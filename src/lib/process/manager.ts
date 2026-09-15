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

	at(index: number): AnyProcess | undefined {
		return Array.from(this).at(index)
	}

	async kill_all() {
		await Promise.all(Array.from(this).map((process) => process.kill()))
	}

	clear() {
		for (const process of this) {
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
