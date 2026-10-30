# CodeFlow — current state audit & build roadmap

**Audited:** 18 Oct 2026
**How:** read every file, ran the full test suite, started the backend, traced 6 real programs through the API, and drove the live UI in a headless browser at 1440px and 390px.

| Check | Result |
|---|---|
| `node --check app.js` | pass |
| `node smoke-test.js` | 11/11 pass |
| `python -m unittest discover -s tests` | 10/10 pass |
| Server boots without FastAPI (stdlib fallback) | pass |
| Python trace quality (recursion, loops, errors) | good |
| JavaScript trace | **none — 0 events** (fixed, see §6) |
| Mobile 390px horizontal overflow | none |

---

## 1. What is actually built and working

### Backend (`backend.py`, ~1000 lines, zero project imports)

- **Isolated Python execution** — child process, `-I -S` flags, temp cwd, hard 2.0s timeout, kill on overrun.
- **Real trace data** — `sys.settrace` recording `call` / `line` / `return` / `exception`, each with a **full variable snapshot** and a **call-stack snapshot**. This is the actual asset of the project; most teaching tools fake this.
- **Bounds on everything** — 64 KiB source, 16 KiB output, 500 events, 100 variables, 50 stack frames, 256 KiB result file. Pipes drained on threads so a runaway `print` can't balloon memory.
- **Diagnostics with locations** — `SyntaxError` gives line + column + end position; runtime errors give the user-frame line only (correctly skips internal frames).
- **`/api/verify`** — `ast.parse` only, never executes. Verified: `raise RuntimeError()` returns `valid: true`.
- **JavaScript via Node `vm`** — context sandbox, 2s timeout, `console.*` captured, variables scraped off the sandbox.
- **AI proxy** — OpenAI-compatible, validates a **structured JSON** reply (`answer` + optional `proposed_code`), rejects plain-text answers, and returns an honest `not-configured` when no key exists.
- **Dual server** — FastAPI when installed, otherwise a threaded stdlib `HTTPServer` with identical handlers. Fallback path confirmed working.
- **Path traversal guard** on static file serving (`_safe_static_path` resolves and checks `relative_to(BASE_DIR)`).

### Frontend (`app.js` 817 lines, `index.html`, `styles.css`, `responsive.css`)

- Editor with line numbers, **active-line highlight**, cursor `Ln/Col` readout, find & replace, import, export.
- **Run / Explain / Check** wired to the three endpoints.
- **Timeline** — flow map of every event, prev / next / play / reset, progress bar, step counter.
- **Selected-step panel** — source line, plain-English explanation, changed variables (`before → after`), full variables, call stack, per-event output.
- Console + diagnostics, and **diagnostics are clickable to jump to the offending line**.
- Web Audio **step tones** by event type (call / return / stdout / exception), unlocked on first click.
- AI chat with honest provider badges (`Remote AI` / `Local fallback` / `Not configured`).
- Responsive — verified **no horizontal overflow at 390px**, burger nav engages at 900px.

**Verdict:** the Python path is genuinely good. Trace fidelity is the hard part and it's done.

---

## 2. What is broken (all reproduced, not guessed)

### P0 — the product is dead here

**1. JavaScript produces no trace at all.**
`execute_javascript` returns `events: []`, `variables: {}`, `call_stack: []` — always. Confirmed with `let total = 0; for (...) {...}`: console prints `6`, timeline shows `0 / 0`, variables panel shows "run code first", explanation reads "Unknown behavior". The language selector is a lie for half its options. Root cause: `JS_RUNNER` only captures `console`, never instruments execution.

**2. `return` events carry no return value.**
`trace()` receives `arg` on return and discards it. So every return step in the UI says *"Returned from function X. The returned value is unknown because the event did not include it."* — for a teaching tool, the single most interesting value is missing.

**3. `input()` crashes every beginner program.**
`stdin=subprocess.DEVNULL` → `EOFError: EOF when reading a line`. Verified. Any first-year assignment with `input()` dies on line 1.

