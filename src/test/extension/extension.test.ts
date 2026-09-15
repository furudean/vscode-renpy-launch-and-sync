const assert = require("assert")
const vscode = require("vscode")

// import * as myExtension from '../../extension';

suite("Extension Test Suite", () => {
	test("extension activates", async () => {
		const extension = vscode.extensions.getExtension(
			"PaisleySoftworks.renpyWarp"
		)
		assert.ok(extension, "extension not found")

		await extension.activate()
		assert.strictEqual(extension.isActive, true)
	})

	test("commands are registered", async () => {
		const extension = vscode.extensions.getExtension(
			"PaisleySoftworks.renpyWarp"
		)
		await extension.activate()

		const commands = await vscode.commands.getCommands(true)
		assert.ok(
			commands.includes("renpyWarp.launch"),
			"renpyWarp.launch not registered"
		)
		assert.ok(
			commands.includes("renpyWarp.warpToLine"),
			"renpyWarp.warpToLine not registered"
		)
	})
})
