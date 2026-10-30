import os
import json
import unittest
from unittest.mock import patch

import backend


class CodeFlowApiTests(unittest.TestCase):
    def test_health_reports_backend_and_limits(self):
        health = backend.health_payload()
        self.assertEqual(health["status"], "ok")
        self.assertIn("source_bytes", health["limits"])
        self.assertIn("node_available", health)

    def test_python_execution_captures_output_variables_and_trace(self):
        result, status = backend.execute_payload({
            "language": "python",
            "code": "value = 2 + 3\nprint(value)",
        })
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "completed")
        self.assertIn("5", result["output"])
        self.assertEqual(result["variables"]["value"], 5)
        self.assertTrue(result["events"])
        self.assertTrue(all("type" in event and "line" in event for event in result["events"]))

    def test_python_syntax_diagnostic_has_location(self):
        result, status = backend.execute_payload({"language": "python", "code": "if True print('x')"})
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["diagnostics"][0]["kind"], "syntax")
        self.assertIsNotNone(result["diagnostics"][0].get("line"))
        self.assertIsNotNone(result["diagnostics"][0].get("column"))

    def test_python_timeout_is_bounded(self):
        result, status = backend.execute_payload({"language": "python", "code": "while True:\n    pass"})
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "timeout")
        self.assertEqual(result["diagnostics"][0]["kind"], "timeout")

    def test_source_output_and_event_limits_are_reported(self):
        oversized, status = backend.execute_payload({"language": "python", "code": "x" * (backend.MAX_SOURCE_BYTES + 1)})
        self.assertEqual(status, 400)
        self.assertIn("limit", oversized["error"])
        result, status = backend.execute_payload({
            "language": "python",
            "code": 'print("x" * 20000)\n' + "\n".join(["value = 1"] * 600),
        })
        self.assertEqual(status, 200)
        self.assertLessEqual(len(result["stdout"].encode("utf-8")), backend.MAX_OUTPUT_BYTES)
        self.assertTrue(result["limits"]["stdout_truncated"])
        self.assertTrue(result["limits"]["events_truncated"])

    def test_verify_does_not_execute_python(self):
        result, status = backend.verify_payload({"language": "python", "code": "raise RuntimeError('no run')"})
        self.assertEqual(status, 200)
        self.assertTrue(result["valid"])

    def test_javascript_execution_traces_lines_and_variables(self):
        code = (
            "function add(x, y) {\n"
            "  const sum = x + y;\n"
            "  return sum;\n"
            "}\n"
            "let total = add(4, 7);\n"
            "console.log(total);\n"
        )
        result, status = backend.execute_payload({"language": "javascript", "code": code})
        self.assertEqual(status, 200)
        if not backend._node_command():
            self.assertEqual(result["status"], "unsupported")
            self.assertFalse(result["supported"])
            return
        self.assertEqual(result["status"], "completed", result.get("diagnostics"))
        self.assertIn("11", result["output"])

        events = result["events"]
        self.assertGreaterEqual(len(events), 5)
        self.assertTrue(all(isinstance(event["line"], int) and event["line"] > 0 for event in events))
        self.assertIn("add", {event["function"] for event in events})

        calls = [event for event in events if event["type"] == "call"]
        self.assertTrue(calls)
        self.assertEqual(calls[0]["variables"].get("x"), 4)
        self.assertEqual(calls[0]["variables"].get("y"), 7)
        # Call stacks are outermost-first, the same as every other language.
        self.assertEqual(calls[0]["call_stack"][0], "<module>")
        # Symbol-keyed globals must never reach the variable panel.
        names = {name for event in events for name in event["variables"]}
        self.assertFalse([name for name in names if name.startswith("Symbol(")], names)

    def test_javascript_runtime_error_reports_a_line(self):
        result, status = backend.execute_payload({
            "language": "javascript",
            "code": "let items = [1, 2];\nconsole.log(items[5].x);\n",
        })
        self.assertEqual(status, 200)
        if not backend._node_command():
            self.skipTest("node is not available")
        self.assertEqual(result["status"], "error")
        diagnostic = result["diagnostics"][0]
        self.assertEqual(diagnostic["title"], "TypeError")
        self.assertEqual(diagnostic["line"], 2)

    def test_javascript_stdin_and_require_are_available(self):
        code = (
            "const fs = require('fs');\n"
            "const data = fs.readFileSync(0, 'utf8');\n"
            "console.log('got', data.trim());\n"
        )
        result, status = backend.execute_payload({
            "language": "javascript", "code": code, "stdin": "hello stdin\n",
        })
        self.assertEqual(status, 200)
        if not backend._node_command():
            self.skipTest("node is not available")
        self.assertEqual(result["status"], "completed", result.get("diagnostics"))
        self.assertIn("got hello stdin", result["stdout"])
        self.assertEqual(len(result["events"]), 3)

    def test_javascript_async_callbacks_are_traced(self):
        code = (
            "let n = 1;\n"
            "setTimeout(() => {\n"
            "  n = n + 41;\n"
            "  console.log('later', n);\n"
            "}, 20);\n"
            "console.log('now', n);\n"
        )
        result, status = backend.execute_payload({"language": "javascript", "code": code})
        self.assertEqual(status, 200)
        if not backend._node_command():
            self.skipTest("node is not available")
        self.assertEqual(result["status"], "completed", result.get("diagnostics"))
        # The trace is written when the event loop drains, so the timer body
        # is included rather than truncated at the last synchronous line.
        self.assertIn("later 42", result["stdout"])
        self.assertIn(4, [event["line"] for event in result["events"]])

    def test_ai_is_honest_without_credentials(self):
        old_key = os.environ.pop("CODEFLOW_AI_API_KEY", None)
        try:
            result, status = backend.ai_payload({"mode": "chat", "prompt": "Explain", "language": "python", "code": "x = 1"})
        finally:
            if old_key is not None:
                os.environ["CODEFLOW_AI_API_KEY"] = old_key
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "not-configured")
        self.assertFalse(result["configured"])
        self.assertIsNone(result["answer"])
        self.assertEqual(result["provider_status"], "not-configured")

    def test_ai_sends_context_and_validates_structured_provider_response(self):
        class MockResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

            def read(self, _limit):
                return json.dumps({
                    "choices": [{
                        "message": {
                            "content": json.dumps({
                                "answer": "The selected line assigns the value.",
                                "proposed_code": {
                                    "language": "python",
                                    "code": "value = 2\nprint(value)",
                                    "explanation": "Keep the trace observable.",
                                },
                            }),
                        },
                    }],
                }).encode("utf-8")

        payload = {
            "mode": "chat",
            "prompt": "Explain the selected event",
            "language": "python",
            "code": "value = 1\nprint(value)",
            "diagnostics": [{"kind": "runtime", "title": "Example", "line": 1}],
            "selected_event": {"sequence": 0, "type": "line", "line": 1, "variables": {"value": 1}},
        }
        with patch.dict(os.environ, {
            "CODEFLOW_AI_API_KEY": "test-key",
            "CODEFLOW_AI_BASE_URL": "https://provider.example/v1",
            "CODEFLOW_AI_MODEL": "test-model",
        }, clear=False), patch("backend.urlopen", return_value=MockResponse()) as open_url:
            result, status = backend.ai_payload(payload)

        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["provider_status"], "remote")
        self.assertEqual(result["answer"], "The selected line assigns the value.")
        self.assertEqual(result["proposed_code"]["code"], "value = 2\nprint(value)")
        request = open_url.call_args.args[0]
        request_body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(request.full_url, "https://provider.example/v1/chat/completions")
        self.assertEqual(request_body["model"], "test-model")
        self.assertIn("selected_event", request_body["messages"][1]["content"])
        self.assertIn("Example", request_body["messages"][1]["content"])

    def test_ai_rejects_unstructured_provider_response(self):
        class MockResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

            def read(self, _limit):
                return b'{"choices":[{"message":{"content":"plain text"}}]}'

        with patch.dict(os.environ, {
            "CODEFLOW_AI_API_KEY": "test-key",
            "CODEFLOW_AI_BASE_URL": "https://provider.example/v1",
            "CODEFLOW_AI_MODEL": "test-model",
        }, clear=False), patch("backend.urlopen", return_value=MockResponse()):
            result, status = backend.ai_payload({"prompt": "Explain", "language": "python", "code": "x = 1"})

        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["provider_status"], "error")
        self.assertIsNone(result["answer"])


    def test_return_events_carry_the_return_value(self):
        result, _ = backend.execute_payload({
            "language": "python",
            "code": "def double(n):\n    return n * 2\n\nprint(double(21))",
        })
        returns = [event for event in result["events"] if event["type"] == "return" and event.get("function") == "double"]
        self.assertTrue(returns)
        self.assertEqual(returns[0]["return_value"], 42)

    def test_no_event_reports_line_zero(self):
        result, _ = backend.execute_payload({"language": "python", "code": "x = 1\nprint(x)"})
        self.assertTrue(result["events"])
        self.assertTrue(all(event["line"] > 0 for event in result["events"]))

    def test_variable_values_do_not_leak_heap_addresses(self):
        result, _ = backend.execute_payload({"language": "python", "code": "def f():\n    return 1\n\ny = f()"})
        self.assertNotIn("0x", json.dumps(result["variables"]))

    def test_stdin_is_delivered_to_input(self):
        result, status = backend.execute_payload({
            "language": "python",
            "code": "name = input()\nprint('hi ' + name)",
            "stdin": "Ada\n",
        })
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "completed")
        self.assertIn("hi Ada", " ".join(result["output"]))

    def test_language_aliases_are_accepted(self):
        self.assertEqual(backend._normalize_language("c++"), "cpp")
        self.assertEqual(backend._normalize_language("JS"), "javascript")
        self.assertIsNone(backend._normalize_language("cobol"))

    def test_c_execution_traces_lines(self):
        if not backend._first_available(backend.NATIVE_COMPILERS["c"]):
            self.skipTest("no C compiler")
        result, status = backend.execute_payload({
            "language": "c",
            "code": "#include <stdio.h>\nint main() {\n    int total = 0;\n    for (int i = 1; i <= 3; i++) {\n        total = total + i;\n    }\n    printf(\"%d\\n\", total);\n    return 0;\n}",
        })
        self.assertEqual(status, 200)
        if result["status"] == "unsupported":
            self.skipTest("LLDB unavailable")
        self.assertEqual(result["status"], "completed")
        self.assertIn("6", result["output"])
        self.assertTrue(result["events"])
        self.assertTrue(all(event["line"] > 0 for event in result["events"]))

    def test_cpp_execution_traces_a_function_call(self):
        if not backend._first_available(backend.NATIVE_COMPILERS["cpp"]):
            self.skipTest("no C++ compiler")
        result, _ = backend.execute_payload({
            "language": "cpp",
            "code": "#include <iostream>\nusing namespace std;\nint add(int x, int y) {\n    return x + y;\n}\nint main() {\n    cout << add(2, 3) << endl;\n    return 0;\n}",
        })
        if result["status"] == "unsupported":
            self.skipTest("LLDB unavailable")
        self.assertEqual(result["status"], "completed")
        self.assertIn("5", " ".join(result["output"]))
        functions = {event.get("function") for event in result["events"]}
        self.assertIn("add", functions)

    def test_java_execution_traces_lines(self):
        if not (backend.shutil.which("javac") and backend.shutil.which("java")):
            self.skipTest("no JDK")
        result, _ = backend.execute_payload({
            "language": "java",
            "code": "public class Main {\n    public static void main(String[] args) {\n        int total = 0;\n        for (int i = 1; i <= 3; i++) {\n            total = total + i;\n        }\n        System.out.println(total);\n    }\n}",
        })
        if result["status"] == "unsupported":
            self.skipTest("JDK tracer unavailable")
        self.assertEqual(result["status"], "completed")
        self.assertIn("6", " ".join(result["output"]))
        self.assertTrue(result["events"])

    def test_compile_error_reports_a_line(self):
        result, status = backend.execute_payload({"language": "c", "code": "int main() { return notdefined; }"})
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["diagnostics"][0]["kind"], "syntax")
        self.assertIsNotNone(result["diagnostics"][0].get("line"))


if __name__ == "__main__":
    unittest.main()