**4. Trace truncation is silent.**
A 100k-iteration loop returns `events_truncated: true` and exactly 500 events. `app.js` **never reads `result.limits`** — grep confirms zero references. The timeline just stops mid-loop with no warning, which contradicts this codebase's otherwise obsessive honesty.

### P1 — the UI says things that aren't true

**5. First step reads "Step 1 · line 0" and "Entered function `<module>` on line 0."**
The module-level `call` event reports `f_lineno == 0`. Invalid line number, internal jargon, and it's the very first thing a user sees.

**6. "Executed the source line" is false.**
Python's `line` trace event fires *before* the line runs, so the variables shown for line 2 are the state *before* line 2 executed. The UI claims the line already ran. Should read "about to execute".

**7. Restore is a lie.**
`state.snapshot` is assigned once at startup (line 805) and never again. **Restore always reverts to the code present at page load**, while the toast says "Last saved version restored."

**8. Undo removes one character.**
`state.history.push()` runs on every `input` event, so the 20-slot history fills with per-keystroke states. Undo is a backspace.

**9. Timeline doesn't follow the playhead.**
21-step recursion trace: `scrollWidth 1595` vs `clientWidth 482`. Last step sits at x=1635 — far off-screen. During playback the highlighted step walks out of view and the animation appears to stop. Needs auto-scroll-to-active.

### P2 — polish that undercuts the premise

**10. No syntax highlighting.** The editor is a plain `<textarea>` (single colour `#d9def0`). The hero preview has coloured spans — a static mock that flatters a feature the app doesn't have.
**11. Hero stat "12 steps execution mapped" is hardcoded**, unrelated to any run.
**12. `#sound-status` is `display: none` at every width** (styles.css) — the ARIA live region it's wired to is invisible.
**13. Theme toggle doesn't persist** and ignores `prefers-color-scheme`.
**14. Variables leak memory addresses** — `"<function greet at 0x104e55260>"` is shown to learners.
**15. No keyboard shortcut to run** (Cmd/Ctrl+Enter is table stakes in an editor).

---

## 3. What's missing entirely

| Capability | Status | Why it matters |
|---|---|---|
| Breakpoints, step over / into / out | absent | Linear replay only. A debugger you can't set a breakpoint in isn't one. |
| Program input panel | absent | Blocks `input()`, i.e. most beginner exercises. |
| Shareable trace / saved sessions | absent | Nothing survives the tab. Only code sits in `localStorage`. |
| Syntax highlighting / real editor | absent | A code-learning tool that renders code flat looks amateur next to its own hero image. |
| C++ support | absent | Your hackathon project (CodeLens) is specified as C++. This is Python-only. |
| Frontend tests | absent | `smoke-test.js` only greps strings; it can't catch any bug in section 2. |
| CI | absent | Nothing runs the 10 passing tests automatically. |

---

## 4. Suggested build order

**Tier 1 — stop the lies (small, high trust).** Return values into trace events; drop the line-0 module event; fix "executed" → "about to execute"; fix Restore/Undo; surface `events_truncated`; auto-scroll the timeline; strip `0x...` from variable display; Cmd+Enter to run. *All local, all testable.*

**Tier 2 — make JavaScript real.** Instrument via `vm` with a per-line hook (`node --inspect` + CDP, or transpile a `__trace(line)` call per statement). Until then, disable the JS option rather than showing a dead panel.

**Tier 3 — make it a debugger.** Breakpoints (click the gutter), continue-to-next-breakpoint, a stdin panel, and a "time travel" scrubber (free — you already snapshot every event).

