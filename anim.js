/* CodeFlow — animated execution stage.
 *
 * Reads the trace that app.js already collected (window.CodeFlow.snapshot()) and
 * turns it into the kind of step-by-step animation you see in algorithm
 * explainers: array cells, pointer chips, a caption and the active line lit up
 * in the code panel.
 *
 * Nothing here invents data. Every frame is one real event from the trace:
 * the cells are that event's variable value, the highlighted line is that
 * event's line, and "settled" means the cell already holds its final value.
 */
(function () {
  'use strict';

  const INDEX_NAMES = /^(i|j|k|n|index|idx|mid|middle|low|high|left|right|start|end|pos|position|smallest|largest|min|max|lo|hi|p|q)$/i;
  const MAX_POINTERS = 4;

  const state = {
    open: false,
    index: 0,
    playing: false,
    timer: null,
    speed: 1,
    baseDelay: 760,
    model: null,
    cells: [],
    lastIndex: -1
  };

  let root = null;
  let els = {};

  /* ---------- model ---------- */

  // Java, C and C++ report a list as text — "[5, 1, 4, 2]", or with quotes for
  // strings. Parsing it back is what lets those three animate like Python
  // instead of drawing "<int[4]>" as eight frozen cells.
  const LIST_TEXT = /^\[[\s\S]*\]$/;

  // Split on commas that sit at the top level, so a 2-D list stays whole.
  function splitTopLevel(body) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (ch === '[' || ch === '(' || ch === '{') depth += 1;
      else if (ch === ']' || ch === ')' || ch === '}') depth -= 1;
      if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    parts.push(current);
    return parts.map((part) => part.trim()).filter((part) => part.length > 0);
  }

  function parseList(value) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (text.length < 2 || text.length > 240 || !LIST_TEXT.test(text)) return null;
    const body = text.slice(1, -1).trim();
    if (!body) return [];
    const items = splitTopLevel(body).map((item) => {
      const nested = parseList(item);
      if (nested) return nested;
      let part = item;
      if (part.length > 1 && part[0] === '"' && part[part.length - 1] === '"') part = part.slice(1, -1);
      else if (part.length > 2 && part[0] === "'" && part[part.length - 1] === "'") part = part.slice(1, -1);
      // Numeric elements have to become numbers again, otherwise "10" sorts
      // before "9" and the settled state would be wrong.
      return /^-?\d+(\.\d+)?$/.test(part) ? Number(part) : part;
    });
    if (items.length > 40) return null;
    // A lone non-numeric element ("[ok]") is not a list worth drawing.
    if (items.length === 1 && typeof items[0] === 'string') return null;
    return items;
  }

  // A row of a 2-D list is drawn as one cell reading "1 2" — one cell per row
  // is what a terminal would show, and it keeps the grid readable.
  function flattenRows(list) {
    return list.map((item) => (Array.isArray(item) ? item.join(' ') : item));
  }

  // C, C++ and Java report every scalar as text ("0", "5"). A pointer chip has
  // to know it is an index, so numeric text becomes a number again.
  function toNumber(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);
    return null;
  }

  // A pointer address is not a word. Drawing "0x106f03ac0" as eighteen cells
  // is what a reference variable used to look like on the stage.
  function isAddress(value) {
    return typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value.trim());
  }

  // C, C++ and Java report every number as text, so "10" is a number, not the
  // two-character word "1 0". Without this, a running total of 10 froze the
  // stage as two cells reading 1 and 0.
  function isNumberText(value) {
    return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim());
  }

  // "<__main__.Point object>", "Map(2)", "Object", "instance of java.util.Map"
  // are descriptions of a value, not the value. Drawing them as letters is what
  // used to turn an object into a row of meaningless cells.
  const DESCRIPTIONS = /^(Object|Array|Map|Set|WeakMap|WeakSet|Promise|Function|Proxy|RegExp|Date|Error|Arguments)$/;
  const SIZED_DESCRIPTION = /^(Array|Map|Set|WeakMap|WeakSet)\(\d+\)$/;

  function isDescription(value) {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    return /^<.*>$/.test(text)
      || /^instance of /.test(text)
      || DESCRIPTIONS.test(text)
      || SIZED_DESCRIPTION.test(text);
  }

  // The backend sends non-finite floats as text ("-inf"), because JSON cannot
  // carry them. Four characters is not a word to split into cells.
  const NON_FINITE = /^[+-]?(inf|infinity|nan)$/i;

  function drawableString(value) {
    return typeof value === 'string'
      && value.length > 1 && value.length <= 24
      && !isAddress(value) && !isNumberText(value) && !isDescription(value)
      && !NON_FINITE.test(value.trim());
  }

  // A table is not a list. Joining each row into one cell ("0 0 0 0") threw the
  // shape away, so a dp[i][j] program drew six cells holding four numbers each
  // and the table could never be read. Rows of rows stay rows of rows.
  function asGrid(value) {
    let list = null;
    if (Array.isArray(value)) list = value;
    else {
      const parsed = parseList(value);
      if (parsed) list = parsed;
    }
    if (!list || !list.length) return null;
    if (!list.every((row) => Array.isArray(row) && row.length)) return null;
    const total = list.reduce((count, row) => count + row.length, 0);
    if (total > 144) return null;
    return list.map((row) => row.map((cell) => (Array.isArray(cell) ? cell.join(' ') : cell)));
  }

  // A list is the obvious thing to draw. A short string is worth drawing too —
  // "banana" as six cells makes a letter-count program readable. Java reports
  // strings with their quotes, so those come off first.
  function asCells(value) {
    if (Array.isArray(value)) return flattenRows(value.slice());
    const list = parseList(value);
    if (list) return flattenRows(list);
    if (drawableString(value)) {
      const text = (value.length > 2 && value[0] === '"' && value[value.length - 1] === '"')
        ? value.slice(1, -1)
        : value;
      return text.length > 1 ? text.split('') : null;
    }
    return null;
  }

  // A dict/map is state too. Python hands one over as a real object; Java's
  // Map.toString() gives "{b=1, a=3}". Both become the same list of entries,
  // so a letter-count program animates instead of saying "no values to draw".
  // `Counter({'a': 3})` is the same thing wrapped in a constructor, and Python
  // reprs separate with ':' rather than '=' — both forms are accepted.
  function parseMapText(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    const open = trimmed.indexOf('{');
    const close = trimmed.lastIndexOf('}');
    if (open === -1 || close < open) return null;
    // Anything before the brace has to be a plain constructor name.
    if (open > 0 && !/^[A-Za-z_][\w.]*\($/.test(trimmed.slice(0, open))) return null;
    const body = trimmed.slice(open + 1, close).trim();
    if (!body) return [];
    const out = [];
    splitTopLevel(body).forEach((pair) => {
      const equals = pair.indexOf('=');
      const colon = pair.indexOf(':');
      const at = equals === -1 ? colon : (colon === -1 ? equals : Math.min(equals, colon));
      if (at <= 0) return;
      const key = pair.slice(0, at).trim().replace(/^["']|["']$/g, '');
      const item = pair.slice(at + 1).trim().replace(/^["']|["']$/g, '');
      if (key) out.push([key, item]);
    });
    return out.length ? out : null;
  }

  function asEntries(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).slice(0, 20).map((key) => [key, value[key]]);
    }
    return parseMapText(value);
  }

  // Does any index-looking variable (i, j, low, high, middle…) move during the
  // run? If so, a list that never changes is still the right thing to draw:
  // that is a search, and the pointer walking across it is the animation.
  function hasMovingIndex(events, skipKey) {
    const previous = new Map();
    let moving = false;
    events.forEach((event) => {
      const vars = (event && event.variables) || {};
      Object.keys(vars).forEach((name) => {
        if (name === skipKey || !INDEX_NAMES.test(name)) return;
        const value = toNumber(vars[name]);
        if (value === null || !isFinite(value)) return;
        if (previous.has(name) && previous.get(name) !== value) moving = true;
        previous.set(name, value);
      });
    });
    return moving;
  }

  // What should the stage draw? A real list always wins, then a string that
  // actually changes, then a map that actually changes. Anything else falls
  // through to variables mode, so no program is ever left with a dead stage.
  function pickTarget(events) {
    const stats = new Map();
    events.forEach((event) => {
      const vars = (event && event.variables) || {};
      Object.keys(vars).forEach((name) => {
        const value = vars[name];
        const list = parseList(value);
        const isArray = Array.isArray(value) || !!list;
        const cells = Array.isArray(value) ? value : list;
        const entries = isArray ? null : asEntries(value);
        const isString = !isArray && !entries && drawableString(value);
        if (!isArray && !isString && !entries) return;
        const entry = stats.get(name) || {
          name, arrays: 0, strings: 0, maps: 0, changes: 0, size: 0, prev: null, seen: false
        };
        if (isArray) entry.arrays += 1;
        else if (entries) entry.maps += 1;
        else entry.strings += 1;
        const signature = isArray ? JSON.stringify(cells)
          : (entries ? JSON.stringify(entries) : value);
        if (entry.seen && entry.prev !== signature) entry.changes += 1;
        entry.prev = signature;
        entry.seen = true;
        entry.size = Math.max(entry.size, cells ? cells.length : (entries ? entries.length : value.length));
        stats.set(name, entry);
      });
    });

    const all = Array.from(stats.values());
    const arrays = all.filter((entry) => entry.arrays > 0);

    const changingArrays = arrays.filter((entry) => entry.changes > 0);
    if (changingArrays.length) {
      changingArrays.sort((a, b) => (b.changes - a.changes) || (b.size - a.size) || (b.arrays - a.arrays));
      return { name: changingArrays[0].name, kind: 'array' };
    }

    const watched = arrays.filter((entry) => hasMovingIndex(events, entry.name));
    if (watched.length) {
      watched.sort((a, b) => (b.size - a.size) || (b.arrays - a.arrays));
      return { name: watched[0].name, kind: 'array' };
    }

    // A dict that changes is the state of a counting/grouping program — the
    // word being counted is just the loop variable. Maps therefore outrank a
    // moving string, or `counts[word] += 1` would animate the word "dog"
    // instead of the counts.
    const maps = all.filter((entry) => entry.maps > 0 && entry.changes > 0);
    if (maps.length) {
      maps.sort((a, b) => (b.changes - a.changes) || (b.size - a.size));
      return { name: maps[0].name, kind: 'map' };
    }
    const movingStrings = all.filter((entry) => entry.strings > 0 && entry.changes > 0);
    if (movingStrings.length) {
      movingStrings.sort((a, b) => b.changes - a.changes);
      return { name: movingStrings[0].name, kind: 'array' };
    }
    // Nothing moves except the list itself being static — draw it anyway.
    if (arrays.length) {
      arrays.sort((a, b) => (b.size - a.size) || (b.arrays - a.arrays));
      return { name: arrays[0].name, kind: 'array' };
    }
    // A dict built in one go (`counts = Counter(text)`) never changes, but it
    // is still the program's state — draw it rather than fall back to "no
    // values". Only when no scalar moves either: a counter that walks a static
    // config dict should animate the counter, not a frozen map.
    const anyMaps = all.filter((entry) => entry.maps > 0);
    if (anyMaps.length && !scalarsMove(events)) {
      anyMaps.sort((a, b) => (b.size - a.size) || (b.maps - a.maps));
      return { name: anyMaps[0].name, kind: 'map' };
    }
    return null;
  }

  // Nothing list-shaped? Draw the variables themselves — name above, value
  // inside — so every program has something that visibly changes.
  function collectScalars(events) {
    const names = [];
    events.forEach((event) => {
      const vars = (event && event.variables) || {};
      Object.keys(vars).forEach((name) => {
        const value = vars[name];
        const scalar = typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean';
        if (!scalar || names.indexOf(name) !== -1 || names.length >= 6) return;
        if (String(value).length > 14) return;
        // A function, an address or a "<... object>" description is not state
        // the user can read — "<function fib>" used to get its own cell.
        if (typeof value === 'string' && (isDescription(value) || isAddress(value))) return;
        names.push(name);
      });
    });
    return names;
  }

  // Does any loose scalar take more than one value during the run? Used to
  // decide whether a static map is worth drawing: a counter walking a config
  // dict should animate the counter, not a frozen map. A variable appearing for
  // the first time is not "movement" — only a second distinct value is.
  function scalarsMove(events) {
    const names = collectScalars(events);
    if (!names.length) return false;
    const seen = new Map();
    events.forEach((event) => {
      const scope = (event && event.variables) || {};
      names.forEach((name) => {
        if (!Object.prototype.hasOwnProperty.call(scope, name)) return;
        if (!seen.has(name)) seen.set(name, new Set());
        seen.get(name).add(String(scope[name]));
      });
    });
    return Array.from(seen.values()).some((values) => values.size > 1);
  }

  /* ---------- printed output ---------- */

  // A statement that prints. Used only for languages whose tracer reports the
  // whole output at the end (C, C++, Java, JavaScript) — there is no per-step
  // `output` to read, so the printed lines are matched to the step that ran the
  // print. Python needs none of this: its tracer emits one event per line.
  const PRINT_LINE = /\b(print|println|printf|fprintf|sprintf|puts|putchar|cout|cerr|console\s*\.\s*log|System\s*\.\s*(out|err)|fmt\s*\.\s*Print|echo)\b/;

  function outputLines(snap) {
    if (Array.isArray(snap.output) && snap.output.length) return snap.output.slice();
    const text = String(snap.stdout || '');
    if (!text) return [];
    return text.replace(/\r\n|\r/g, '\n').split('\n');
  }

  // One array per event: the lines printed *up to and including* that step.
  // Without this, a program whose only visible effect is printing left the
  // stage saying "no values to draw".
  function buildOutput(events, snap) {
    if (!events.length) return null;
    const frames = new Array(events.length);
    let shown = [];
    let exact = false;

    events.forEach((event, index) => {
      if (event && event.type === 'stdout') {
        const text = String(event.output == null ? '' : event.output)
          .replace(/\r\n|\r/g, '\n')
          .replace(/\n$/, '');
        shown = shown.concat([{ text, line: event.line || null }]);
        exact = true;
      }
      frames[index] = shown;
    });

    // Python (and the offline fallback) already attributed every line.
    if (exact) return frames.some((lines) => lines.length) ? frames : null;

    const final = outputLines(snap);
    while (final.length && final[final.length - 1] === '') final.pop();
    if (!final.length) return null;

    const printLines = new Set();
    String(snap.source || '').split('\n').forEach((text, i) => {
      if (PRINT_LINE.test(text)) printLines.add(i + 1);
    });

    // How many steps ran a print. One visit to a print line inside a loop
    // prints one line, so the lines are spread across the visits rather than
    // dumped on the last frame.
    let seen = 0;
    const visitsSoFar = events.map((event) => {
      if (event && printLines.has(event.line)) seen += 1;
      return seen;
    });
    const visits = seen;

    let next = 0;
    let carried = [];
    events.forEach((event, index) => {
      if (event && printLines.has(event.line) && next < final.length) {
        const remainingVisits = Math.max(1, visits - visitsSoFar[index] + 1);
        const take = Math.max(1, Math.ceil((final.length - next) / remainingVisits));
        const batch = [];
        for (let k = 0; k < take && next < final.length; k += 1, next += 1) {
          batch.push({ text: final[next], line: event.line });
        }
        carried = carried.concat(batch);
      }
      frames[index] = carried;
    });

    // Anything still unattributed belongs to the end of the run — say so
    // rather than inventing a line number for it.
    if (next < final.length) {
      carried = carried.concat(final.slice(next).map((text) => ({ text, line: null })));
      frames[events.length - 1] = carried;
    }
    return frames.some((lines) => lines.length) ? frames : null;
  }

  // Does anything on the stage ever move? A static list, a program with one
  // assignment — those draw cells that never change, which reads as a broken
  // animation. When that happens the printed output supplies the motion.
  function framesMove(frames) {
    for (let i = 1; i < frames.length; i += 1) {
      const before = frames[i - 1] || [];
      const after = frames[i] || [];
      if (before.length !== after.length) return true;
      for (let k = 0; k < after.length; k += 1) {
        if (String(before[k]) !== String(after[k])) return true;
      }
    }
    return false;
  }

  /* ---------- call stack ---------- */

  // Per-step snapshots of a 2-D table. Returns null unless the variable really
  // is a table — a list that happens to hold one row is still a list, and the
  // row stage reads better for it.
  function buildGrid(events, key) {
    let last = null;
    const frames = events.map((event) => {
      const value = event && event.variables ? event.variables[key] : undefined;
      const grid = asGrid(value);
      if (grid) last = grid;
      return grid || last;
    });
    if (!frames.some((grid) => grid)) return null;
    // Steps before the table exists are backfilled from the first known state,
    // the same way the row stage opens on a filled list.
    const firstKnown = frames.find((grid) => grid) || [];
    const padded = frames.map((grid) => grid || firstKnown);
    if (padded.every((grid) => grid.length < 2)) return null;
    const final = padded[padded.length - 1] || [];
    return {
      frames: padded,
      rows: final.length,
      cols: final.reduce((max, row) => Math.max(max, row.length), 0)
    };
  }

  // A program recurses when the same function appears twice inside one stack.
  // A helper called once per loop (sort -> swap) is depth 2 but never repeats,
  // so those programs keep their array animation.
  function isRecursive(events) {
    return events.some((event) => {
      const stack = (event && event.call_stack) || [];
      const seen = new Set();
      for (let i = 0; i < stack.length; i += 1) {
        if (seen.has(stack[i])) return true;
        seen.add(stack[i]);
      }
      return false;
    });
  }

  // One argument, short enough for a frame row. An array argument is summarised
  // rather than printed — a row has to stay one line.
  function argText(value) {
    if (Array.isArray(value)) return '[' + value.length + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).length + '}';
    if (value === undefined) return '?';
    const text = String(value);
    if (isDescription(text)) return '…';
    return text.length > 12 ? text.slice(0, 11) + '…' : text;
  }

  function frameArgs(vars) {
    // Four, not three: hanoi(n, source, spare, target) loses its target
    // otherwise, and the row has an ellipsis if it gets too wide.
    const names = Object.keys(vars || {}).filter((name) => !isDescription(String(vars[name]))).slice(0, 4);
    return names.map((name) => ({ name, value: argText(vars[name]) }));
  }

  // The stack at every step: the frames that were live, what they were called
  // with, and — when the tracer reports it — what they returned. This is what a
  // recursive program actually needs; a single "n" cell counting down and back
  // up says nothing about factorial.
  function buildStack(events) {
    const frames = new Array(events.length);
    let live = [];
    events.forEach((event, index) => {
      const stack = (event && event.call_stack) || [];
      // The reported depth is authoritative: a return event still lists the
      // frame that is returning, and the pop happens on the next event.
      while (live.length > stack.length) live.pop();
      while (live.length < stack.length) {
        const at = live.length;
        const fresh = stack[at];
        // Only the newest frame is described by this event's variables.
        live.push({ name: fresh, args: at === stack.length - 1 ? frameArgs(event.variables) : [], result: null });
      }
      if (event && event.type === 'return' && live.length) {
        const top = live[live.length - 1];
        if (event.return_value !== undefined && event.return_value !== null) {
          top.result = argText(event.return_value);
        }
      }
      frames[index] = live.map((frame) => ({ name: frame.name, args: frame.args.slice(), result: frame.result }));
    });
    return frames;
  }

  function buildModel() {
    const api = window.CodeFlow;
    if (!api || typeof api.snapshot !== 'function') return null;
    const snap = api.snapshot();
    const events = (snap && snap.events) || [];
    if (!events.length) return null;

    const source = snap.source || '';
    const language = snap.language || '';
    const output = buildOutput(events, snap);
    const printed = output ? (output[output.length - 1] || []).length : 0;
    const target = pickTarget(events);

    if (!target) {
      // Recursion first: when a program calls itself, the stack is the state.
      // Drawing one "n" cell that walks 5→4→3→2→1 and then back up is what made
      // factorial look broken — the result never appeared anywhere.
      if (isRecursive(events)) {
        const stack = buildStack(events);
        const depth = stack.reduce((max, live) => Math.max(max, live.length), 0);
        return {
          events,
          key: null,
          mode: 'stack',
          stack,
          depth,
          output: printed ? output : null,
          source,
          language
        };
      }
      const vars = collectScalars(events);
      if (!vars.length) {
        // Nothing to draw at all: the printed lines become the stage.
        if (printed) return { events, key: null, mode: 'output', output, source, language };
        return { events, key: null, mode: 'none', source, language };
      }
      return {
        events,
        key: null,
        mode: 'vars',
        vars,
        // Loose scalars are rarely the point of a program that prints — a star
        // pyramid, a multiplication table. The terminal runs underneath so the
        // thing the program actually produced is visible. A list or a map being
        // animated stays clean instead (see below).
        output: printed ? output : null,
        source,
        language
      };
    }

    const key = target.name;

    if (target.kind === 'map') {
      let last = [];
      const frames = events.map((event) => {
        const value = event && event.variables ? event.variables[key] : undefined;
        const entries = asEntries(value);
        if (entries) last = entries;
        return entries || last;
      });
      // No backfill here: an empty dict is a real state, and showing keys the
      // program has not created yet would be a lie.
      if (!frames.some((entries) => entries.length)) {
        const vars = collectScalars(events);
        if (!vars.length) {
          if (printed) return { events, key: null, mode: 'output', output, source, language };
          return { events, key: null, mode: 'none', source, language };
        }
        return { events, key: null, mode: 'vars', vars, output: printed ? output : null, source, language };
      }
      const mapStatic = !framesMove(frames.map((entries) => entries.map((pair) => pair.join('='))));
      return {
        events,
        key,
        mode: 'map',
        filled: frames,
        output: mapStatic && printed ? output : null,
        source,
        language
      };
    }

    // A 2-D table gets its own stage before the flat list does, otherwise every
    // row is collapsed into a single cell and the grid is lost.
    const grid = buildGrid(events, key);
    if (grid) {
      return {
        events,
        key,
        mode: 'grid',
        filled: grid.frames,
        rows: grid.rows,
        cols: grid.cols,
        source,
        language
      };
    }

    const series = events.map((event) => {
      const value = event && event.variables ? event.variables[key] : undefined;
      return asCells(value);
    });

    // Carry the last known array forward so a step without the variable still
    // draws something instead of collapsing to zero cells.
    let last = null;
    const filled = series.map((value) => {
      if (value) last = value;
      return value || last || [];
    });

    // The first few events run before the list is assigned, so backfill them
    // from the first state we do know — otherwise the stage opens empty.
    const firstKnown = filled.find((value) => value.length) || [];
    const padded = filled.map((value) => (value.length ? value : firstKnown));

    const final = padded[padded.length - 1] || [];
    const sorted = final.slice().sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));

    // "Settled" means "already in its final place", which is only a meaningful
    // thing to show when the program is sorting. A palindrome being built up
    // letter by letter would otherwise light random cells green.
    const finalSorted = final.length > 0 && sorted.every((value, i) => value === final[i]);

    // Index of the first step that actually moved a value. "Settled" (a cell
    // already holding its final value) only means something after that point;
    // before it, every cell would look finished on an already-sorted input.
    let firstMutation = -1;
    padded.forEach((value, i) => {
      if (i === 0 || firstMutation !== -1) return;
      if (value.some((cell, idx) => cell !== padded[i - 1][idx])) firstMutation = i;
    });

    return {
      events,
      key,
      mode: 'array',
      filled: padded,
      final,
      sorted,
      settledFrom: firstMutation,
      settledVisible: firstMutation !== -1 && finalSorted,
      // A list that never changes draws cells that never move. If the program
      // prints, the printed lines run underneath it so the stage still moves —
      // but only when nothing else does: a search already animates through its
      // pointer chips, and a terminal panel under it would just be noise.
      output: firstMutation === -1 && !hasMovingIndex(events, key) && printed ? output : null,
      source,
      language
    };
  }

  function isSettled(model, value, cellIndex, stepIndex) {
    if (!model.settledVisible) return false;
    if (stepIndex < model.settledFrom) return false;
    return cellIndex < model.sorted.length && value === model.sorted[cellIndex];
  }

  function pointersFor(model, index) {
    const event = model.events[index];
    const vars = (event && event.variables) || {};
    const array = model.filled[index] || [];
    const indexPointers = [];
    const valuePointers = [];

    Object.keys(vars).forEach((name) => {
      if (name === model.key) return;
      const value = toNumber(vars[name]);
      if (value === null || !isFinite(value)) return;
      if (Number.isInteger(value) && value >= 0 && value < array.length && INDEX_NAMES.test(name)) {
        indexPointers.push({ name, at: value });
      } else {
        const at = array.indexOf(value);
        if (at !== -1) valuePointers.push({ name, at });
      }
    });

    const list = indexPointers.concat(valuePointers);
    // One chip per position, first name wins, capped so the stage stays legible.
    const byIndex = new Map();
    list.forEach((pointer) => {
      if (byIndex.size >= MAX_POINTERS && !byIndex.has(pointer.at)) return;
      if (!byIndex.has(pointer.at)) byIndex.set(pointer.at, []);
      byIndex.get(pointer.at).push(pointer.name);
    });
    return byIndex;
  }

  function tagFor(model, index, changed, swaps, grew, printed) {
    const event = model.events[index] || {};
    // The stage follows the same trace the timeline does, and that trace carries
    // two events that belong to no source line: the input the program read, and
    // the exception that stopped it.
    if (event.type === 'input' || event.type === 'stdin') return { tag: 'INPUT', tone: 'blue', line: null };
    if (event.type === 'exception' || event.type === 'error') return { tag: 'ERROR', tone: 'red', line: event.line };
    // Output-only stage: the only thing that ever happens is a line appearing.
    if (model.mode === 'output') {
      if (printed) return { tag: 'OUTPUT', tone: 'green', line: event.line };
      return { tag: 'LINE ' + (event.line || 1), tone: 'muted', line: event.line };
    }
    // A static list plus a print: the print is the event worth naming.
    if (printed && !changed.length) return { tag: 'OUTPUT', tone: 'green', line: event.line };
    // A tracer reports the change on the *next* line event, because the line
    // that mutated the list has already run by then. Blaming the previous line
    // is what makes the highlight land on the swap instead of the loop header.
    const actor = (changed.length && index > 0 && model.mode !== 'vars')
      ? (model.events[index - 1] || event)
      : event;
    const line = (model.source.split('\n')[(actor.line || 1) - 1] || '').trim();
    if (changed.length && model.mode === 'vars') return { tag: 'UPDATE', tone: 'amber', line: event.line };
    if (changed.length && model.mode === 'grid') return { tag: 'UPDATE', tone: 'amber', line: actor.line };
    if (changed.length && model.mode === 'map') {
      return { tag: grew > 0 ? 'ADD' : 'UPDATE', tone: 'amber', line: actor.line };
    }
    // Only a true exchange of two values is a swap. Two cells changing because
    // the list grew by one is not.
    if (swaps) return { tag: 'SWAP', tone: 'amber', line: actor.line };
    if (grew > 0) return { tag: 'ADD', tone: 'amber', line: actor.line };
    if (grew < 0) return { tag: 'REMOVE', tone: 'amber', line: actor.line };
    if (changed.length) return { tag: 'MOVE', tone: 'amber', line: actor.line };
    if (event.type === 'stdout') return { tag: 'OUTPUT', tone: 'green', line: event.line };
    if (event.type === 'return') return { tag: 'RETURN', tone: 'green', line: event.line };
    if (/^(if|elif|else if|while|for)\b/.test(line)) return { tag: 'CHECK', tone: 'blue', line: event.line };
    return { tag: 'LINE ' + (event.line || 1), tone: 'muted', line: event.line };
  }

  /* ---------- DOM ---------- */

  function build() {
    root = document.createElement('div');
    root.className = 'anim';
    root.id = 'anim';
    root.hidden = true;
    root.innerHTML = [
      '<div class="anim-panel" role="dialog" aria-modal="true" aria-label="Animated execution">',
      '  <header class="anim-head">',
      '    <div class="anim-head-copy">',
      '      <div class="anim-eyebrow" id="anim-eyebrow">ANIMATION</div>',
      '      <h2 id="anim-title">Animated run</h2>',
      '    </div>',
      '    <div class="anim-badges" id="anim-badges"></div>',
      '    <button class="icon-button anim-close" id="anim-close" aria-label="Close animation">×</button>',
      '  </header>',
      '  <div class="anim-field" id="anim-field">',
      '    <div class="anim-stack" id="anim-stack" hidden></div>',
      '    <div class="anim-cells" id="anim-cells"></div>',
      '    <div class="anim-grid" id="anim-grid" hidden></div>',
      '    <div class="anim-output" id="anim-output" hidden></div>',
      '    <p class="anim-empty" id="anim-empty" hidden></p>',
      '  </div>',
      '  <div class="anim-caption" id="anim-caption"><span class="anim-tag" id="anim-tag">LINE</span><code id="anim-line"></code></div>',
      '  <div class="anim-code" id="anim-code"></div>',
      '  <footer class="anim-controls">',
      '    <button class="anim-btn" id="anim-restart" aria-label="Back to first step">⏮</button>',
      '    <button class="anim-btn" id="anim-prev" aria-label="Previous step">‹</button>',
      '    <button class="anim-btn anim-play" id="anim-play" aria-label="Play">▶</button>',
      '    <button class="anim-btn" id="anim-next" aria-label="Next step">›</button>',
      '    <div class="anim-track" id="anim-track"><div class="anim-progress" id="anim-progress"></div></div>',
      '    <span class="anim-count" id="anim-count">0 / 0</span>',
      '    <button class="anim-btn anim-speed" id="anim-speed" aria-label="Playback speed">1×</button>',
      '  </footer>',
      '</div>'
    ].join('');
    document.body.appendChild(root);

    els = {
      eyebrow: root.querySelector('#anim-eyebrow'),
      title: root.querySelector('#anim-title'),
      badges: root.querySelector('#anim-badges'),
      field: root.querySelector('#anim-field'),
      cells: root.querySelector('#anim-cells'),
      grid: root.querySelector('#anim-grid'),
      stack: root.querySelector('#anim-stack'),
      output: root.querySelector('#anim-output'),
      empty: root.querySelector('#anim-empty'),
      caption: root.querySelector('#anim-caption'),
      tag: root.querySelector('#anim-tag'),
      line: root.querySelector('#anim-line'),
      code: root.querySelector('#anim-code'),
      play: root.querySelector('#anim-play'),
      prev: root.querySelector('#anim-prev'),
      next: root.querySelector('#anim-next'),
      restart: root.querySelector('#anim-restart'),
      progress: root.querySelector('#anim-progress'),
      track: root.querySelector('#anim-track'),
      count: root.querySelector('#anim-count'),
      speed: root.querySelector('#anim-speed'),
      close: root.querySelector('#anim-close')
    };

    els.close.addEventListener('click', close);
    els.play.addEventListener('click', togglePlay);
    els.prev.addEventListener('click', () => { stop(); goTo(state.index - 1, true); });
    els.next.addEventListener('click', () => { stop(); goTo(state.index + 1, true); });
    els.restart.addEventListener('click', () => { stop(); goTo(0, true); });
    els.speed.addEventListener('click', cycleSpeed);
    els.track.addEventListener('click', (event) => {
      const rect = els.track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      goTo(Math.round(ratio * (state.model.events.length - 1)), true);
    });
    root.addEventListener('click', (event) => { if (event.target === root) close(); });
    document.addEventListener('keydown', onKey);
  }

  function onKey(event) {
    if (!state.open) return;
    if (event.key === 'Escape') { close(); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); goTo(state.index + 1, true); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); goTo(state.index - 1, true); }
    if (event.key === ' ') { event.preventDefault(); togglePlay(); }
  }

  /* ---------- render ---------- */

  function renderCode() {
    const lines = state.model.source.replace(/\t/g, '  ').split('\n');
    els.code.innerHTML = lines.map((text, i) =>
      '<div class="anim-code-line" data-line="' + (i + 1) + '">' +
      '<span class="anim-code-n">' + (i + 1) + '</span>' +
      '<span class="anim-code-t">' + escapeHtml(text || ' ') + '</span>' +
      '</div>'
    ).join('');
  }

  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function ensureCells(count) {
    while (els.cells.children.length < count) {
      const col = document.createElement('div');
      col.className = 'anim-col';
      col.innerHTML = '<span class="anim-chip"></span><div class="anim-cell"><span></span></div><span class="anim-idx"></span>';
      els.cells.appendChild(col);
      state.cells.push(col);
    }
    while (els.cells.children.length > count) {
      els.cells.removeChild(els.cells.lastChild);
      state.cells.pop();
    }
  }

  // A step that exchanges exactly two values is a swap. Those get a slide
  // (the value travels between cells) instead of a pop, which is what makes the
  // sort look like the algorithm explainers.
  function swappedPairs(previous, current) {
    if (!previous.length || previous.length !== current.length) return [];
    const diffs = [];
    for (let i = 0; i < current.length; i += 1) {
      if (previous[i] !== current[i]) diffs.push(i);
    }
    if (diffs.length !== 2) return [];
    const [a, b] = diffs;
    return previous[a] === current[b] && previous[b] === current[a] ? [[a, b]] : [];
  }

  function slideFace(col, dx) {
    if (!col || !dx) return;
    const face = col.querySelector('.anim-cell span');
    if (!face) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    face.style.transition = 'none';
    face.style.transform = 'translateX(' + dx + 'px)';
    void face.offsetWidth;
    face.style.transition = 'transform 340ms cubic-bezier(.34, .9, .3, 1)';
    face.style.transform = 'translateX(0)';
  }

  // Variables mode: one cell per variable, its name above, its value inside.
  // Used when the program has no list to draw — the state still moves.
  function renderVarCells(index) {
    const model = state.model;
    const event = model.events[index] || {};
    const vars = event.variables || {};
    ensureCells(model.vars.length);
    const changed = [];
    if (!state.varLast) state.varLast = {};

    model.vars.forEach((name, i) => {
      const col = state.cells[i];
      const cell = col.querySelector('.anim-cell');
      const chip = col.querySelector('.anim-chip');
      const text = cell.querySelector('span');
      const inScope = Object.prototype.hasOwnProperty.call(vars, name);
      if (inScope) state.varLast[name] = vars[name];
      // A local disappears when its function returns. Blanking the cell looks
      // like data loss, so keep the last value and dim it instead.
      const value = inScope ? vars[name] : state.varLast[name];
      const next = value === undefined ? '·' : String(value);

      if (text.textContent !== next) {
        text.textContent = next;
        cell.classList.remove('is-changed');
        void cell.offsetWidth;
        if (inScope) {
          cell.classList.add('is-changed');
          changed.push(i);
        }
      }
      cell.classList.toggle('is-out', !inScope && value !== undefined);
      cell.classList.remove('is-settled');
      cell.classList.toggle('is-pointer', inScope);
      chip.textContent = name;
      chip.classList.add('is-visible');
      col.querySelector('.anim-idx').textContent = '';
    });
    return changed;
  }

  // Map mode: one cell per entry, the key above it, the value inside. Used by
  // count/frequency programs, whose only state is a dict.
  function renderMapCells(index) {
    const model = state.model;
    const entries = model.filled[index] || [];
    const previous = index > 0 ? (model.filled[index - 1] || []) : [];
    ensureCells(entries.length);
    const changed = [];
    entries.forEach(([key, value], i) => {
      const col = state.cells[i];
      const cell = col.querySelector('.anim-cell');
      const chip = col.querySelector('.anim-chip');
      const text = cell.querySelector('span');
      const idx = col.querySelector('.anim-idx');
      const next = String(value);
      if (text.textContent !== next) {
        text.textContent = next;
        cell.classList.remove('is-changed');
        void cell.offsetWidth;
        cell.classList.add('is-changed');
        changed.push(i);
      }
      cell.classList.remove('is-settled', 'is-pointer');
      chip.textContent = key;
      chip.classList.add('is-visible');
      idx.textContent = '';
    });
    return { changed, swaps: 0, grew: previous.length ? entries.length - previous.length : 0 };
  }

  function renderCells(index) {
    const model = state.model;
    const array = model.filled[index] || [];
    const previous = index > 0 ? (model.filled[index - 1] || []) : [];
    const pointers = pointersFor(model, index);
    ensureCells(array.length);

    // Measure before the text changes — FLIP needs the old positions.
    const lefts = state.cells.map((col) => col.querySelector('.anim-cell').getBoundingClientRect().left);
    const swaps = swappedPairs(previous, array);
    const moving = new Set(swaps.reduce((acc, pair) => acc.concat(pair), []));

    array.forEach((value, i) => {
      const col = state.cells[i];
      const cell = col.querySelector('.anim-cell');
      const chip = col.querySelector('.anim-chip');
      const idx = col.querySelector('.anim-idx');
      const text = cell.querySelector('span');
      const next = String(value);

      if (text.textContent !== next) {
        text.textContent = next;
        cell.classList.remove('is-changed');
        // restart the pop animation
        void cell.offsetWidth;
        if (previous.length && !moving.has(i)) cell.classList.add('is-changed');
      }
      cell.classList.toggle('is-settled', isSettled(model, value, i, index));
      cell.classList.toggle('is-pointer', pointers.has(i));

      const names = pointers.get(i);
      chip.textContent = names ? names.join(' · ') : '';
      chip.classList.toggle('is-visible', !!names);
      idx.textContent = i;
    });

    swaps.forEach(([a, b]) => {
      slideFace(state.cells[a], lefts[b] - lefts[a]);
      slideFace(state.cells[b], lefts[a] - lefts[b]);
    });

    const changed = array.reduce((acc, value, i) => {
      if (previous.length && previous[i] !== value) acc.push(i);
      return acc;
    }, []);
    return { changed, swaps: swaps.length, grew: previous.length ? array.length - previous.length : 0 };
  }

  // 2-D tables: a real grid, row index down the left edge. Cells are patched in
  // place so only the cell that changed pops — rebuilding the whole table every
  // step would restart every animation and kill the scroll position.
  function renderGrid(index) {
    const model = state.model;
    const grid = model.filled[index] || [];
    const previous = index > 0 ? (model.filled[index - 1] || []) : [];
    const box = els.grid;
    const shape = grid.map((row) => row.length).join(',');
    if (box.dataset.shape !== shape) {
      box.dataset.shape = shape;
      box.innerHTML = grid.map((row, r) => (
        '<div class="anim-grid-row">' +
        '<span class="anim-grid-r">' + r + '</span>' +
        row.map((value, c) => (
          '<div class="anim-cell" data-r="' + r + '" data-c="' + c + '"><span></span></div>'
        )).join('') +
        '</div>'
      )).join('');
    }
    const changed = [];
    grid.forEach((row, r) => {
      row.forEach((value, c) => {
        const cell = box.querySelector('.anim-cell[data-r="' + r + '"][data-c="' + c + '"]');
        if (!cell) return;
        const text = cell.querySelector('span');
        const next = String(value);
        if (text.textContent === next) return;
        text.textContent = next;
        cell.classList.remove('is-changed');
        void cell.offsetWidth;
        if (previous.length) cell.classList.add('is-changed');
        changed.push(r * 1000 + c);
      });
    });
    return { changed, swaps: 0, grew: 0 };
  }

  // Recursion: one row per live frame, outermost first, indented by depth. A
  // frame that returns shows its value, then collapses on the next step — that
  // collapse is the unwinding, which is the part a flat variable cell hides.
  function renderStack(index) {
    const model = state.model;
    const box = els.stack;
    if (!box) return { added: 0, depth: 0 };
    const frames = model.stack ? (model.stack[index] || []) : null;
    if (!frames) {
      box.hidden = true;
      els.field.classList.remove('has-stack');
      return { added: 0, depth: 0 };
    }
    box.hidden = false;
    els.field.classList.add('has-stack');

    while (box.children.length > frames.length) box.removeChild(box.lastChild);
    let added = 0;
    frames.forEach((frame, i) => {
      let row = box.children[i];
      if (!row) {
        row = document.createElement('div');
        row.className = 'anim-frame is-new';
        row.innerHTML = '<span class="anim-frame-name"></span><span class="anim-frame-args"></span><span class="anim-frame-ret"></span>';
        box.appendChild(row);
        added += 1;
      }
      row.style.setProperty('--depth', String(Math.min(i, 6)));
      row.querySelector('.anim-frame-name').textContent = frame.name;
      const args = frame.args.map((arg) => arg.name + '=' + arg.value).join(' ');
      const argsEl = row.querySelector('.anim-frame-args');
      if (argsEl.textContent !== args) argsEl.textContent = args;
      row.querySelector('.anim-frame-ret').textContent = frame.result ? '→ ' + frame.result : '';
      row.classList.toggle('is-returned', Boolean(frame.result));
      row.classList.toggle('is-current', i === frames.length - 1);
    });
    // A deep recursion pushes the newest frame out of view — follow it.
    if (added) box.scrollTop = box.scrollHeight;
    return { added, depth: frames.length };
  }

  // Printed output as a terminal: one row per line, the newest one lit. It is
  // the whole stage when the program keeps nothing else, and a strip under the
  // cells when the cells are static.
  function renderOutput(index) {
    const model = state.model;
    const box = els.output;
    if (!box) return { added: 0, total: 0 };
    const frames = model.output;
    if (!frames) {
      box.hidden = true;
      els.field.classList.remove('has-output');
      return { added: 0, total: 0 };
    }

    const lines = frames[index] || [];
    // An empty strip is noise when the terminal is only an extra panel under
    // the cells; it is only worth its space once something has been printed.
    if (!lines.length && model.mode !== 'output') {
      box.hidden = true;
      els.field.classList.remove('has-output');
      return { added: 0, total: 0 };
    }
    box.hidden = false;
    els.field.classList.add('has-output');
    // A step before the first print would otherwise draw an empty box.
    box.classList.toggle('is-empty', lines.length === 0);

    while (box.children.length > lines.length) box.removeChild(box.lastChild);
    let added = 0;
    lines.forEach((entry, i) => {
      let row = box.children[i];
      if (!row) {
        row = document.createElement('div');
        row.className = 'anim-out-line is-new';
        row.innerHTML = '<span class="anim-out-n"></span><code></code>';
        box.appendChild(row);
        added += 1;
      }
      const number = row.querySelector('.anim-out-n');
      const text = row.querySelector('code');
      const next = entry.text === '' ? ' ' : entry.text;
      if (text.textContent !== next) text.textContent = next;
      number.textContent = entry.line ? String(entry.line) : '';
      row.classList.toggle('is-last', i === lines.length - 1);
    });

    if (added) box.scrollTop = box.scrollHeight;
    return { added, total: lines.length };
  }

  function render(index) {
    const model = state.model;
    if (!model || !model.events.length) return;
    const event = model.events[index] || {};
    state.index = index;

    let changed = [];
    let swaps = 0;
    let grew = 0;
    let printed = 0;
    // The grid is a second stage, not a third mode of the row strip: only one
    // of the two is ever visible.
    els.grid.hidden = model.mode !== 'grid';
    if (model.mode === 'stack') {
      // Recursion: the call stack is the stage.
      els.cells.hidden = true;
      els.empty.hidden = true;
    } else if (model.mode === 'output') {
      // Nothing but printed lines: the terminal is the stage.
      els.cells.hidden = true;
      els.empty.hidden = true;
    } else if (model.mode === 'grid') {
      const frame = renderGrid(index);
      changed = frame.changed;
      els.cells.hidden = true;
      els.empty.hidden = true;
    } else if (model.mode === 'vars') {
      changed = renderVarCells(index);
      els.cells.hidden = false;
      els.empty.hidden = true;
    } else if (model.mode === 'array') {
      const frame = renderCells(index);
      changed = frame.changed;
      swaps = frame.swaps;
      grew = frame.grew;
      els.cells.hidden = false;
      els.empty.hidden = true;
    } else if (model.mode === 'map') {
      const frame = renderMapCells(index);
      changed = frame.changed;
      grew = frame.grew;
      els.cells.hidden = false;
      els.empty.hidden = true;
    } else {
      els.cells.hidden = true;
      els.empty.hidden = false;
      els.empty.textContent = 'This program keeps no values to draw — the code panel still follows every step.';
    }
    printed = renderOutput(index).added;
    renderStack(index);

    const { tag, tone, line: activeLine } = tagFor(model, index, changed, swaps, grew, printed);
    let caption = activeLine ? (model.source.split('\n')[activeLine - 1] || '').trim() : '';
    if (event.type === 'input' || event.type === 'stdin') {
      const text = event.input == null ? '' : String(event.input).replace(/\r\n|\r|\n/g, ', ');
      caption = text ? 'reads \u201c' + text + '\u201d' : 'reads input';
    } else if ((event.type === 'exception' || event.type === 'error') && event.exception) {
      caption = String(event.exception);
    }
    els.tag.textContent = tag;
    els.tag.dataset.tone = tone;
    els.caption.dataset.tone = tone;
    els.line.textContent = caption || '—';

    els.code.querySelectorAll('.anim-code-line').forEach((row) => {
      const active = Boolean(activeLine) && Number(row.dataset.line) === activeLine;
      row.classList.toggle('is-active', active);
      if (active) row.scrollIntoView({ block: 'nearest' });
    });

    els.count.textContent = (index + 1) + ' / ' + model.events.length;
    els.progress.style.width = ((index + 1) / model.events.length * 100) + '%';
    els.play.textContent = state.playing ? '❚❚' : '▶';
    els.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    state.lastIndex = index;
  }

  /* ---------- playback ---------- */

  function goTo(index, sync) {
    const total = state.model ? state.model.events.length : 0;
    if (!total) return;
    const clamped = Math.min(total - 1, Math.max(0, index));
    render(clamped);
    if (sync && window.CodeFlow && typeof window.CodeFlow.goToStep === 'function') {
      window.CodeFlow.goToStep(clamped);
    }
    if (clamped === total - 1) stop();
  }

  function tick() {
    if (!state.playing) return;
    if (state.index >= state.model.events.length - 1) { stop(); return; }
    goTo(state.index + 1, true);
  }

  function start() {
    if (state.playing) return;
    state.playing = true;
    els.play.textContent = '❚❚';
    state.timer = window.setInterval(tick, state.baseDelay / state.speed);
  }

  function stop() {
    state.playing = false;
    window.clearInterval(state.timer);
    state.timer = null;
    if (els.play) els.play.textContent = '▶';
  }

  function togglePlay() {
    if (state.playing) { stop(); return; }
    if (state.index >= state.model.events.length - 1) goTo(0, true);
    start();
  }

  function cycleSpeed() {
    const order = [1, 0.5, 2, 4];
    const next = order[(order.indexOf(state.speed) + 1) % order.length];
    state.speed = next;
    els.speed.textContent = next + '×';
    if (state.playing) { stop(); start(); }
  }

  /* ---------- open / close ---------- */

  // A program that reads input stops at the first input() call. Its trace is a
  // handful of events with no variables, which looks exactly like a broken
  // animation. Detecting that is what lets the stage ask for the values first.
  function blockedOnInput(events) {
    if (window.CodeFlow && typeof window.CodeFlow.needsInput === 'function' && window.CodeFlow.needsInput()) {
      return true;
    }
    return (events || []).some((event) => event && event.type === 'exception'
      && /EOF|reading a line|end of file/i.test(String(event.exception || '')));
  }

  function waitForRun(attempts) {
    let tries = 0;
    const poll = window.setInterval(() => {
      tries += 1;
      // A blocked program can produce no events at all — C, C++ and Java stop
      // before the first traced line — so the input flag is checked even when
      // there is nothing to build a model from.
      if (window.CodeFlow && typeof window.CodeFlow.needsInput === 'function' && window.CodeFlow.needsInput()) {
        window.clearInterval(poll);
        askForInput();
        return;
      }
      const model = buildModel();
      if (model && blockedOnInput(model.events)) {
        window.clearInterval(poll);
        askForInput();
        return;
      }
      if (model) { window.clearInterval(poll); mount(model); return; }
      if (tries > (attempts || 45)) {
        window.clearInterval(poll);
        toast('Still nothing to animate — check the code and run it once.');
      }
    }, 320);
  }

  // Opens the input dialog and animates the moment the program has its values.
  // Without this the user had to know that the prompt row feeds the program.
  function askForInput() {
    const opened = window.CodeFlow && typeof window.CodeFlow.openInputDialog === 'function'
      ? window.CodeFlow.openInputDialog() : false;
    toast(opened
      ? 'This program reads input — type the values, press Done, and it will animate.'
      : 'This program reads input — supply it in the terminal, then animate.');
    let tries = 0;
    const poll = window.setInterval(() => {
      tries += 1;
      const model = buildModel();
      if (model && !blockedOnInput(model.events) && model.events.length > 2) {
        window.clearInterval(poll);
        mount(model);
        return;
      }
      if (tries > 150) window.clearInterval(poll);
    }, 320);
  }

  function open() {
    // Checked first: a waiting program may have no trace at all, and replaying
    // "nothing" is exactly what looked broken.
    if (window.CodeFlow && typeof window.CodeFlow.needsInput === 'function' && window.CodeFlow.needsInput()) {
      askForInput();
      return;
    }
    const model = buildModel();
    if (model) {
      if (blockedOnInput(model.events)) { askForInput(); return; }
      mount(model);
      return;
    }
    // No trace yet — run the code and open as soon as one arrives. A disabled
    // button that only says "run first" reads as "the animation is broken".
    if (!window.CodeFlow || typeof window.CodeFlow.run !== 'function') {
      toast('The editor is still loading — try again in a moment.');
      return;
    }
    toast('Running your code…');
    window.CodeFlow.run();
    waitForRun(45);
  }

  function mount(model) {
    if (!root) build();
    state.model = model;
    state.speed = 1;
    els.speed.textContent = '1×';
    // Clear both the tracked columns and the DOM — otherwise opening a second
    // program reused the first one's cells.
    state.cells = [];
    state.varLast = {};
    els.cells.innerHTML = '';
    els.grid.innerHTML = '';
    els.grid.dataset.shape = '';
    els.grid.hidden = true;
    els.stack.innerHTML = '';
    els.stack.hidden = true;
    els.output.innerHTML = '';
    els.output.hidden = true;
    els.field.classList.remove('has-output', 'has-stack');

    els.title.textContent = titleFor(model);
    els.eyebrow.textContent = 'ANIMATION · ' + (model.language || 'code').toUpperCase();
    const detail = model.mode === 'array'
      ? '<span>' + model.final.length + ' items</span><span class="anim-badge-var">' + escapeHtml(model.key) + '</span>'
      : (model.mode === 'grid'
        ? '<span>' + model.rows + ' × ' + model.cols + ' table</span><span class="anim-badge-var">' + escapeHtml(model.key) + '</span>'
        : (model.mode === 'map'
        ? '<span>' + ((model.filled[model.filled.length - 1] || []).length) + ' keys</span><span class="anim-badge-var">' + escapeHtml(model.key) + '</span>'
        : (model.mode === 'vars'
          ? '<span>' + model.vars.length + ' variables</span>'
          : (model.mode === 'stack'
            ? '<span>' + model.depth + ' frames deep</span><span class="anim-badge-var">recursion</span>'
            : (model.mode === 'output'
              ? '<span>' + (model.output[model.output.length - 1] || []).length + ' lines</span>'
              : '<span>no values</span>')))));
    els.badges.innerHTML = '<span>' + model.events.length + ' steps</span>' + detail;

    renderCode();
    root.hidden = false;
    document.body.classList.add('anim-open');
    state.open = true;
    goTo(0, false);
    els.close.focus();
    // Start immediately — a static first frame is what makes people think the
    // animation is broken. Pause is one click away.
    if (model.events.length > 1) start();
  }

  function titleFor(model) {
    const label = (window.CodeFlow && window.CodeFlow.exampleTitle) ? window.CodeFlow.exampleTitle() : '';
    if (label) return label;
    return 'Animated run';
  }

  function close() {
    stop();
    state.open = false;
    if (root) root.hidden = true;
    document.body.classList.remove('anim-open');
  }

  function toast(message) {
    const node = document.getElementById('toast');
    if (!node) return;
    node.textContent = message;
    node.classList.add('is-visible');
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => node.classList.remove('is-visible'), 3200);
  }

  // One-click path from an example card: load it, run it, animate it. Without
  // this you had to know to open the visualizer and run the code first.
  function watch(key) {
    const loader = document.querySelector('[data-example="' + key + '"]');
    if (loader) loader.click();
    window.setTimeout(() => {
      const editor = document.getElementById('code-editor');
      const wanted = (editor ? editor.value : '').trim();
      if (!window.CodeFlow || typeof window.CodeFlow.run !== 'function') return;
      window.CodeFlow.run();
      let tries = 0;
      const poll = window.setInterval(() => {
        tries += 1;
        const snap = window.CodeFlow.snapshot();
        const source = String(snap.source || '').trim();
        if (snap.events && snap.events.length && source === wanted) {
          window.clearInterval(poll);
          const model = buildModel();
          if (model) mount(model);
          return;
        }
        if (tries > 45) {
          window.clearInterval(poll);
          toast('That example did not produce a trace.');
        }
      }, 320);
    }, 260);
  }

  function wire() {
    const button = document.getElementById('animate-button');
    if (button) {
      button.addEventListener('click', open);
      // Never disabled: if there is no trace yet, clicking runs the code first.
      // A greyed-out button was the reason this looked broken on first visit.
      button.disabled = false;
      const sync = () => {
        const ready = !!(window.CodeFlow && window.CodeFlow.hasTrace && window.CodeFlow.hasTrace());
        button.title = ready ? 'Replay this run step by step' : 'Runs your code, then replays it';
      };
      sync();
      window.setInterval(sync, 1500);
    }

    document.addEventListener('click', (event) => {
      const link = event.target.closest ? event.target.closest('[data-animate]') : null;
      if (!link) return;
      event.preventDefault();
      watch(link.dataset.animate);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire, { once: true });
  } else {
    wire();
  }
})();
