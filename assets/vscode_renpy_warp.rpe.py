# This file managed by the Ren'Py Launch and Sync Visual Studio Code extension.
#
# This script provides a mechanism for your Ren'Py game to connect to VS Code
# over a socket. It is automatically excluded from builds of your game. You can
# delete this file if you do not want to use the features provided by the
# extension.
#
# This file should not be checked into source control. You can add it to your
# `.gitignore` file by adding the following line:
#
# vscode_renpy_warp_*.rpe*
#
# For more information, see https://github.com/furudean/vscode-renpy-warp
#

import functools
import glob
import json
import logging
import os
import re
import socket
import stat
import sys
import textwrap
import threading
import traceback
from pathlib import Path
from time import sleep

import renpy  # type: ignore

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

IM_WINDOWS = os.name == "nt"
DELIMITER = b"\0"
PIPE_NAMESPACE = "\\\\.\\pipe\\"
PIPE_PREFIX = "renpy-warp-"
RETRY_SECONDS = 3


class ConnectionClosed(Exception):
    def __init__(self, reconnect=True):
        super().__init__("connection closed")
        self.reconnect = reconnect


class Connection:
    def __init__(self):
        # character callbacks send from the main thread while the service
        # thread sends too, and frames must not interleave
        self._write_lock = threading.Lock()
        self._buffer = b""
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def send(self, message):
        frame = json.dumps(message).encode("utf-8") + DELIMITER

        with self._write_lock:
            if self.closed:
                raise ConnectionClosed()

            try:
                self.write(frame)
            except OSError as e:
                raise ConnectionClosed() from e

    def receive(self):
        while DELIMITER not in self._buffer:
            try:
                chunk = self.read_chunk()
            except OSError as e:
                raise ConnectionClosed() from e

            if not chunk:
                raise ConnectionClosed()

            self._buffer += chunk

        frame, self._buffer = self._buffer.split(DELIMITER, 1)
        try:
            message = json.loads(frame.decode("utf-8"))
        except ValueError as e:
            raise ValueError(f"malformed frame {frame!r}") from e

        if isinstance(message, dict) and message.get("type") == "close":
            raise ConnectionClosed(reconnect=message.get("reconnect", True))

        return message

    def close(self):
        if self.closed:
            return

        self.closed = True
        self.hang_up()


class UnixConnection(Connection):
    def __init__(self, path):
        super().__init__()
        self._socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)

        try:
            self._socket.connect(path)
        except OSError:
            self._socket.close()
            raise

    def read_chunk(self):
        return self._socket.recv(65536)

    def write(self, data):
        self._socket.sendall(data)

    def hang_up(self):
        # shutdown wakes a recv blocked on another thread, close alone may not
        try:
            self._socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

        self._socket.close()


class NamedPipeConnection(Connection):
    def __init__(self, path):
        import _winapi  # type: ignore

        super().__init__()
        self._winapi = _winapi
        self._pending_read = None

        try:
            self._handle = self._open(path)
        except OSError as e:
            # every pipe instance has a client, so wait for one to free up
            if e.winerror != _winapi.ERROR_PIPE_BUSY:
                raise

            _winapi.WaitNamedPipe(path, 1000)
            self._handle = self._open(path)

        # pipe names are machine-wide, so another user could squat on one
        if not self._owned_by_user():
            _winapi.CloseHandle(self._handle)
            raise PermissionError(f"{path} is owned by another user")

    def _open(self, path):
        # limits the server to identifying this client, so it can't act as
        # this user
        SECURITY_SQOS_PRESENT = 0x00100000
        SECURITY_IDENTIFICATION = 0x00010000

        return self._winapi.CreateFile(
            path,
            self._winapi.GENERIC_READ | self._winapi.GENERIC_WRITE,
            0,
            self._winapi.NULL,
            self._winapi.OPEN_EXISTING,
            self._winapi.FILE_FLAG_OVERLAPPED
            | SECURITY_SQOS_PRESENT
            | SECURITY_IDENTIFICATION,
            self._winapi.NULL,
        )

    def _owned_by_user(self):
        """
        whether the pipe has the same owner as this process, the check .NET
        makes for PipeOptions.CurrentUserOnly. the owner reflects elevation, so
        an elevated server and a normal client don't match
        """
        import ctypes
        from ctypes import wintypes

        SE_KERNEL_OBJECT = 6
        OWNER_SECURITY_INFORMATION = 0x1

        kernel32 = ctypes.WinDLL("kernel32")
        advapi32 = ctypes.WinDLL("advapi32")

        def owner_sid(handle):
            owner = ctypes.c_void_p()
            descriptor = ctypes.c_void_p()

            if advapi32.GetSecurityInfo(
                    wintypes.HANDLE(handle), SE_KERNEL_OBJECT,
                    OWNER_SECURITY_INFORMATION, ctypes.byref(owner),
                    None, None, None, ctypes.byref(descriptor)):
                return None

            try:
                return ctypes.string_at(owner.value, advapi32.GetLengthSid(owner))
            finally:
                kernel32.LocalFree(descriptor)

        theirs = owner_sid(self._handle)

        # -1 is the pseudo-handle for this process
        return theirs is not None and theirs == owner_sid(-1)

    def read_chunk(self):
        ov, _ = self._winapi.ReadFile(self._handle, 65536, overlapped=True)
        self._pending_read = ov

        try:
            _, err = ov.GetOverlappedResult(True)
        finally:
            self._pending_read = None

        # a broken pipe or a cancelled read
        if err != 0:
            return b""

        return bytes(ov.getbuffer())

    def write(self, data):
        ov, _ = self._winapi.WriteFile(self._handle, data, overlapped=True)
        written, err = ov.GetOverlappedResult(True)

        if err != 0 or written != len(data):
            raise OSError(f"pipe write failed ({err})")

    def hang_up(self):
        # wake the service thread
        read = self._pending_read

        if read is not None:
            try:
                read.cancel()
            except OSError:
                pass

        self._winapi.CloseHandle(self._handle)


