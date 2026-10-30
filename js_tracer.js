// CodeFlow tracer for JavaScript.
//
// The user's program runs in this process while an inspector session attached
// to the same process holds a breakpoint on every executable line of it. Each
// pause yields the line, the function, the in-scope variables and the call
// stack — the same event shape the Python, C/C++ and Java tracers produce.
//
// Frames are matched by `location.scriptId`, not by URL: CDP call frames carry
// an empty `url` for scripts compiled through `vm`, so a URL test silently
// discards every pause. The script id comes from `Debugger.scriptParsed`.
//
// Only the user's script is instrumented, so library frames are never stepped
// through and never recorded.

'use strict';

const fs = require('fs');
const vm = require('vm');
const inspector = require('inspector');

const sourcePath = process.argv[2];
const outPath = process.argv[3];
const MAX_EVENTS = parseInt(process.env.CODEFLOW_MAX_EVENTS || '500', 10);
const MAX_VALUE = 200;
const MAX_ELEMENTS = 40;
const OUTPUT_LIMIT = 16384;
const SCRIPT_URL = 'codeflow_user.js';
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

if (!sourcePath || !outPath) {
  process.stderr.write('usage: js_tracer.js <source.js> <trace.json>\n');
  process.exit(2);
}

const source = fs.readFileSync(sourcePath, 'utf8');
const lineCount = Math.max(1, source.split('\n').length);

// Globals that existed before the program ran. Anything on the global object
// that is not in here was declared by the user (a top-level `var` or
// `function`), which is how those declarations reach the variable panel.
const preExisting = new Set(Object.getOwnPropertyNames(globalThis));

// Single-file programs still expect `require` (for `fs`, `readline`, ...).
// `runInThisContext` runs with no module scope, so it has to be published on
// the global object. It is added to `preExisting` so it never shows up as one
// of the program's own variables.
globalThis.require = require;
preExisting.add('require');

const events = [];
let truncated = false;
let previousDepth = 0;
let previousStack = [];
let written = false;
let failure = null;
let stopped = false;
let userScriptId = null;
let exceptionRecorded = false;

const stdoutParts = [];
const stderrParts = [];
let outputSize = 0;

function truncate(value) {
  const text = typeof value === 'string' ? value : String(value);
  return text.length > MAX_VALUE ? text.slice(0, MAX_VALUE) + '…' : text;
}

function formatArg(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'undefined') return 'undefined';
  if (value instanceof Error) return value.stack || String(value);
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch (_) { /* circular structure */ }
  try {
    return String(value);
  } catch (_) {
    return '<value>';
  }
}

function capture(target, args) {
  if (outputSize >= OUTPUT_LIMIT) return;
  const text = args.map(formatArg).join(' ');
  const room = OUTPUT_LIMIT - outputSize;
  const chunk = text.length > room ? text.slice(0, room) : text;
  target.push(chunk);
  outputSize += chunk.length;
}

['log', 'info', 'debug', 'dir', 'table'].forEach((name) => {
  console[name] = (...args) => capture(stdoutParts, args);
});
['warn', 'error', 'trace'].forEach((name) => {
  console[name] = (...args) => capture(stderrParts, args);
});

function writeResult() {
  if (written) return;
  written = true;
  const payload = {
    events,
    truncated,
    stdout: stdoutParts.join('\n'),
    stderr: stderrParts.join('\n'),
    error: failure,
  };
  try {
    fs.writeFileSync(outPath, JSON.stringify(payload), 'utf8');
  } catch (_) { /* nothing useful to do here */ }
}

// Covers programs that call process.exit() before unwinding normally.
process.on('exit', writeResult);

const session = new inspector.Session();
session.connect();

function primitiveOf(remote) {
  if (!remote) return null;
  if (remote.type === 'undefined') return null;
  if (remote.type === 'string') return truncate(remote.value);
  if (remote.type === 'number' || remote.type === 'boolean' || remote.type === 'bigint') {
    return remote.unserializableValue || remote.value;
  }
  if (remote.type === 'object') {
    return remote.subtype === 'null' ? null : truncate(remote.description || '<object>');
  }
  return truncate(remote.description || String(remote.value));
}

// An array's elements are not part of its RemoteObject — that only carries the
// description "Array(4)". Reading them takes a second call on the same paused
// thread; the inspector dispatches it synchronously, so the value is in place
// before the program resumes. Without this, JavaScript programs had no list for
// the animated stage to draw and fell back to showing scalars only.
function readArray(value, into, name) {
  const objectId = value.objectId;
  if (!objectId) {
    into[name] = [];
    return;
  }
  session.post('Runtime.getProperties', { objectId, ownProperties: true }, (error, result) => {
    if (error || !result) {
      into[name] = [];
      return;
    }
    const items = [];
    for (const property of result.result || []) {
      if (!/^(0|[1-9]\d*)$/.test(property.name)) continue;
      if (!property.value) continue;
      items.push({ at: Number(property.name), value: primitiveOf(property.value) });
      if (items.length >= MAX_ELEMENTS) break;
    }
    items.sort((a, b) => a.at - b.at);
    into[name] = items.map((item) => item.value);
  });
}

