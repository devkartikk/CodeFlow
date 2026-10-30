"""LLDB tracer used by the CodeFlow backend for C and C++.

Loaded into lldb with ``command script import``. The ``codeflow_trace`` command
sets a breakpoint on every line of the user's source file, launches the
program, and records one event per stop: the line, the enclosing function, the
in-scope variables, and the user-code call stack.

Everything recorded here is read from the debugger. Nothing is inferred or
invented: if lldb cannot report a value, the event simply omits it.
"""

import json
import os
import shlex

STATE = {"events": [], "truncated": False}
CONFIG = {"source": "", "out": "", "max_events": 500}
PREVIOUS = {"depth": 0, "stack": []}
# A variable is only reported once the line that declares it has run, so a
# learner never sees the uninitialised stack memory that sits there before.
SEEN = {}
# A list longer than this is drawn as a list of cells in the UI; past a few
# dozen cells the stage stops being readable anyway.
MAX_ELEMENTS = 40


def _frame_name(frame):
    name = frame.GetFunctionName() or frame.GetDisplayFunctionName() or "?"
    # lldb reports C++ symbols with their parameter list, e.g. "add(int, int)".
    return name.split("(")[0] or name


def _is_user_frame(frame):
    """Runtime frames such as start() carry no debug line information."""
    try:
        return frame.GetLineEntry().IsValid()
    except Exception:
        return False


def _dereference(value):
    """A reference (`const vector<int> &numbers`) reports its address.

    lldb hands back the pointer text as the value, which is useless here — the
    animated stage would draw the address one character per cell.
    """
    try:
        type_name = (value.GetTypeName() or "").rstrip()
    except Exception:
        return value
    if not type_name.endswith("&"):
        return value
    try:
        target = value.Dereference()
        if target and target.IsValid():
            return target
    except Exception:
        pass
    return value


def _is_list_like(value):
    """Arrays and std::vector/std::array have no scalar value of their own.

    lldb reports ``int[4]`` as ``<int[4]>`` and a vector as ``size=4``; both are
    useless to the animated stage, which needs the elements themselves.
    """
    try:
        type_name = value.GetTypeName() or ""
    except Exception:
        return False
    lowered = type_name.lower()
    # A char array is a string; drawing it as one cell per letter is not what
    # the program means.
    if "char" in lowered:
        return False
    if type_name.rstrip().endswith("]"):
        return True
    if "vector" in lowered or "std::array" in lowered or "array<" in lowered:
        return True
    try:
        summary = value.GetSummary() or ""
    except Exception:
        return False
    return summary.startswith("size=")


def _format_elements(value):
    """The elements of a list-like value, as text, or None if it has none."""
    try:
        count = value.GetNumChildren()
    except Exception:
        return None
    if count <= 0:
        return None
    items = []
    for index in range(min(count, MAX_ELEMENTS)):
        try:
            child = value.GetChildAtIndex(index)
        except Exception:
            break
        if not child or not child.IsValid():
            break
        # A row of a 2-D array is itself a list; without this it reported "?"
        # and the stage drew two question marks.
        if _is_list_like(child):
            nested = _format_elements(child)
            if nested is not None:
                items.append("[" + ", ".join(nested) + "]")
                continue
        text = child.GetValue()
        if text is None:
            text = child.GetSummary()
        items.append(text if text is not None else "?")
    return items


def _format_value(value):
    value = _dereference(value)
    if _is_list_like(value):
        items = _format_elements(value)
        if items is not None:
            return "[" + ", ".join(items) + "]"
    text = value.GetValue()
    if text is not None:
        return text
    text = value.GetSummary()
    if text is None:
        type_name = value.GetTypeName() or "value"
        return "<%s>" % type_name
    return text


def _declaration_line(value):
    try:
        declaration = value.GetDeclaration()
        if declaration.IsValid():
            return declaration.GetLine()
    except Exception:
        pass
    return None


def _collect(frame, include_locals, line, function):
    variables = {}
    seen = SEEN.setdefault(function, set())
    try:
        values = frame.GetVariables(True, include_locals, False, True)
    except Exception:
        return variables
    for value in values:
        name = value.GetName()
        if not name or name.startswith("__"):
            continue
        declared = _declaration_line(value)
        if (include_locals and declared is not None and declared >= line
                and name not in seen):
            continue
        variables[name] = _format_value(value)
        seen.add(name)
    return variables