def connect(path):
    if IM_WINDOWS:
        return NamedPipeConnection(path)

    return UnixConnection(path)


def ipc_dirs():
    uid = os.getuid()
    dirs = []

    if sys.platform == "darwin":
        import pwd

        home = pwd.getpwuid(uid).pw_dir
        dirs.append(os.path.join(
            home, "Library", "Application Support", "renpy-warp"))

    for runtime_dir in (os.environ.get("XDG_RUNTIME_DIR"), f"/run/user/{uid}"):
        if not runtime_dir:
            continue

        dirs.append(os.path.join(runtime_dir, "renpy-warp"))

        pattern = os.path.join(
            glob.escape(runtime_dir), "app", "*", "renpy-warp")
        dirs.extend(sorted(glob.glob(pattern)))

    dirs.append(f"/tmp/renpy-warp-{uid}")

    return list(dict.fromkeys(dirs))


def is_private(directory):
    try:
        stats = os.lstat(directory)
    except OSError:
        return False

    return (
        stat.S_ISDIR(stats.st_mode)
        and stats.st_uid == os.getuid()
        and not stats.st_mode & 0o077
    )


def listdir(directory):
    try:
        return sorted(os.listdir(directory))
    except OSError:
        return []


def list_endpoints():
    endpoints = []

    launched_by = os.getenv("WARP_IPC_PATH")
    if launched_by:
        endpoints.append(launched_by)

    if IM_WINDOWS:
        found = [
            PIPE_NAMESPACE + name
            for name in listdir(PIPE_NAMESPACE)
            if name.startswith(PIPE_PREFIX)
        ]
    else:
        found = [
            os.path.join(directory, name)
            for directory in ipc_dirs()
            if is_private(directory)
            for name in listdir(directory)
            if name.endswith(".sock")
        ]

    endpoints.extend(path for path in found if path not in endpoints)

    return endpoints


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


def console_lex(code):
    if "\n" in code:
        return None, code

    block = [("<console>", 1, code, [])]
    l = renpy.parser.Lexer(block)
    l.advance()

    return l.word(), l.rest()


def console_jump(rest):
    """
    implementation of 'jump <label>' that jumps out of context if needed
    """
    label = rest.strip()

    if not label:
        return "Label name must not be empty.", True
    if not renpy.exports.has_label(label):
        return f"Label {label!r} not found.", True

    script = textwrap.dedent(f"""
        if renpy.context_nesting_level() > 0:
            renpy.jump_out_of_context({label!r})
        else:
            renpy.jump({label!r})
    """)
    renpy.python.py_exec(script)

    return "", False


def console_send(nonce, code, connection):
    try:
        import store._console as _console_store  # type: ignore

        console = getattr(_console_store, "console", None)

        if console is None:
            text, is_error = "Developer console is not available.", True
        else:
            command_word, rest = console_lex(code)

            if command_word == "jump":
                text, is_error = console_jump(rest)
            elif command_word == "exit":
                text, is_error = "There's no interactive console session here to exit.", False
            else:
                console.run([code])
                he = console.history[-1]
                text, is_error = he.result or "", bool(
                    getattr(he, "is_error", False))

            renpy.exports.restart_interaction()
    except renpy.game.CONTROL_EXCEPTIONS:
        socket_send({
            "type": "console_result",
            "nonce": nonce,
            "text": "",
            "is_error": False,
        }, connection)
        raise
    except Exception:  # noqa: BLE001
        text, is_error = traceback.format_exc(), True

    socket_send({
        "type": "console_result",
        "nonce": nonce,
        "text": text,
        "is_error": is_error,
    }, connection)


