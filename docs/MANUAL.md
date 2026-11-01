# User manual

## Configuration

Renpy Launch and Sync contributes a debugger type. Starting and stopping a game
is done through Visual Studio Code's built-in _Run and Debug_ view.

The default launch configuration works, but you can add your own to
`.vscode/launch.json` to customize it:

```jsonc
{
	"type": "renpyWarp",
	"request": "launch",
	"name": "Launch Ren'Py project",
	// all properties optional below
	"project": "/path/to/project", // automatic if not specified
	"file": "script.rpy", // script to warp to on launch (useful with ${file})
	"line": 11, // line in `file` to warp to (useful with `${lineNumber}`)
	"args": [], // CLI arguments to pass to renpy
	"env": {}, // environment variables to pass to renpy
	"sdk": "8.3.7" // sdk version to use (or path to one), taking precedence over .renpy-version file
}
```

Per-process output is shown in the _Debug Console_ while a game is running. You
can also use this to send console messages, like with
<kbd>Ctrl</kbd>+<kbd>O</kbd>.

The SDK version used is decided by a `.renpy-version` file in your project. This
can contain a SemVer version or an absolute path to an SDK on disk.

## Commands

The extension provides many commands to interact with Ren'Py. Below is a table
of some of the common ones. A full reference (including keybinds) can be seen in
the extensions feature contributions tab.

| Command                       | Shortcut                                                     | Shortcut (Mac)                                          |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| Open Ren'Py to line           | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>                 | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>              |
| Open Ren'Py at label          | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd>                 | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd>              |
| Go to current Ren'Py line     | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>                | <kbd>⌥</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>              |
| Toggle following cursor mode  | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>                 | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>              |
| Cycle follow cursor direction | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> | <kbd>⌘</kbd>+<kbd>⌥</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> |

Starting and stopping a game happen through the _Run and Debug_ view, triggered
by <kbd>F5</kbd> by default.

The commands can otherwise be triggered in several ways:

1. By using the right click context in an editor ![](../images/editor_context.png)
2. By opening the command palette and typing the command, i.e.
   `Ren'Py Launch: Open Ren'Py to line`

## Follow Cursor

Renpy Launch and Sync can keep its cursor in sync with the Ren'Py game. Click
the direction next to _Follow Cursor_ in the status bar to cycle between the
modes.

<dl>
   <dt><strong>Ren'Py → Script</strong></dt>
   <dd>
      Ren'Py advancing will update the editor's cursor
   </dd>
   <dt><strong>Ren'Py ← Script</strong></dt>
   <dd>
      Editor cursor will update Ren'Py's current line
   </dd>
   <dt><strong>Ren'Py ↔ Script</strong></dt>
   <dd>
      Ren'Py and editor cursor stay in sync with each other
   </dd>
</dl>

Cursor syncing can be turned on by default with the setting
`renpyWarp.followCursorOnLaunch`.

## Troubleshooting

In order to jump to specific lines, your game must be compatible with warping as
described in
[the Ren'Py documentation](https://www.renpy.org/doc/html/developer_tools.html#warping-to-a-line).
This feature has several limitations, and as such may not work for all games.

## Ren'Py extension

The extension installs an .rpe file in your project. This is a Python file that
Ren'Py will execute at startup. The source of this file can be found at
[`assets/vscode_renpy_warp.rpe.py`](../assets/vscode_renpy_warp.rpe.py).

The .rpe connects the running game to the extension over a socket. This kind of
communication is usually referred to as inter-process communication (IPC).

On Windows, a named pipe is used for IPC. On Unix systems, a domain socket will
be used. In previous versions of the extension, a websocket was used on all
systems. This was discontinued due to security reasons.

The .rpe file will not modify your game's files directly, but it will change
some environment variables and inject some Ren'Py configuration variables. They
are documented in the tables below.

### Environment variables

Set on games launched from the extension.

| Variable                   | Value                                      |
| -------------------------- | ------------------------------------------ |
| `RENPY_EDIT_PY`            | Value of the `renpyWarp.editor` setting    |
| `RENPY_VSCODE`             | Path to the `code` or `vscodium` CLI       |
| `RENPY_SCREENSHOT_PATTERN` | `<project>/screenshot%04d.png`             |
| `RENPY_SKIP_SPLASHSCREEN`  | `1` when _Jump to label_ launches the game |

### Ren'Py configuration

| Variable                         | Change                           |
| -------------------------------- | -------------------------------- |
| `config.display_start_callbacks` | Appends the service starter      |
| `config.all_character_callbacks` | Appends a current line reporter  |
| `config.label_callbacks`         | Appends a label reporter         |
| `config.quit_callbacks`          | Appends a socket closer          |
| `config.quit_action`             | Replaces with a direct quit      |
| `config.periodic_callbacks`      | Appends a task runner on 8.1–8.2 |

The RPE also turns on autoreload through `renpy.set_autoreload` when
`renpyWarp.setAutoReloadOnSave` is enabled.

## Files

The extension writes files in your project in order to provide functionality.

| File                                                      | Purpose                                   |
| --------------------------------------------------------- | ----------------------------------------- |
| `game/libs/vscode_renpy_warp_<version>_<checksum>.rpe.py` | The RPE on Ren'Py 8.4+                    |
| `game/vscode_renpy_warp_<version>_<checksum>.rpe.py`      | The RPE on Ren'Py 8.3                     |
| `game/vscode_renpy_warp_<version>_<checksum>.rpe`         | The RPE on Ren'Py 8.1 and 8.2             |
| .renpy-version                                            | Stores your Ren'Py SDK version preference |

`.rpe` is a zip archive with the RPE source as its `autorun.py`. On Ren'Py 8.3+,
the extension will replace a `.rpe` with a `.rpe.py`.

Older versions of the extension installed the RPE in other forms. The extension
will locate and replace them on install or update. The old forms include:

- `renpy_warp_*` in place of the `vscode_renpy_warp_*` prefix
- No checksum in the name