// A plain object is the JavaScript spelling of a dict. Its keys and values are
// not in the RemoteObject either, so they are read the same way array elements
// are — otherwise a counting program showed the word "Object" and nothing else.
function readObject(value, into, name) {
  const objectId = value.objectId;
  if (!objectId) {
    into[name] = {};
    return;
  }
  session.post('Runtime.getProperties', { objectId, ownProperties: true }, (error, result) => {
    if (error || !result) {
      into[name] = {};
      return;
    }
    const out = {};
    let count = 0;
    for (const property of result.result || []) {
      if (!IDENTIFIER.test(property.name)) continue;
      if (!property.value) continue;
      out[property.name] = primitiveOf(property.value);
      count += 1;
      if (count >= 20) break;
    }
    into[name] = out;
  });
}

// A Map is a dict with a different spelling. Its entries live behind an
// internal slot, so they are pulled out by asking the paused object itself —
// without this a counting program using a Map showed "Map(3)" and nothing more.
function readMap(value, into, name) {
  const objectId = value.objectId;
  if (!objectId) {
    into[name] = {};
    return;
  }
  session.post('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function(){ try { return JSON.stringify(Object.fromEntries(this)); } catch (e) { return "{}"; } }',
    returnByValue: true,
  }, (error, result) => {
    const raw = !error && result && result.result ? result.result.value : null;
    if (typeof raw !== 'string') {
      into[name] = {};
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      into[name] = (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_) {
      into[name] = {};
    }
  });
}

function addProperty(into, property, allow) {
  const name = property.name;
  if (!name || name.startsWith('__')) return;
  // Symbol-keyed globals (Symbol.toStringTag and friends) arrive as
  // "Symbol(description)"; only real identifiers belong in the panel.
  if (!IDENTIFIER.test(name)) return;
  if (name === 'this' || name === 'arguments') return;
  if (allow && !allow(name)) return;
  const value = property.value;
  if (!value) return;
  if (value.type === 'undefined') return;
  if (value.type === 'function') {
    into[name] = '<function ' + name + '>';
    return;
  }
  if (value.type === 'string') {
    into[name] = truncate(value.value);
    return;
  }
  if (value.type === 'number' || value.type === 'boolean' || value.type === 'bigint') {
    into[name] = value.unserializableValue || value.value;
    return;
  }
  if (value.type === 'symbol') {
    into[name] = value.description || 'Symbol()';
    return;
  }
  if (value.type === 'object') {
    if (value.subtype === 'array') {
      readArray(value, into, name);
      return;
    }
    if (value.subtype === 'map') {
      readMap(value, into, name);
      return;
    }
    if (value.subtype === 'object' || value.description === 'Object') {
      readObject(value, into, name);
      return;
    }
    into[name] = value.subtype === 'null' ? null : truncate(value.description || '<object>');
    return;
  }
  into[name] = truncate(value.description || String(value.value));
}

function readScope(scope, into, allow) {
  const objectId = scope && scope.object && scope.object.objectId;
  if (!objectId) return;
  // Inspector callbacks are dispatched synchronously while the thread is
  // paused, so this returns before the caller resumes the program.
  session.post('Runtime.getProperties', { objectId, ownProperties: true }, (error, result) => {
    if (error || !result) return;
    for (const property of result.result || []) addProperty(into, property, allow);
  });
}

function readVariables(frame) {
  const variables = {};
  const chain = frame.scopeChain || [];
  const scoped = chain.filter((entry) => (
    entry.type === 'local' || entry.type === 'closure'
    || entry.type === 'block' || entry.type === 'catch'
  ));
  // The script scope is read even when a block scope exists: inside a loop the
  // chain only offers `i`/`j`, and dropping the script scope there hid the very
  // array the loop is sorting. Locals are read afterwards so they win on a
  // name clash, exactly like the language does.
  const scriptScope = chain.find((entry) => entry.type === 'script');
  if (scriptScope) readScope(scriptScope, variables, null);
  for (const entry of scoped) readScope(entry, variables, null);
  const globalScope = chain.find((entry) => entry.type === 'global');
  if (globalScope) readScope(globalScope, variables, (name) => !preExisting.has(name));
  return variables;
}

function push(event) {
  if (events.length >= MAX_EVENTS) {
    truncated = true;
    return;
  }
  events.push(event);
}

function nameOf(frame, index, total) {
  if (frame.functionName) return frame.functionName;
  return index === total - 1 ? '<module>' : '<anonymous>';
}

session.on('Debugger.scriptParsed', (message) => {
  const params = message.params || {};
  if (params.url === SCRIPT_URL || params.url.endsWith('/' + SCRIPT_URL)) {
    userScriptId = params.scriptId;
    armBreakpoints(params.scriptId, () => {});
  }
});