_resume_context = None


def begin_next_checkpoint():
    global _resume_context
    _resume_context = renpy.game.context().current

    if renpy.game.log.in_rollback():
        renpy.exports.roll_forward_core()

    renpy.exports.end_interaction(True)


def socket_send(message, connection):
    """sends a message to the socket server"""
    connection.send(message)
    logger.debug(f"sent message: {message}")


def handle_message(payload, connection):
    if payload["type"] == "warp_to_line":
        file = payload["file"]
        line = payload["line"]

        # !r so server-supplied values are only ever string literals
        py_exec(f"renpy.warp_to_line({f'{file}:{int(line)}'!r})")

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

    elif payload["type"] == "console":
        invoke(functools.partial(
            console_send, payload.get("nonce"), payload["code"], connection))

    elif payload["type"] == "jump_to_label":
        label = str(payload["label"])

        script = textwrap.dedent(f"""
            if renpy.context_nesting_level() > 0:
                renpy.jump_out_of_context({label!r})
            else:
                renpy.jump({label!r})
        """)

        py_exec(script)

    else:
        logger.warning(f"unhandled message type '{payload['type']}'")


def socket_listener(connection):
    while True:
        try:
            payload = connection.receive()
        except ValueError:
            logger.exception("dropped a malformed frame")
            continue

        logger.debug(f"receive message: {payload}")

        try:
            handle_message(payload, connection)
        except Exception:
            logger.exception(f"failed to handle frame {payload!r}")


def socket_producer(connection):
    """produces messages to the socket server"""

    send = functools.partial(socket_send, connection=connection)

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


def socket_service(path, version, checksum):
    """connects to the socket server. returns True if the connection has completed its lifecycle"""

    logger.debug(f"try {path}")

    try:
        connection = connect(path)
    except OSError as e:
        logger.debug(
            f"{e.__class__.__name__}: could not connect to {path}")
        return False

    with connection:
        hello = {
            "type": "hello",
            "pid": os.getpid(),
            "project_root": Path(renpy.config.gamedir).parent.resolve().as_posix(),
            "version": version,
            "checksum": checksum,
        }

        if os.getenv("WARP_IPC_NONCE"):
            hello["nonce"] = int(os.getenv("WARP_IPC_NONCE"))

        try:
            connection.send(hello)

            # the server may ask the user first, so wait as long as it takes
            reply = connection.receive()
        except ConnectionClosed as e:
            logger.debug(f"{path} turned the connection away")
            return not e.reconnect

        if not isinstance(reply, dict) or reply.get("type") != "welcome":
            logger.warning(f"expected welcome, got {reply!r}")
            return False

        quitting = False

        def renpy_warp_quit_callback():
            nonlocal quitting
            quitting = True
            logger.info(f"closing socket connection {path}")
            connection.close()

        renpy.config.quit_callbacks.append(renpy_warp_quit_callback)
        renpy.config.quit_action = RenpyWarpQuitAction()

        logger.info(f"connected to renpy warp socket server on {path}")
        py_exec("renpy.notify(\"Connected to Ren'Py Launch and Sync\")")

        stop = False

        try:
            socket_producer(connection)
            socket_listener(connection)
        except ConnectionClosed as e:
            stop = quitting or not e.reconnect
        finally:
            renpy.config.quit_callbacks.remove(renpy_warp_quit_callback)
            renpy.config.quit_action = original_quit_action

        if stop and not quitting:
            logger.info("server asked not to reconnect, service exiting")
        else:
            logger.info(f"socket service on {path} exited")

        if not quitting:
            py_exec(
                "renpy.notify(\"Disconnected from Ren'Py Launch and Sync\")")

        return stop


def try_endpoints_forever():
    version, checksum = get_meta()

    while True:
        for path in list_endpoints():
            try:
                stop = socket_service(
                    path=path, version=version, checksum=checksum)

            # keep the thread alive, so the game can reconnect
            except Exception:  # noqa: BLE001
                logger.exception(f"socket service on {path} failed")
                stop = False

            if stop:
                logger.info("service closed")
                return

        logger.debug(
            f"tried every server. sleeping {RETRY_SECONDS} seconds before retrying")
        sleep(RETRY_SECONDS)


def start_renpy_warp_service():
    if renpy.config.developer:
        renpy_warp_thread = threading.Thread(
            target=try_endpoints_forever, daemon=True)
        renpy_warp_thread.start()

        logger.info(
            "service thread started. periodically looking for warp server")


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