def _collect_stack(thread):
    stack = []
    for index in range(thread.GetNumFrames()):
        frame = thread.GetFrameAtIndex(index)
        if _is_user_frame(frame):
            stack.append(_frame_name(frame))
    return stack


def _record(event):
    if len(STATE["events"]) >= CONFIG["max_events"]:
        STATE["truncated"] = True
        return
    STATE["events"].append(event)


def on_stop(frame, bp_loc, internal_dict):
    try:
        thread = frame.GetThread()
        stack = _collect_stack(thread)
        line = frame.GetLineEntry().GetLine()
        name = _frame_name(frame)
        depth = len(stack)

        entered = depth > PREVIOUS["depth"]
        if entered:
            _record({
                "sequence": len(STATE["events"]),
                "type": "call",
                "line": line,
                "function": name,
                "variables": _collect(frame, False, line, name),
                "call_stack": list(reversed(stack)),
            })
        elif depth < PREVIOUS["depth"]:
            for level in range(PREVIOUS["depth"], depth, -1):
                returned = PREVIOUS["stack"][level - 1] if level - 1 < len(PREVIOUS["stack"]) else "?"
                _record({
                    "sequence": len(STATE["events"]),
                    "type": "return",
                    "line": line,
                    "function": returned,
                    "variables": {},
                    "call_stack": list(reversed(PREVIOUS["stack"][:level - 1])),
                })

        # The call event already occupies this exact location.
        if not entered:
            _record({
                "sequence": len(STATE["events"]),
                "type": "line",
                "line": line,
                "function": name,
                "variables": _collect(frame, True, line, name),
                "call_stack": list(reversed(stack)),
            })

        PREVIOUS["depth"] = depth
        PREVIOUS["stack"] = stack
    except Exception:
        pass
    return False


def _write_result():
    with open(CONFIG["out"], "w", encoding="utf-8") as handle:
        json.dump(STATE, handle)


def trace_cmd(debugger, command, exe_ctx, result, internal_dict):
    arguments = shlex.split(command)
    if not arguments:
        result.SetError("codeflow_trace requires a source path")
        return
    source = arguments[0]
    CONFIG["source"] = source
    CONFIG["out"] = arguments[1] if len(arguments) > 1 else "trace.json"
    CONFIG["max_events"] = int(os.environ.get("CODEFLOW_MAX_EVENTS", "500"))

    target = debugger.GetSelectedTarget()
    if not target or not target.IsValid():
        result.SetError("no target")
        return

    try:
        with open(source, "r", encoding="utf-8", errors="replace") as handle:
            total_lines = len(handle.readlines())
    except OSError as error:
        result.SetError("cannot read source: %s" % error)
        return

    # One breakpoint per executable line, but several source lines often map to
    # the same address (a function's opening brace and its first statement).
    # Keeping both would report the same step twice.
    addresses = set()
    for line in range(1, total_lines + 1):
        breakpoint = target.BreakpointCreateByLocation(source, line)
        if breakpoint.GetNumLocations() == 0:
            target.BreakpointDelete(breakpoint.GetID())
            continue
        try:
            address = breakpoint.GetLocationAtIndex(0).GetAddress().GetFileAddress()
        except Exception:
            address = None
        if address is not None:
            if address in addresses:
                target.BreakpointDelete(breakpoint.GetID())
                continue
            addresses.add(address)
        breakpoint.SetScriptCallbackFunction("lldb_tracer.on_stop")

    # Some sandboxes block the personality(ADDR_NO_RANDOMIZE) syscall LLDB uses
    # to disable ASLR for the inferior, which makes "process launch" fail with
    # "personality set failed: Operation not permitted". Turning the setting off
    # skips that syscall entirely; the program just runs with ASLR enabled.
    debugger.HandleCommand("settings set target.disable-aslr false")

    debugger.HandleCommand("process launch")
    _write_result()
    result.AppendMessage("codeflow: %d events" % len(STATE["events"]))


def __lldb_init_module(debugger, internal_dict):
    debugger.HandleCommand("command script add -f lldb_tracer.trace_cmd codeflow_trace")
