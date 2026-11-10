import * as vscode from "vscode"
import path from "upath"
import { get_logger } from "./log"
import {
	is_known_version,
	list_known_versions,
	resolve_project_sdk
} from "./sdk"

const logger = get_logger()

type VersionStatus =
	"valid" | "unknown" | "invalid_directory" | "pending" | "none"

const STATUS_LABELS: Partial<
	Record<VersionStatus, { text: string; color: string }>
> = {
	valid: { text: "✓ Valid", color: "renpyWarp.versionValidForeground" },
	unknown: {
		text: "✕ Not in package index",
		color: "renpyWarp.versionInvalidForeground"
	},
	invalid_directory: {
		text: "✕ Directory is not an SDK",
		color: "renpyWarp.versionInvalidForeground"
	}
}

function is_version_file(document: vscode.TextDocument): boolean {
	return (
		document.uri.scheme === "file" &&
		path.basename(document.uri.fsPath) === ".renpy-version"
	)
}

async function resolve_status(
	document: vscode.TextDocument,
	context: vscode.ExtensionContext
): Promise<VersionStatus> {
	// reads the saved file, so the status only changes on save
	const sdk = await resolve_project_sdk(
		context,
		path.dirname(document.uri.fsPath)
	)

	switch (sdk.kind) {
		case "installed":
			return "valid"
		case "invalid":
			return "invalid_directory"
		case "none":
			return "none"
		case "named": {
			const known = await is_known_version(sdk.name, context)
			if (known === undefined) return "pending"
			return known ? "valid" : "unknown"
		}
	}
}

export class VersionFileAnnotations implements vscode.CompletionItemProvider {
	private decoration = vscode.window.createTextEditorDecorationType({
		after: { margin: "0 0 0 2em" }
	})
	private subscriptions: vscode.Disposable[]

	/** latest update per document, so a slow resolve can't overwrite a newer one */
	private generations = new Map<string, number>()

	constructor(private context: vscode.ExtensionContext) {
		this.subscriptions = [
			this.decoration,
			vscode.languages.registerCompletionItemProvider(
				{ scheme: "file", pattern: "**/.renpy-version" },
				this,
				"."
			),
			vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
			vscode.workspace.onDidSaveTextDocument((document) => {
				if (is_version_file(document)) this.update(document)
			}),

			// covers unsaved edits, an undo back to the saved text, and a reload
			// after something else writes the file, such as the sdk picker
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (is_version_file(e.document)) this.update(e.document)
			})
		]

		this.refresh()
	}

	refresh(): void {
		const documents = new Set(
			vscode.window.visibleTextEditors
				.map((editor) => editor.document)
				.filter(is_version_file)
		)

		for (const document of documents) this.update(document)
	}

	private update(document: vscode.TextDocument): void {
		const key = document.uri.toString()
		const generation = (this.generations.get(key) ?? 0) + 1
		this.generations.set(key, generation)

		if (document.isDirty) {
			this.set_decorations(document, [])
			return
		}

		resolve_status(document, this.context)
			.then((status) => {
				if (this.generations.get(key) !== generation) return

				const label = STATUS_LABELS[status]
				this.set_decorations(
					document,
					label
						? [
								{
									range: document.lineAt(0).range,
									renderOptions: {
										after: {
											contentText: label.text,
											color: new vscode.ThemeColor(label.color)
										}
									}
								}
							]
						: []
				)
			})
			.catch((error) =>
				logger.error("failed to resolve sdk for version file:", error)
			)
	}

	private set_decorations(
		document: vscode.TextDocument,
		decorations: vscode.DecorationOptions[]
	): void {
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document === document) {
				editor.setDecorations(this.decoration, decorations)
			}
		}
	}

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position
	): Promise<vscode.CompletionItem[]> {
		const versions = await list_known_versions(this.context)

		// the whole line is one value, so filter and replace past the dots that
		// would otherwise split it into words
		const range = document.lineAt(position.line).range

		return versions.map((version, i) => {
			const item = new vscode.CompletionItem(
				{
					label: version.name,
					description:
						[version.nightly && "nightly", version.downloaded && "downloaded"]
							.filter(Boolean)
							.join(" · ") || undefined
				},
				vscode.CompletionItemKind.Value
			)
			item.range = range
			item.sortText = String(i).padStart(5, "0")
			return item
		})
	}

	dispose(): void {
		for (const subscription of this.subscriptions) {
			subscription.dispose()
		}
	}
}
