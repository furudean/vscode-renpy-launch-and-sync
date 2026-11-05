import { registerHooks } from "node:module"

// unit tests run outside the extension host, so "vscode" resolves to a stub
// that covers what modules touch at import time

const vscode_stub = `
export const window = {
	createOutputChannel: () => ({})
}
`

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "vscode") {
			return {
				url: `data:text/javascript,${encodeURIComponent(vscode_stub)}`,
				shortCircuit: true
			}
		}

		return next(specifier, context)
	}
})
