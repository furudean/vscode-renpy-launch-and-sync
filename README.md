# Ren'Py Launch and Sync

Launch and sync your Ren'Py game at the current line directly from inside Visual
Studio Code.

## Features

- Start and quit your Ren'Py game directly from Visual Studio Code, through the
  Run and Debug view
- Warp games to a specific line, or jump to a label
- Move cursor position in Visual Studio Code as dialogue progresses with the
  _Follow Cursor_ mode
- A gutter decoration to remind you where you are in the game, even when the
  cursor moves away
- Automatically enable autoreload when files change (with a setting)
- Can discover and bind to games that were started outside of Visual Studio
  Code
- Can manage installs of the Ren'Py SDK directly from Visual Studio Code

## Commands

The extension provides many commands to interact with Ren'Py. You probably want
to know about the following:

| Command                         | Shortcut                                      | Shortcut (Mac)                             |
| ------------------------------- | --------------------------------------------- | ------------------------------------------ |
| Start Ren'Py project            | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>  | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> |
| Open Ren'Py at the current line | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>  | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> |
| Open Ren'Py at label            | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd>  | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd> |
| Go to current Ren'Py line       | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> | <kbd>⌥</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> |
| Toggle following cursor mode    | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>  | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> |

### Triggers

The commands can be triggered in several ways:

1. By using title bar run menu ![](images/tab_bar.png)
2. By using the right click context in an editor ![](images/editor_context.png)
3. By using the right click context menu in the file explorer
   ![](images/explorer_context.png)
4. By using the status bar ![](images/status_bar.png)
5. By opening the command palette and typing the command, i.e.
   `Renpy: Open Ren'Py at current line`
