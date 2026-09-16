# This file managed by the Ren'Py Launch and Sync Visual Studio Code extension.
#
# This script provides a mechanism for your Ren'Py game to connect to VS Code
# via a websocket server. It is automatically excluded from builds of your game.
# You can delete this file if you do not want to use the features provided by
# the extension.
#
# This file should not be checked into source control. You can add it to your
# `.gitignore` file by adding the following line:
#
# vscode_renpy_warp_*.rpe*
#
# For more information, see https://github.com/furudean/vscode-renpy-warp
#

import renpy  # type: ignore
from time import sleep
import textwrap
import threading
import json
import functools
import re
import os
from pathlib import Path
import logging

logging.basicConfig()

logger = logging.getLogger("renpy_warp_service")

try:
    logger.setLevel(level=os.getenv('WARP_LOGLEVEL', logging.INFO))
except ValueError:
    logger.setLevel(level=logging.INFO)


class RenpyWarpQuitAction(renpy.ui.Action):
    def __call__(self):
        renpy.exports.quit()


original_quit_action = renpy.config.quit_action


def get_meta():
    RPE_FILE_PATTERN = re.compile(
        r"(?:vscode_)?renpy_warp_(?P<version>\d+\.\d+\.\d+)(?:_(?P<checksum>[a-z0-9]+))?\.rpe(?:\.py)?")

    file = Path(__file__) if __file__.endswith(
        '.rpe.py') else Path(__file__).parent

    filename = os.path.basename(file)
    match = RPE_FILE_PATTERN.match(filename)

    if not match:
        raise Exception(
            f"could not parse filename '{filename}'"
            f" with pattern '{RPE_FILE_PATTERN.pattern}'")

    d = match.groupdict()

    return d["version"], d["checksum"]


def script_dialogue():
    """
    the current say statement's text as written in the script, before
    interpolation, translation and text filters are applied
    """
    try:
        node = renpy.game.script.namemap.get(
            renpy.game.context().current, None)
    except Exception:
        logger.debug("could not look up current node", exc_info=True)
        return None

    what = getattr(node, "what", None)

    return what if isinstance(what, str) else None


def say_segments_supported():
    """
    whether character callbacks report each `{w}` pause of a say statement.
    ren'py 8.3 added the arguments describing them, and a game asking for older
    behaviour with `config.version` turns them back off
    """
    return getattr(renpy.config, "character_callback_compat", True) is None


RESYNC_WINDOW = 64
RESYNC_ANCHOR = 8


def resync(script_text, displayed, i, j):
    """
    how far to step through one text or the other for the two to line up again,
    as a (script, displayed) pair, or None if they don't inside the window
    """
    script_anchor = script_text[i:i + RESYNC_ANCHOR]
    displayed_anchor = displayed[j:j + RESYNC_ANCHOR]

    for k in range(1, RESYNC_WINDOW):
        # text the filter added
        if displayed[j + k:j + k + RESYNC_ANCHOR] == script_anchor:
            return 0, k

        # text the filter took out
        if script_text[i + k:i + k + RESYNC_ANCHOR] == displayed_anchor:
            return k, 0

    return None


def tag_length(text, i):
    """the length of the text tag at `i`, or 0 if a tag doesn't start there"""
    if not text.startswith("{", i) or text.startswith("{{", i):
        return 0

    close = text.find("}", i)

    return 0 if close == -1 else close + 1 - i


def dialogue_offset(script_text, displayed, end):
    """
    where `end`, an index into the text ren'py displays, falls in the text the
    script writes. `config.say_menu_text_filter` and interpolation rewrite one
    into the other, adding text tags and swapping characters as they go, so the
    two are walked side by side rather than assumed equal
    """
    if script_text == displayed:
        return end

    # a translated line has nothing to line up with, so give up on it rather
    # than walking the whole thing
    budget = 1 + len(displayed) // 4

    i = 0
    j = 0

    while j < end and i < len(script_text):
        # `{{` escapes a brace, so it is a character of text rather than a tag
        if script_text[i:i + 2] == displayed[j:j + 2] == "{{":
            i += 2
            j += 2
            continue

        # tags line up as whole units rather than character by character,
        # since the script and the filter each write their own
        script_tag = script_text[i:i + tag_length(script_text, i)]
        displayed_tag = displayed[j:j + tag_length(displayed, j)]

        # the same tag on both sides, so step over it together
        if script_tag and script_tag == displayed_tag:
            i += len(script_tag)
            j += len(displayed_tag)
            continue

        # a tag the filter added, a pause among them
        if displayed_tag:
            j += len(displayed_tag)
            continue

        # a script tag the filter wrote its own in place of
        if script_tag:
            i += len(script_tag)
            continue

        if script_text[i] == displayed[j]:
            i += 1
            j += 1
            continue

        step = resync(script_text, displayed, i, j)

        if step is None:
            # a character the filter swapped, such as a curly quote
            budget -= 1

            if budget == 0:
                return None

            step = (1, 1)

        i += step[0]
        j += step[1]

    return i


