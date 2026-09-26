# Ren'Py Launch and Sync

Launch and sync your Ren'Py game at the current line directly from inside Visual
Studio Code.

## Features

- Start and quit your Ren'Py game directly through _Run and Debug_
- Step forward and back through game dialogue, warp to a specific line, or jump
  to label.
- Move cursor position in Visual Studio Code as dialogue progresses with the
  _Follow Cursor_ mode
- File decorations to remind you where you are in the game
- Can manage installs of the Ren'Py SDK
- Can discover and bind to games that were started outside of Visual Studio Code
- Automatically enable autoreload when files change (with a setting)

## Configuration

Renpy Launch and Sync contributes a debugger type, so starting and stopping a
game is done through Visual Studio Code's built-in _Run and Debug_ view. A
default launch configuration works with no setup, but you can add your own to
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
	"sdk": "8.3.7" // sdk version to use (or path to one), taking precedence over .renpy-version
}
```

Per-process output is shown in the _Debug Console_ while a game is running. You
can also use this to send console messages, like with
<kbd>Ctrl</kbd>+<kbd>O</kbd>.

The SDK version used is decided by a `.renpy-version` file in your project if
not specified. The SDK can be automatically downloaded, or you can bring your
own.

## Commands

The extension provides many commands to interact with Ren'Py. You probably want
to know about the following:

| Command                         | Shortcut                                      | Shortcut (Mac)                             |
| ------------------------------- | --------------------------------------------- | ------------------------------------------ |
| Open Ren'Py at the current line | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>  | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> |
| Open Ren'Py at label            | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd>  | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd> |
| Go to current Ren'Py line       | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> | <kbd>⌥</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> |
| Toggle following cursor mode    | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>  | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> |

Starting and stopping a game happen through the _Run and Debug_ view, triggered
by <kbd>F5</kbd> by default.

The commands can otherwise be triggered in several ways:

1. By using the right click context in an editor ![](images/editor_context.png)
2. By opening the command palette and typing the command, i.e.
   `Renpy: Open Ren'Py at line`

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
