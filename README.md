# Ren'Py Launch and Sync

Launch and sync your Ren'Py game at the current line directly from inside Visual
Studio Code.

## Features

- Start, stop and restart your Ren'Py game in _Run and Debug_
- Step forward and back through game dialogue, warp to a specific line, or jump
  to label.
- Move cursor position in Visual Studio Code as dialogue progresses with the
  _Follow Cursor_ mode
- File decorations to remind you where you are in the game
- Manage installs of the Ren'Py SDK
- Discover and bind to games that were started outside of Visual Studio Code
- Automatically enable autoreload when files change (with a setting)

## Quickstart

### Initial setup

1. Open the _Run and Debug_ menu
2. Create a launch.json file (if none exists)
3. Select _Renpy Launch and Sync_ as the debugger type. This should fill your launch.json with a basic debugger configuration.
4. Start debugging
5. You should be prompted to select an SDK version to use. If unsure, just
   select latest. This will write a file called .renpy-version into your
   workspace.
6. You will be asked if downloading this SDK version is okay. Choose _Download_
   to proceed. The SDK will be downloaded to Visual Studio Code's data
   directory.
7. You will be asked how [Ren'Py
   extensions](docs/MANUAL.md#renpy-extension-rperpepy) should be installed.
   Most features, like _Follow Cursor_, warping in place, and stepping, depend
   on them. This choice is stored in the `renpyWarp.renpyExtensionsEnabled`
   setting.

The game should have been started. Setup is complete.

### After setup

You start the game through the debugger configuration you created.

See [the user manual](docs/MANUAL.md) for further configuration and how to use
the extension's features.

## Version support

Ren'Py 8.3+ supports all features.

On Ren'Py 8.2 and earlier, current line features can't understand `{w}`/`{p}`
and instead show the full line.

Ren'Py 8.0 and earlier does not support .rpe features at all.

Ren'Py 7.x versions may work, but no support will be provided

## Attribution

The icon for this extension is a cropped rendition of the Ren'Py mascot, Eileen,
taken from [the Ren'Py website](https://www.renpy.org/artcard.html).