def invoke(fn):
    while renpy.exports.is_init_phase():
        logger.debug("in init phase, waiting...")
        sleep(0.2)

    renpy.exports.invoke_in_main_thread(fn)


def py_exec(text):
    invoke(functools.partial(renpy.python.py_exec, text))


_resume_context = None


def begin_next_checkpoint():
    global _resume_context
    _resume_context = renpy.game.context().current

    if renpy.game.log.in_rollback():
        renpy.exports.roll_forward_core()

    renpy.exports.end_interaction(True)


def socket_send(message, websocket):
    """sends a message to the socket server"""
    stringified = json.dumps(message)
    websocket.send(stringified)
    logger.debug(f"sent message: {stringified}")


def socket_listener(websocket):
    """listens for messages from the socket server"""
    for message in websocket:
        logger.debug(f"receive message: {message}")
        payload = json.loads(message)

        if payload["type"] == "warp_to_line":
            file = payload["file"]
            line = payload["line"]

            py_exec(f"renpy.warp_to_line('{file}:{line}')")

        elif payload["type"] == "set_autoreload":
            script = textwrap.dedent("""
                if renpy.get_autoreload() == False:
                    renpy.set_autoreload(True)
                    renpy.reload_script()
            """)
            py_exec(script)

        elif payload["type"] == "advance":
            py_exec("renpy.end_interaction(True)")

        elif payload["type"] == "rollback":
            global _resume_context
            _resume_context = None
            py_exec("renpy.rollback(force=True, checkpoints=1, greedy=True)")

        elif payload["type"] == "next_checkpoint":
            invoke(begin_next_checkpoint)

        elif payload["type"] == "jump_to_label":
            label = payload["label"]

            script = textwrap.dedent(f"""
                if renpy.context_nesting_level() > 0:
                    renpy.jump_out_of_context('{label}')
                else:
                    renpy.jump('{label}')
            """)

            py_exec(script)

        else:
            logger.warning(f"unhandled message type '{payload['type']}'")


def socket_producer(websocket):
    """produces messages to the socket server"""
    from websockets.exceptions import ConnectionClosed  # type: ignore

    send = functools.partial(socket_send, websocket=websocket)

    # report current line to warp server
    def fn(event, interact=True, **kwargs):
        if not interact:
            return

        segmented = say_segments_supported()

        # `show` fires once per pause, the first right after `begin`. without
        # segment reporting it says nothing `begin` doesn't already say
        if event != ("show" if segmented else "begin"):
            return

        global _resume_context

        if _resume_context is not None:
            if renpy.game.context().current == _resume_context:
                # auto-advance through {w} or {p} so a step lands on the next
                # statement, not mid-line
                renpy.exports.invoke_in_main_thread(
                    renpy.exports.end_interaction, True)
                return

            _resume_context = None

        filename, line = renpy.exports.get_filename_line()
        relative_filename = Path(filename).relative_to('game')
        filename_abs = Path(renpy.config.gamedir, relative_filename)

        message = {
            "type": "current_line",
            "line": line,
            "path": filename_abs.resolve().as_posix(),
            "relative_path": relative_filename.as_posix(),
        }

        # the script text places the cursor on the dialogue. ren'py 8.3
        # and later also pass the displayed text to character callbacks,
        # which is used if the script can't be read
        displayed = kwargs.get("what")
        what = script_dialogue()

        if what is None:
            what = displayed

        if isinstance(what, str):
            message["what"] = what

        start = kwargs.get("start")
        end = kwargs.get("end")

        # the stretch of dialogue ren'py is saying right now, which runs from
        # one pause to the next. it is measured in the text ren'py displays, so
        # both ends are walked back to the text the script holds
        if (
            segmented
            and isinstance(what, str)
            and isinstance(displayed, str)
            and isinstance(start, int)
            and isinstance(end, int)
        ):
            said_from = dialogue_offset(what, displayed, start)
            said_to = dialogue_offset(what, displayed, end)

            if said_from is not None and said_to is not None:
                message["said_from"] = said_from
                message["said_to"] = said_to

        try:
            send(message)
        except ConnectionClosed:
            # socket is closed, remove the callback
            renpy.config.all_character_callbacks.remove(fn)

    renpy.config.all_character_callbacks.append(fn)

    def label_callback(name, abnormal):
        try:
            send({"type": "current_label", "label": name})
        except ConnectionClosed:
            # socket is closed, remove the callback
            renpy.config.label_callbacks.remove(label_callback)

    renpy.config.label_callbacks.append(label_callback)

    send({"type": "list_labels", "labels": list(renpy.exports.get_all_labels())})


