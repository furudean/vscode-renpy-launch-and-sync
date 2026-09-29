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

# stands in for a menu or screen
label _simulate_menu:

    pause

    jump _return

define n = Character(None, kind=nvl)

label nvl_dialogue:

    n """
    This is the first nvl paragraph.

    This is the second nvl paragraph.

    This is the third nvl paragraph.
    """

    n "After the nvl dialogue."

    return
