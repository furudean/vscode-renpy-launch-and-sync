import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer, connect, Socket } from "node:net"
import { once } from "node:events"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import path from "node:path"
import {
	encode_frame,
	FrameDecoder,
	get_ipc_dir,
	WarpConnection
} from "./connection.ts"

const saved_env = {
	XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
	FLATPAK_ID: process.env.FLATPAK_ID
}

function set_env(env: Partial<typeof saved_env>) {
	for (const key of Object.keys(saved_env) as (keyof typeof saved_env)[]) {
		if (env[key] === undefined) {
			delete process.env[key]
		} else {
			process.env[key] = env[key]
		}
	}
}

const is_mac = process.platform === "darwin"
const is_linux = !is_mac && process.platform !== "win32"

describe("get_ipc_dir", () => {
	after(() => set_env(saved_env))

	test("uses application support on macOS", { skip: !is_mac }, () => {
		set_env({ XDG_RUNTIME_DIR: "/run/user/1000" })

		assert.equal(
			get_ipc_dir(),
			path.join(userInfo().homedir, "Library/Application Support/renpy-warp")
		)
	})

	test("uses XDG_RUNTIME_DIR", { skip: !is_linux }, () => {
		set_env({ XDG_RUNTIME_DIR: "/run/user/1000" })

		assert.equal(get_ipc_dir(), "/run/user/1000/renpy-warp")
	})

	test("falls back by uid", { skip: !is_linux }, () => {
		set_env({})

		const uid = userInfo().uid

		assert.ok(
			[`/run/user/${uid}/renpy-warp`, `/tmp/renpy-warp-${uid}`].includes(
				get_ipc_dir()
			)
		)
	})

	test(
		"uses the app directory a flatpak shares with the host",
		{ skip: !is_linux },
		() => {
			set_env({
				XDG_RUNTIME_DIR: "/run/user/1000",
				FLATPAK_ID: "com.visualstudio.code"
			})

			assert.equal(
				get_ipc_dir(),
				"/run/user/1000/app/com.visualstudio.code/renpy-warp"
			)
		}
	)
})

const RPE_PATH = path.join(
	import.meta.dirname,
	"../../../assets/vscode_renpy_warp.rpe.py"
)

/** loads the rpe with renpy stubbed out and prints its ipc_dirs() */
const IPC_DIRS_SCRIPT = `
import sys, json, unittest.mock
sys.modules["renpy"] = unittest.mock.MagicMock()
rpe = {"__file__": sys.argv[1], "__name__": "rpe"}
exec(compile(open(sys.argv[1]).read(), sys.argv[1], "exec"), rpe)
print(json.dumps(rpe["ipc_dirs"]()))
`

const has_python = spawnSync("python3", ["--version"]).status === 0

describe(
	"rpe ipc_dirs",
	{ skip: process.platform === "win32" || !has_python },
	() => {
		let runtime_dir: string

		before(async () => {
			runtime_dir = await mkdtemp(path.join(tmpdir(), "rw-runtime-"))
			await mkdir(
				path.join(runtime_dir, "app/com.visualstudio.code/renpy-warp"),
				{ recursive: true }
			)
		})

		after(async () => {
			set_env(saved_env)
			await rm(runtime_dir, { recursive: true, force: true })
		})

		function rpe_ipc_dirs(): string[] {
			const result = spawnSync("python3", ["-c", IPC_DIRS_SCRIPT, RPE_PATH], {
				env: process.env,
				encoding: "utf8"
			})
			assert.equal(result.status, 0, result.stderr)

			return JSON.parse(result.stdout)
		}

		const envs: Record<string, () => Partial<typeof saved_env>> = {
			"without a runtime dir": () => ({}),
			"with a runtime dir": () => ({ XDG_RUNTIME_DIR: runtime_dir }),
			"in a flatpak": () => ({
				XDG_RUNTIME_DIR: runtime_dir,
				FLATPAK_ID: "com.visualstudio.code"
			})
		}

		for (const [name, env] of Object.entries(envs)) {
			test(`searches where the server listens ${name}`, () => {
				set_env(env())

				assert.ok(rpe_ipc_dirs().includes(get_ipc_dir()))
			})
		}
	}
)