def socket_service(port, version, checksum):
    """connects to the socket server. returns True if the connection has completed its lifecycle"""
    # websockets module is bundled with renpy on versions >=8.2.0
    from websockets.sync.client import connect  # type: ignore
    from websockets.exceptions import (  # type: ignore
        WebSocketException,
        ConnectionClosedOK,
        ConnectionClosedError
    )

    logger.debug(f"try port {port}")

    try:
        headers = {
            "pid": str(os.getpid()),
            "warp-project-root": Path(renpy.config.gamedir).parent.resolve().as_posix(),
            "warp-version": version,
            "warp-checksum": checksum,
        }

        if os.getenv("WARP_WS_NONCE"):
            headers["warp-nonce"] = os.getenv("WARP_WS_NONCE")

        with connect(
            f"ws://localhost:{port}",
            additional_headers=headers,
            open_timeout=None,
            close_timeout=5,
        ) as websocket:
            quitting = False

            def renpy_warp_quit_callback():
                nonlocal quitting
                quitting = True
                logger.info(f"closing websocket connection :{port}")
                websocket.close(4000, 'renpy quit')

            renpy.config.quit_callbacks.append(renpy_warp_quit_callback)
            renpy.config.quit_action = RenpyWarpQuitAction()

            logger.info(f"connected to renpy warp socket server on :{port}")
            py_exec("renpy.notify(\"Connected to Ren'Py Launch and Sync\")")

            socket_producer(websocket)
            socket_listener(websocket)  # this blocks until socket is closed

            renpy.config.quit_callbacks.remove(renpy_warp_quit_callback)
            renpy.config.quit_action = original_quit_action
            logger.info(f"socket service on :{port} exited")

            if not quitting:
                py_exec(
                    "renpy.notify(\"Disconnected from  Ren'Py Launch and Sync\")")

    except ConnectionClosedOK:
        logger.info(f"socket service on :{port} was terminated by server")
        pass

    except ConnectionClosedError:
        logger.info("connection replaced, service exiting")
        return True

    except WebSocketException as e:
        logger.exception("unexpected websocket error", exc_info=e)

    except (ConnectionError, TimeoutError) as e:
        logger.debug(
            f"{e.__class__.__name__}: could not establish connection to socket server")

    return False


def try_socket_ports_forever():
    version, checksum = get_meta()
    service_closed = False

    while service_closed is False:
        for port in range(40111, 40121):
            service_closed = socket_service(
                port=port, version=version, checksum=checksum)

            if service_closed:
                break

        if service_closed:
            break

        logger.debug(
            "exhausted all ports, waiting 3 seconds before retrying")
        sleep(3)

    logger.info("service closed")


def start_renpy_warp_service():
    if renpy.config.developer:
        renpy_warp_thread = threading.Thread(
            target=try_socket_ports_forever, daemon=True)
        renpy_warp_thread.start()

        logger.info(
            "service thread started. periodically scanning ports for warp server")


def declassify():
    """
    removes `renpy_warp_*.rpe{.py}` from build

    on renpy 8.3 and later, this is automatically done by the renpy build system
    """

    classify = renpy.python.store_dicts["store.build"]["classify"]
    classify("game/renpy_warp_*.rpe", None)
    classify("game/renpy_warp_*.rpe.py", None)


renpy.game.post_init.append(declassify)
renpy.config.display_start_callbacks.append(start_renpy_warp_service)
