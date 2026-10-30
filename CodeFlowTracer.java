// CodeFlow JDI tracer for Java.
//
// Launches the user's class in a debug VM, steps line by line, and records the
// same event shape the Python tracer produces: line, function, in-scope
// variables, and the user-code call stack. Values come from the debugger; if a
// value cannot be read it is simply omitted.

import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public class CodeFlowTracer {

    static final List<String> events = new ArrayList<>();
    static boolean truncated = false;
    static int maxEvents = 500;
    static int prevDepth = 0;
    static List<String> prevStack = new ArrayList<>();

    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            System.err.println("usage: CodeFlowTracer <classpath> <mainClass> <out.json>");
            System.exit(2);
        }
        String classpath = args[0];
        String mainClass = args[1];
        String outPath = args[2];
        String limit = System.getenv("CODEFLOW_MAX_EVENTS");
        if (limit != null && !limit.isBlank()) {
            try { maxEvents = Integer.parseInt(limit.trim()); } catch (NumberFormatException ignored) { }
        }

        VirtualMachineManager manager = Bootstrap.virtualMachineManager();
        LaunchingConnector connector = manager.defaultConnector();
        Map<String, Connector.Argument> arguments = connector.defaultArguments();
        arguments.get("main").setValue(mainClass);
        arguments.get("options").setValue("-cp " + classpath);
        arguments.get("suspend").setValue("true");

        VirtualMachine vm = connector.launch(arguments);

        Process process = vm.process();
        pump(process.getInputStream(), System.out);
        pump(process.getErrorStream(), System.err);
        feedStdin(process, args.length > 3 ? args[3] : null);

        EventRequestManager requests = vm.eventRequestManager();
        EventQueue queue = vm.eventQueue();

        while (true) {
            EventSet set;
            try {
                set = queue.remove();
            } catch (InterruptedException interrupted) {
                break;
            }
            for (Event event : set) {
                if (System.getenv("CODEFLOW_DEBUG") != null) {
                    System.err.println("codeflow: event " + event.getClass().getSimpleName());
                }
                if (event instanceof VMStartEvent) {
                    ClassPrepareRequest prepared = requests.createClassPrepareRequest();
                    prepared.addClassFilter(mainClass);
                    prepared.addClassFilter(mainClass + "*");
                    prepared.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                    prepared.enable();
                } else if (event instanceof ClassPrepareEvent) {
                    armBreakpoints(requests, ((ClassPrepareEvent) event).referenceType());
                } else if (event instanceof BreakpointEvent) {
                    BreakpointEvent hit = (BreakpointEvent) event;
                    record(hit.thread(), hit.location());
                } else if (event instanceof VMDeathEvent || event instanceof VMDisconnectEvent) {
                    write(outPath);
                    return;
                }
            }
            try {
                set.resume();
            } catch (VMDisconnectedException disconnected) {
                write(outPath);
                return;
            }
        }
        write(outPath);
    }

    static void pump(InputStream stream, OutputStream target) {
        Thread thread = new Thread(() -> {
            try (InputStream in = stream) {
                byte[] buffer = new byte[4096];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    target.write(buffer, 0, read);
                    target.flush();
                }
            } catch (IOException ignored) {
            }
        });
        thread.setDaemon(true);
        thread.start();
    }

    static void feedStdin(Process process, String path) {
        if (path == null || path.isEmpty()) {
            return;
        }
        Thread thread = new Thread(() -> {
            try (OutputStream out = process.getOutputStream()) {
                out.write(Files.readAllBytes(Paths.get(path)));
                out.flush();
            } catch (IOException ignored) {
            }
        });
        thread.setDaemon(true);
        thread.start();
    }

    // One breakpoint per executable line of the user's own classes. This never
    // walks into JDK internals, unlike a STEP_INTO request, which would spend
    // thousands of steps inside something like java.util.Scanner.
    static void armBreakpoints(EventRequestManager requests, ReferenceType type) {
        if (!isUserType(type)) {
            return;
        }
        Set<Integer> seen = new HashSet<>();
        for (Method method : type.methods()) {
            List<Location> locations;
            try {
                locations = method.allLineLocations();
            } catch (AbsentInformationException missing) {
                continue;
            }
            for (Location location : locations) {
                // Keep the earliest location per line so a stop means "before
                // this line runs", matching the Python and C/C++ tracers.
                if (!seen.add(location.lineNumber())) {
                    continue;
                }
                BreakpointRequest breakpoint = requests.createBreakpointRequest(location);
                breakpoint.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
                breakpoint.enable();
            }
        }
    }

    static boolean isUserType(ReferenceType type) {
        String name = type.name();
        return !(name.startsWith("java.") || name.startsWith("javax.")
                || name.startsWith("jdk.") || name.startsWith("sun.")
                || name.startsWith("com.sun."));
    }

    // A java.util collection has no readable value of its own — JDI only says
    // "instance of java.util.ArrayList(id=51)". Asking the object for its own
    // toString() is what turns that into "[1, 4, 9, 16]" or "{a=1, b=2}", which
    // the animated stage can draw. Only JDK collections are asked, so no user
    // code is ever run from inside the tracer.
    static String collectionText(ObjectReference reference, ThreadReference thread) {
        try {
            ReferenceType type = reference.referenceType();
            String name = type.name();
            if (!(name.startsWith("java.util.") || name.startsWith("java.util.concurrent."))) {
                return null;
            }
            if (!(type instanceof ClassType)) {
                return null;
            }
            Method method = ((ClassType) type).concreteMethodByName("toString", "()Ljava/lang/String;");
            if (method == null) {
                return null;
            }
            Value result = reference.invokeMethod(thread, method,
                    Collections.<Value>emptyList(), ObjectReference.INVOKE_SINGLE_THREADED);
            if (result instanceof StringReference) {
                String text = ((StringReference) result).value();
                return text.length() > 400 ? text.substring(0, 400) + "…" : text;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    static String format(Value value, ThreadReference thread) {
        if (value == null) {
            return "null";
        }
        if (value instanceof StringReference) {
            return "\"" + ((StringReference) value).value() + "\"";
        }
        if (value instanceof CharValue) {
            return "'" + ((CharValue) value).value() + "'";
        }
        if (value instanceof ArrayReference) {
            ArrayReference array = (ArrayReference) value;
            List<Value> values = array.getValues();
            StringBuilder text = new StringBuilder("[");
            for (int i = 0; i < values.size() && i < 30; i++) {
                if (i > 0) text.append(", ");
                text.append(format(values.get(i), thread));
            }
            if (values.size() > 30) text.append(", ...");
            return text.append("]").toString();
        }
        if (value instanceof ObjectReference) {
            String text = collectionText((ObjectReference) value, thread);
            if (text != null) {
                return text;
            }
        }
        return value.toString();
    }

    static void record(ThreadReference thread, Location location) {
        // Only the learner's own code is recorded.
        if (!isUserType(location.declaringType())) {
            return;
        }
        StackFrame frame;
        try {
            frame = thread.frame(0);
        } catch (IncompatibleThreadStateException error) {
            return;
        }
        int line = location.lineNumber();
        String function = location.method().name();

        List<String> stack = new ArrayList<>();
        int frames;
        try {
            frames = thread.frameCount();
        } catch (IncompatibleThreadStateException error) {
            return;
        }
        for (int index = 0; index < frames; index++) {
            try {
                StackFrame candidate = thread.frame(index);
                if (isUserType(candidate.location().declaringType())) {
                    stack.add(candidate.location().method().name());
                }
            } catch (IncompatibleThreadStateException ignored) {
            }
        }
        int depth = stack.size();

        Map<LocalVariable, Value> raw = rawValues(frame);
        if (depth > prevDepth) {
            emit("call", line, function, formatted(raw, true, thread), outer(stack));
        } else if (depth < prevDepth) {
            for (int level = prevDepth; level > depth; level--) {
                String returned = level - 1 < prevStack.size() ? prevStack.get(level - 1) : "?";
                emit("return", line, returned, new LinkedHashMap<>(),
                        outer(prevStack.subList(0, level - 1)));
            }
        }
        // The call event already covers the function's first line.
        if (depth <= prevDepth) {
            emit("line", line, function, formatted(raw, false, thread), outer(stack));
        }
        prevDepth = depth;
        prevStack = stack;
    }

    // Events carry the call stack outermost-first so every language agrees.
    static List<String> outer(List<String> stack) {
        List<String> ordered = new ArrayList<>(stack);
        Collections.reverse(ordered);
        return ordered;
    }

    // The values are read once, before anything is formatted: asking a
    // collection for its toString() resumes the thread for a moment, and the
    // frame cannot be read again afterwards ("Thread has been resumed").
    static Map<LocalVariable, Value> rawValues(StackFrame frame) {
        try {
            List<LocalVariable> visible = frame.visibleVariables();
            return frame.getValues(visible);
        } catch (AbsentInformationException | RuntimeException error) {
            return new LinkedHashMap<>();
        }
    }

    static Map<String, String> formatted(Map<LocalVariable, Value> raw, boolean onlyArguments,
                                         ThreadReference thread) {
        Map<String, String> values = new LinkedHashMap<>();
        for (Map.Entry<LocalVariable, Value> entry : raw.entrySet()) {
            LocalVariable variable = entry.getKey();
            if (onlyArguments && !variable.isArgument()) {
                continue;
            }
            try {
                values.put(variable.name(), format(entry.getValue(), thread));
            } catch (RuntimeException ignored) {
                // A value that cannot be read is simply left out.
            }
        }
        return values;
    }

    static void emit(String type, int line, String function, Map<String, String> variables, List<String> stack) {
        if (events.size() >= maxEvents) {
            truncated = true;
            return;
        }
        StringBuilder json = new StringBuilder();
        json.append("{\"sequence\":").append(events.size());
        json.append(",\"type\":\"").append(escape(type)).append('"');
        json.append(",\"line\":").append(line);
        json.append(",\"function\":\"").append(escape(function)).append('"');
        json.append(",\"variables\":{");
        boolean first = true;
        for (Map.Entry<String, String> entry : variables.entrySet()) {
            if (function.equals("main") && entry.getKey().equals("args")) {
                continue;
            }
            if (!first) json.append(',');
            first = false;
            json.append('"').append(escape(entry.getKey())).append("\":\"")
                .append(escape(entry.getValue())).append('"');
        }
        json.append("},\"call_stack\":[");
        for (int i = 0; i < stack.size(); i++) {
            if (i > 0) json.append(',');
            json.append('"').append(escape(stack.get(i))).append('"');
        }
        json.append("]}");
        events.add(json.toString());
    }

    static String escape(String text) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.toString();
    }

    static void write(String outPath) {
        String payload = "{\"events\":[" + String.join(",", events)
                + "],\"truncated\":" + truncated + "}";
        try {
            Files.writeString(Paths.get(outPath), payload, StandardCharsets.UTF_8);
        } catch (IOException error) {
            System.err.println("codeflow: cannot write trace: " + error.getMessage());
        }
    }
}