**Tier 4 — make it a product.** Shareable trace URLs, syntax highlighting, then decide on C++ (needs gdb/lldb scripting; it's the expensive one).

---

## 5. The one strategic question

The backend is honest and well-bounded — it reads like it was written by someone who cares about not lying to learners. The frontend markets a debugger the backend half-delivers. **Tier 1 + Tier 2 close that gap for a fraction of the effort of any new feature**, and they're what a judge or a first-time user would hit in the first 30 seconds.

---

## 6. Update — what was fixed after this audit

Kept here so the audit above is not mistaken for the current state.

**Tier 1 (all done)**
- `return` events now carry `return_value`; exceptions unwinding are marked `unwound` instead of claiming a value.
- The `line: 0` module event is gone — the first step is now a real source line.
- "Executed the source line" → "Stopped at the line", because Python's line event fires *before* the line runs and Java breakpoints can land mid-line. The claim now matches all three tracers.
- Restore now returns the last committed edit, not the page-load snapshot; undo steps through edits instead of single keystrokes.
- Trace truncation is surfaced in the timeline panel (`events_truncated`, `stdout_truncated`).
- The timeline auto-centres the active step, so playback no longer walks off-screen.
- Heap addresses (`<function f at 0x…>`) are stripped from variable values.
- Cmd/Ctrl+Enter runs the program.
- `input()` works: stdin is passed to Python, C, C++ and Java, with a **Program input** panel in the UI.

**Tier 2 (partly done)**
- C, C++ and Java now have real line-by-line tracing with variables and call stacks:
  - C/C++ compile with `clang -g -O0` and step under **LLDB** (one breakpoint per line, deduped by address, variables filtered by declaration line so uninitialised stack garbage never appears).
  - Java uses **JDI** breakpoints armed from each class's line table (`CodeFlowTracer.java`), which avoids the thousands of useless steps a `STEP_INTO` request spends inside `java.util`.
- **JavaScript now has a real trace** (`js_tracer.js`). The program runs in a Node child process with an inspector session attached to it; breakpoints are armed from inside `Debugger.scriptParsed` (which fires synchronously before the first statement) so every executable line is covered exactly once, with variables and an outermost-first call stack.
  - Two things this cost, worth remembering: CDP call frames carry an **empty `url`** for scripts compiled through `vm`, so frames must be matched by `location.scriptId` — a URL test silently discards every pause and the trace comes back empty with a "completed" status. And `scriptParsed` fires **lazily at run time**, not at compile time, so `getPossibleBreakpoints` cannot be used before the program starts.

**New since the audit**
- **Voice lesson** overlay: narrated step-through using the browser's speech synthesis, with animated line highlight, variable chips that flash when they change, and an animated call stack. Every sentence is derived from trace data; missing values are described as missing, never invented. Degrades to timed captions without speech.
- **Share links** (`#lang=…&code=…`) restore the exact program.
- **Language now persists** alongside the code — previously a reload sent C++ source to the Python interpreter.
- **Static responses carry `Cache-Control: no-store`.** A cached `index.html` is exactly how the language menu ends up showing one option after an update while the file on disk (and the server response) contain all five.
- **Export uses the selected language's extension** instead of always naming Java/C/C++ files `.js`.
- **Syntax highlighting in the main editor** for all five languages, in both themes. A `<pre>` sits behind a transparent textarea sharing the lesson's tokenizer; the textarea keeps the caret, selection and native undo. This exposed two layout bugs, both fixed: the gutter ran on `12px` against the editor's `13px`, so numbers drifted 64px from their lines by line 40; and the gutter column inflated the grid row, so a long file grew the textarea past its panel instead of scrolling.
- **Step explanation wording** — "Stopped at the line on line 6" → "Stopped on line 6".
- **The language control is no longer a dropdown.** A `<select>` only ever shows the current choice, so it read as "only Python is available" no matter what the markup contained. All five languages are now always-visible tabs.
- **Choosing a language now changes something.** It loads that language's starter program (only when the editor still holds an untouched starter — typed code is never replaced) and clears the previous trace, which used to sit on screen as C++ steps beside Python source.
- **`/?anything` no longer 404s.** The root check compared the path with its query string attached, so a cache-busting URL missed the index route. Assets are now requested with a `?v=` stamp as well.

**Still missing** (unchanged from section 3)
- Breakpoints / step over / step into — the replay model has no pause, so this needs a new execution mode, not a UI toggle.
- Syntax highlighting in the **main editor** (the lesson view has it; the editor is still a plain textarea).
- CI, and real frontend tests (smoke test is still string matching, now 21 checks).