describe("encode_frame", () => {
	test("ends the json with a null byte", () => {
		const frame = encode_frame({ type: "advance" })

		assert.equal(frame.at(-1), 0)
		assert.equal(frame.subarray(0, -1).toString(), '{"type":"advance"}')
	})

	test("escapes a null character inside a string", () => {
		const frame = encode_frame({ text: "a\u0000b" })

		assert.equal(frame.indexOf(0), frame.length - 1)
	})
})

describe("FrameDecoder", () => {
	test("holds a frame until its delimiter arrives", () => {
		const decoder = new FrameDecoder()

		assert.deepEqual(decoder.push(Buffer.from('{"a":')), [])
		assert.deepEqual(decoder.push(Buffer.from("1}\0")), ['{"a":1}'])
	})

	test("returns every frame in one chunk", () => {
		const decoder = new FrameDecoder()

		assert.deepEqual(decoder.push(Buffer.from('{"a":1}\0{"b":2}\0{"c"')), [
			'{"a":1}',
			'{"b":2}'
		])
		assert.deepEqual(decoder.push(Buffer.from(":3}\0")), ['{"c":3}'])
	})

	test("decodes a multibyte character split across chunks", () => {
		const decoder = new FrameDecoder()
		const frame = encode_frame({ what: "こんにちは" })
		const split = frame.indexOf(Buffer.from("ん")) + 1

		assert.deepEqual(decoder.push(frame.subarray(0, split)), [])
		assert.deepEqual(
			decoder.push(frame.subarray(split)).map((f) => JSON.parse(f)),
			[{ what: "こんにちは" }]
		)
	})

	test("returns an empty frame for a lone delimiter", () => {
		assert.deepEqual(new FrameDecoder().push(Buffer.of(0)), [""])
	})
})

describe("WarpConnection", () => {
	let dir: string
	let count = 0

	// a short directory, since unix socket paths cap out near 104 bytes
	before(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "rw-"))
	})

	after(() => rm(dir, { recursive: true, force: true }))

	// each pair gets its own endpoint, since a closing server holds its name
	// for a moment on windows
	async function pair(): Promise<[WarpConnection, Socket, () => void]> {
		count += 1
		const ipc_path =
			process.platform === "win32"
				? `\\\\.\\pipe\\rw-test-${process.pid}-${count}`
				: path.join(dir, `${count}.sock`)

		const server = createServer()
		server.listen(ipc_path)
		await once(server, "listening")

		const client = connect(ipc_path)
		const [socket] = (await once(server, "connection")) as [Socket]

		return [
			new WarpConnection(socket),
			client,
			() => {
				client.destroy()
				server.close()
			}
		]
	}

	test("emits each message the peer sends", async () => {
		const [connection, client, done] = await pair()

		try {
			const received: unknown[] = []
			const both = new Promise<void>((resolve) => {
				connection.on("message", (message) => {
					received.push(message)
					if (received.length === 2) resolve()
				})
			})

			client.write('{"type":"a"}\0{"type"')
			client.write(':"b"}\0')
			await both

			assert.deepEqual(received, [{ type: "a" }, { type: "b" }])
		} finally {
			done()
		}
	})

	test("sends framed json", async () => {
		const [connection, client, done] = await pair()

		try {
			await connection.send({ type: "advance" })
			const [chunk] = (await once(client, "data")) as [Buffer]

			assert.equal(chunk.toString(), '{"type":"advance"}\0')
		} finally {
			done()
		}
	})

	test("tells the peer not to reconnect", async () => {
		const [connection, client, done] = await pair()

		try {
			const chunks: Buffer[] = []
			client.on("data", (chunk) => chunks.push(chunk))

			connection.close({ reconnect: false })
			assert.equal(connection.open, false)

			await once(client, "end")

			assert.equal(
				Buffer.concat(chunks).toString(),
				'{"type":"close","reconnect":false}\0'
			)
		} finally {
			done()
		}
	})

	test("emits close when the peer hangs up", async () => {
		const [connection, client, done] = await pair()

		try {
			client.end()
			await once(connection, "close")

			assert.equal(connection.open, false)
			await assert.rejects(connection.send({ type: "advance" }))
		} finally {
			done()
		}
	})
})