6. Via keyboard shortcut ([see here](#commands))

## Run and Debug

The debugger is how the extension runs your game. There is no separate mode:
every Ren'Py process it tracks is a debug session, whether <kbd>F5</kbd>
started it, a command did, or the socket server found a game you started
yourself.

| You want to     | Do this                                                             |
| --------------- | ------------------------------------------------------------------- |
| Start the game  | <kbd>F5</kbd>, the Run and Debug view, or any Ren'Py Launch command |
| Stop it         | Stop on the debug toolbar                                           |
| Stop all of it  | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd>                        |
| Read its output | The Debug Console for that session                                  |

A session shows up with a working Stop button and a Debug Console carrying
everything the game writes, including whatever it printed before the session
attached. There is no separate output channel per process any more.

There are no breakpoints and no stepping. Ren'Py has no debug protocol, so a
session is there to start the game, stop it, and show what it prints.

Warping an already-open game is not a launch, so it starts no new session. With
`renpyWarp.strategy` set to **Update Window**, _Open Ren'Py to current line_
warps the running game and its existing session stays as it is.

If you also have
[Ren'Py Language](https://marketplace.visualstudio.com/items?itemName=LuqueDaniel.languague-renpy)
installed, <kbd>F5</kbd> first asks which debugger to use. Pick **Ren'Py Launch
and Sync**. The prompt goes away once the workspace has a `launch.json`.

### launch.json

Both snippets below are offered by name when you add a configuration.

```json
{
	"version": "0.2.0",
	"configurations": [
		{
			"type": "renpyWarp",
			"request": "launch",
			"name": "Launch Ren'Py project"
		},
		{
			"type": "renpyWarp",
			"request": "launch",
			"name": "Open Ren'Py at current line",
			"file": "${file}",
			"line": "${lineNumber}"
		}
	]
}
```

A `launch` configuration takes the following attributes, all optional:

| Attribute | Type             | Meaning                                                                                        |
| --------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| `project` | string           | Project root, the directory holding `game/`. Detected from `file`, or prompted for, when unset |
| `file`    | string           | Script to open at. Absolute, or relative to `project`                                          |
| `line`    | number \| string | 1-indexed line to warp to. Without it, the first playable statement in `file` is used          |
| `args`    | string[]         | Extra arguments for the Ren'Py command line                                                    |
| `env`     | object           | Extra environment, merged over `renpyWarp.processEnvironment`                                  |
| `sdk`     | string           | SDK to run with, overriding `renpyWarp.sdkPath`. A managed version, or a path                  |

A configuration always opens a new window, so `renpyWarp.strategy` **Update
Window** does not apply to one. **Replace Window** still does.

### Pinning an SDK per configuration

`sdk` overrides <code codesetting="renpyWarp.sdkPath">renpyWarp.sdkPath</code>
for that configuration, which is how a project pins the Ren'Py version it is
written against.

```json
{
	"type": "renpyWarp",
	"request": "launch",
	"name": "Launch on 8.3.7",
	"sdk": "8.3.7"
}
```

A value holding a path separator or starting with `~` is a path to an SDK
directory. Anything else names a version the extension manages, and you are
offered the download when it isn't installed yet. Prefer the version form in a
`launch.json` you commit, since a path is only correct on the machine that
wrote it.

Everything that runs without a debug session still reads the setting. That
includes the SDK shown in the status bar, the RPE installed into your projects
at startup, and the _Lint_, _Delete persistent_ and _Force recompile_ commands.

## Configuration

You must set <code codesetting="renpyWarp.sdkPath">renpyWarp.sdkPath</code> to a
directory where the Ren'Py SDK can be found. If you haven't done so, a prompt
will appear to inform you to set it.

### Strategy

You may want to customize what to do with an open Ren'Py instance when a new
command is issued. In Renpy Launch and Sync, this is called a "strategy".

The strategy is controlled with the setting <code
codesetting="renpyWarp.strategy">renpyWarp.strategy</code>, which can be set to
one of the following values:

<dl>
   <dt><strong>Update Window</strong></dt>
   <dd>
      <p>
         When a command is issued, replace an open editor by sending a
         <code>renpy.warp_to_line()</code> command to the currently running
         Ren'Py instance
      </p>
   </dd>
   <dt><strong>New window</strong></dt>
   <dd>
      Open a new Ren'Py instance when a command is issued
   </dd>
   <dt><strong>Replace window</strong></dt>
   <dd>
      Kill the currently running Ren'Py instance and open a new one when a
      command is issued
   </dd>
</dl>

### Follow Cursor

Renpy Launch and Sync can keep its cursor in sync with the Ren'Py game. The
direction of this sync can be controlled with the setting <code
codesetting="renpyWarp.followCursorMode">renpyWarp.followCursorMode</code>

<dl>
   <dt><strong>Ren'Py updates Visual Studio Code</strong></dt>
   <dd>
      The editor will move its cursor to match the current line of dialogue in
      the game.
   </dd>
   <dt><strong>Visual Studio Code updates Ren'Py</strong></dt>
   <dd>
      Ren'Py will warp to the line being edited. Your game must be compatible
      with warping for this to work correctly.
   </dd>
   <dt><strong>Update both</strong></dt>
   <dd>
      Try and keep both in sync with each other. Because of how warping works,
      this can be a bit janky, causing a feedback loop.
   </dd>
</dl>

Cursor syncing can be turned on by default with the setting <code
codesetting="renpyWarp.followCursorOnLaunch">renpyWarp.followCursorOnLaunch</code>.

## Version support

Ren'Py 8.2+ is fully supported.

Ren'Py 8.1 and earlier does not support RPE features.

## Troubleshooting

In order to use the current line/file feature, your game must be compatible with
warping as described in
[the Ren'Py documentation](https://www.renpy.org/doc/html/developer_tools.html#warping-to-a-line).
This feature has several limitations that you should be aware of, and as such
may not work in all cases.

## Attribution

The icon for this extension is a cropped rendition of the Ren'Py mascot, Eileen,
taken from [the Ren'Py website](https://www.renpy.org/artcard.html).
