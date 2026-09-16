define config.name = "renpyWarp test project"

label start:

    "This is the first line."

    "This is the second line."

    "This is the third line."

    "This is the fourth line."

    return

label pauses:

    "First segment.{w}Second segment.{w}Third segment."

    "After the pauses."

    return

label _fake_pause:

    pause

    jump _return