session.on('Debugger.paused', (message) => {
  const params = message.params || {};
  const all = params.callFrames || [];
  const frames = userScriptId
    ? all.filter((frame) => frame.location && frame.location.scriptId === userScriptId)
    : [];

  // A pause outside the user's program (inspector internals, timer callbacks)
  // is never interesting.
  if (stopped || !frames.length) {
    session.post('Debugger.resume');
    return;
  }

  const top = frames[0];
  const line = (top.location ? top.location.lineNumber : 0) + 1;
  const depth = frames.length;
  const name = nameOf(top, 0, depth);
  const stack = frames.map((frame, index) => nameOf(frame, index, depth)).reverse();

  if (params.reason === 'exception' || params.reason === 'promiseRejection') {
    const data = params.data || {};
    exceptionRecorded = true;
    push({
      sequence: events.length,
      type: 'exception',
      line,
      function: name,
      variables: {},
      call_stack: stack,
      exception: truncate(data.description || data.value || 'Uncaught exception'),
    });
    previousDepth = depth;
    previousStack = stack;
    session.post('Debugger.resume');
    return;
  }

  const variables = readVariables(top);

  if (depth > previousDepth && depth > 1) {
    push({
      sequence: events.length,
      type: 'call',
      line,
      function: name,
      variables,
      call_stack: stack,
    });
  } else if (depth < previousDepth) {
    for (let level = previousDepth; level > depth; level -= 1) {
      push({
        sequence: events.length,
        type: 'return',
        line,
        function: previousStack[level - 1] || '<anonymous>',
        variables: {},
        call_stack: previousStack.slice(0, level - 1),
      });
    }
  }

  push({
    sequence: events.length,
    type: 'line',
    line,
    function: name,
    variables,
    call_stack: stack,
  });

  previousDepth = depth;
  previousStack = stack;

  if (events.length >= MAX_EVENTS) {
    truncated = true;
    stopped = true;
    session.post('Debugger.setBreakpointsActive', { active: false });
  }
  session.post('Debugger.resume');
});

function syntaxLine(error) {
  const stack = String((error && error.stack) || '');
  const match = stack.match(/codeflow_user\.js:(\d+)/);
  return match ? Number(match[1]) : null;
}

// Breakpoints are armed from inside `Debugger.scriptParsed`. That event is
// delivered synchronously while the script is being started, so the exact
// executable locations are known — and the breakpoints are in place — before
// the first statement runs. Arming by URL instead would let several requested
// lines collapse onto one address and pause the program twice in one spot.
function armBreakpoints(scriptId, done) {
  session.post('Debugger.getPossibleBreakpoints', {
    start: { scriptId, lineNumber: 0, columnNumber: 0 },
    end: { scriptId, lineNumber: lineCount, columnNumber: 0 },
    restrictToFunction: false,
  }, (error, result) => {
    const locations = (!error && result && result.locations) || [];
    const seen = new Set();
    const chosen = [];
    for (const location of locations) {
      if (seen.has(location.lineNumber)) continue;
      seen.add(location.lineNumber);
      chosen.push(location);
    }
    if (!chosen.length) {
      done();
      return;
    }
    let pending = chosen.length;
    for (const location of chosen) {
      session.post('Debugger.setBreakpoint', {
        location: {
          scriptId: location.scriptId,
          lineNumber: location.lineNumber,
          columnNumber: location.columnNumber,
        },
      }, () => {
        pending -= 1;
        if (pending === 0) done();
      });
    }
  });
}

function execute() {
  let script;
  try {
    script = new vm.Script(source, { filename: SCRIPT_URL, displayErrors: true });
  } catch (error) {
    failure = {
      kind: 'syntax',
      title: (error && error.name) || 'SyntaxError',
      message: (error && error.message) || String(error),
      line: syntaxLine(error),
    };
    return;
  }
  try {
    // The script is announced to the inspector as it starts running, which is
    // when the pending breakpoints are armed and `userScriptId` is learned.
    script.runInThisContext({ displayErrors: true });
  } catch (error) {
    const stack = String((error && error.stack) || '');
    const match = stack.match(/codeflow_user\.js:(\d+)/);
    const line = match ? Number(match[1]) : null;
    failure = {
      kind: 'runtime',
      title: (error && error.name) || 'Error',
      message: (error && error.message) || String(error),
      line,
    };
    // Node does not raise an exception pause for scripts run through `vm` in
    // this process, so the throw is recorded from the error itself.
    if (!exceptionRecorded) {
      const last = events.length ? events[events.length - 1] : null;
      push({
        sequence: events.length,
        type: 'exception',
        line: line || (last ? last.line : 1),
        function: last ? last.function : '<module>',
        variables: last ? last.variables : {},
        call_stack: previousStack,
        exception: ((error && error.name) || 'Error') + ': '
          + ((error && error.message) || String(error)),
      });
    }
  }
  // The trace is written by the `exit` handler rather than here: timers and
  // callbacks are still queued at this point, and their lines belong in it.
}

session.post('Runtime.enable');
session.post('Debugger.enable', () => {
  session.post('Debugger.setPauseOnExceptions', { state: 'uncaught' });
  execute();
});
