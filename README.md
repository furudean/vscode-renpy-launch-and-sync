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

## Quickstart

1. Open your Ren'Py project folder in Visual Studio Code.
2. Open your script file and press <kbd>F5</kbd>. If Visual Studio Code asks for
   a debugger, pick _Ren'Py Launch and Sync_.
3. Choose a Ren'Py SDK version. The extension can download one, or you can point
   it at an SDK on disk. Your choice is saved to a `.renpy-version` file in the
   project.
4. Choose if you want to install extensions. Pick _Always use extensions_ to
   enable warping and _Follow Cursor_.
5. Once the game is running, put your cursor on a line of dialogue and press
   <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>
   (<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> on Mac) to warp the game there.
6. In Ren'Py, you can press <kbd>Shift</kbd>+<kbd>E</kbd> to show the current
   line of dialogue in Visual Studio Code.

See [the user manual](docs/MANUAL.md) for further configuration and use.

## Version support

Ren'Py 8.1+ is fully supported. On Ren'Py 8.1 and 8.2, the editor follows
dialogue a whole line at a time, rather than pausing at each `{w}` and `{p}`.

Ren'Py 8.0 and earlier does not support RPE features.

## Attribution

The icon for this extension is a cropped rendition of the Ren'Py mascot, Eileen,
taken from [the Ren'Py website](https://www.renpy.org/artcard.html).
