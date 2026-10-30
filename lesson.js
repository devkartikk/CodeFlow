// Voice lesson: steps through an execution trace, narrating each step aloud
// while animating the code, variables and call stack.
//
// Every sentence is built from the trace data only. If the debugger did not
// report a value, the narration says so instead of inventing one.

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  const KEYWORDS = {
    python: ['def', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not', 'and', 'or', 'import', 'from', 'as', 'class', 'try', 'except', 'finally', 'with', 'lambda', 'yield', 'pass', 'break', 'continue', 'is', 'None', 'True', 'False', 'print', 'range', 'len', 'global', 'nonlocal'],
    javascript: ['function', 'return', 'if', 'else', 'for', 'while', 'const', 'let', 'var', 'class', 'new', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'of', 'in', 'await', 'async', 'true', 'false', 'null', 'undefined', 'console', 'import', 'export', 'default'],
    java: ['public', 'private', 'protected', 'static', 'final', 'class', 'void', 'int', 'long', 'double', 'float', 'boolean', 'char', 'String', 'new', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'throws', 'extends', 'implements', 'interface', 'package', 'import', 'this', 'super', 'true', 'false', 'null', 'System'],
    c: ['include', 'define', 'int', 'char', 'float', 'double', 'void', 'long', 'short', 'unsigned', 'signed', 'const', 'static', 'struct', 'typedef', 'enum', 'union', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'sizeof', 'NULL', 'printf', 'scanf', 'malloc', 'free'],
    cpp: ['include', 'using', 'namespace', 'std', 'int', 'char', 'float', 'double', 'void', 'long', 'short', 'unsigned', 'signed', 'const', 'static', 'struct', 'class', 'public', 'private', 'protected', 'template', 'typename', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'delete', 'nullptr', 'true', 'false', 'cout', 'cin', 'endl', 'vector', 'string']
  };

  const state = {
    open: false,
    index: 0,
    playing: false,
    voice: true,
    rate: 1,
    // 'en' or 'hi' — the narration language. Captions and speech both follow it.
    narration: 'en',
    events: [],
    source: '',
    language: 'python',
    token: 0,
    typing: null,
    guard: null,
    chosenVoice: null,
    // Full program output, used as the rendered text when no per-step event
    // carries its own `output` (C/C++/Java and any language whose tracer does
    // not attribute output to a line).
    outputLines: [],
    stderrLines: []
  };

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  }

  function highlight(code, language) {
    const keywords = KEYWORDS[language] || KEYWORDS.python;
    let out = '';
    let i = 0;
    const n = code.length;
    const wrap = (cls, text) => `<span class="tok-${cls}">${escapeHtml(text)}</span>`;
    while (i < n) {
      const ch = code[i];
      const two = code.slice(i, i + 2);
      if (two === '//' || (ch === '#' && language === 'python')) {
        let j = code.indexOf('\n', i);
        if (j === -1) j = n;
        out += wrap('com', code.slice(i, j));
        i = j;
        continue;
      }
      if (two === '/*') {
        let j = code.indexOf('*/', i + 2);
        j = j === -1 ? n : j + 2;
        out += wrap('com', code.slice(i, j));
        i = j;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        let j = i + 1;
        while (j < n) {
          if (code[j] === '\\') { j += 2; continue; }
          if (code[j] === ch) { j += 1; break; }
          j += 1;
        }
        out += wrap('str', code.slice(i, j));
        i = j;
        continue;
      }
      if (/[0-9]/.test(ch)) {
        let j = i;
        while (j < n && /[0-9a-fA-FxX._]/.test(code[j])) j += 1;
        out += wrap('num', code.slice(i, j));
        i = j;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_$]/.test(code[j])) j += 1;
        const word = code.slice(i, j);
        if (keywords.indexOf(word) !== -1) out += wrap('kw', word);
        else if (code[j] === '(') out += wrap('fn', word);
        else out += escapeHtml(word);
        i = j;
        continue;
      }
      out += escapeHtml(ch);
      i += 1;
    }
    return out;
  }

  function spoken(code) {
    const text = String(code);
    // Hinglish keeps the words Roman on screen; they are transliterated for
    // speech later, so the operators must already be Hinglish here.
    if (state.narration === 'hi') {
      // Hinglish puts the limit before the comparison ("i 3 se chhota hai"),
      // the opposite of the English word order, so comparisons are reordered
      // as a whole rather than word by word.
      const compare = text.trim().match(/^([A-Za-z_]\w*)\s*(<=|>=|==|!=|<|>)\s*(.+)$/);
      if (compare) {
        const words = {
          '<=': 'se chhota ya barabar', '>=': 'se bada ya barabar',
          '<': 'se chhota', '>': 'se bada',
          '==': 'ke barabar', '!=': 'ke barabar nahi'
        };
        return `${compare[1]} ${compare[3].trim()} ${words[compare[2]]}`;
      }
      return text
        .replace(/<<=/g, ' shift left ')
        .replace(/>>=/g, ' shift right ')
        .replace(/<</g, ' output ')
        .replace(/>>/g, ' input ')
        .replace(/==/g, ' barabar barabar ')
        .replace(/!=/g, ' barabar nahi ')
        .replace(/<=/g, ' se chhota ya barabar ')
        .replace(/>=/g, ' se bada ya barabar ')
        .replace(/\+/g, ' plus ')
        .replace(/-/g, ' minus ')
        .replace(/\*/g, ' guna ')
        .replace(/\//g, ' bhaag ')
        .replace(/%/g, ' mod ')
        .replace(/=/g, ' barabar ')
        .replace(/[{}]/g, '')
        .replace(/"/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    return text
      .replace(/<<=/g, ' shift left by ')
      .replace(/>>=/g, ' shift right by ')
      .replace(/<</g, ' outputs ')
      .replace(/>>/g, ' reads ')
      .replace(/==/g, ' equals equals ')
      .replace(/!=/g, ' is not equal to ')
      .replace(/<=/g, ' is at most ')
      .replace(/>=/g, ' is at least ')
      // Symbol names that a speech engine either spells out or mangles.
      .replace(/\bcout\b/g, 'C out')
      .replace(/\bcin\b/g, 'C in')
      .replace(/\bcerr\b/g, 'C err')
      .replace(/\bendl\b/g, 'end line')
      .replace(/\+/g, ' plus ')
      .replace(/[-*\/%]/g, (m) => ({ '-': ' minus ', '*': ' times ', '/': ' divided by ', '%': ' modulo ' }[m]))
      .replace(/=/g, ' equals ')
      // Quote marks are punctuation for the eye, noise for the ear.
      .replace(/"/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Split an expression at top level only, so a separator inside a string
  // literal ("Hello, world") or inside a nested call (f(a, b)) does not tear
  // the argument list apart.
  function splitOn(expression, separators) {
    const parts = [];
    let current = '';
    let quote = null;
    let depth = 0;
    const text = String(expression || '');
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        current += char;
        if (char === '\\') { current += text[index + 1] || ''; index += 1; continue; }
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") { quote = char; current += char; continue; }
      if (char === '(' || char === '[' || char === '{') { depth += 1; current += char; continue; }
      if (char === ')' || char === ']' || char === '}') { depth = Math.max(0, depth - 1); current += char; continue; }
      const two = text.slice(index, index + 2);
      if (depth === 0 && separators.indexOf(two) !== -1) { parts.push(current.trim()); current = ''; index += 1; continue; }
      if (depth === 0 && separators.indexOf(char) !== -1) { parts.push(current.trim()); current = ''; continue; }
      current += char;
    }
    parts.push(current.trim());
    return parts.filter(Boolean);
  }

  // Narration language packs. Hinglish stays in Roman script and keeps the
  // English the learner already sees on screen (variable names, print, input),
  // so nothing has to be transliterated or read out letter by letter.
  const PACKS = {
    en: {
      emptyCaption: 'Nothing to show.',
      running: 'Running your code first…',
      noSteps: 'This program produced no steps to walk through. Check the diagnostics panel.',
      start: 'The program starts running.',
      stepInto: (fn) => `We step into ${fn}.`,
      receives: (list) => `It receives ${list}.`,
      returnsValue: (fn, value) => `${fn} returns ${value}.`,
      finishes: (fn) => `${fn} finishes.`,
      finishesEmpty: (fn) => `${fn} finishes without returning a value.`,
      unwinds: (fn) => `${fn} leaves because an error is propagating.`,
      errorHere: (detail) => `An error is raised here${detail ? `: ${detail}` : ''}.`,
      programPrints: (value) => `The program prints ${value}.`,
      programWrites: 'The program writes some output.',
      lineIn: (line, fn) => `Line ${line}${fn ? ` in ${fn}` : ''}.`,
      thisLine: (described) => `This line ${described}.`,
      lineIs: (source) => `The line is: ${source}.`,
      lineSays: (source) => `The line says: ${source}.`,
      itSays: (source) => `It says ${source}.`,
      atStart: (list) => `Right at the start, ${list}.`,
      sincePrevious: (list) => `Since the previous step, ${list}.`,
      becomes: (name, value) => `${name} becomes ${value}`,
      isGone: (name) => `${name} is gone`,
      equals: (name, value) => `${name} equals ${value}`,
      blankLineNote: (line) => `Line ${line} is blank.`,
      blankLineWhy: 'Blank lines only separate blocks, so the debugger never stops here.',
      neverRan: 'The program never reached this line, so it never ran.',
      ranTimes: (count) => `It ran ${count} time${count === 1 ? '' : 's'}.`,
      insideFn: (fn) => `That is inside ${fn}.`,
      afterLine: (list) => `After this line runs, ${list}.`,
      noChanges: 'No variable changes on this line.',
      notInScope: (name) => `${name} is no longer in scope`,
      isValue: (name, value) => `${name} is ${value}`,
      printsBody: (body, newline) => `prints ${body}${newline ? ', then starts a new line' : ''}`,
      printfLine: (head, values, newline) => `prints ${head}${values ? `, filled in with ${values}` : ''}${newline ? ', then starts a new line' : ''}`,
      forLoop: (parts) => `runs a loop: ${parts}`,
      loopStart: (name, value) => `${name} starts at ${value}`,
      loopWhile: (condition) => `keeps going while ${condition}`,
      loopStep: (name, value, direction) => `${name} goes ${direction} by ${value} each round`,
      writesError: (body, newline) => `writes an error: ${body}${newline ? ', then starts a new line' : ''}`,
      readsInto: (list) => `reads ${list} from the keyboard`,
      intoValue: (name) => `a value into ${name}`,
      readsValue: 'reads a value from the keyboard',
      readsTyped: 'reads what the user types on the keyboard',
      readsLine: 'reads a line typed by the user',
      asksLine: 'asks the user to type a line',
      printText: (label) => `the text ${label}`,
      aLine: 'a line',
      filledWith: (values) => `, filled in with ${values}`,
      toConsole: ' to the console',
      valueOf: (value) => `the value ${value}`,
      textOf: (value) => `the text ${value}`,
      emptyString: 'an empty string',
      blankLine: 'a blank line',
      nothingWord: 'nothing',
      and: 'and',
      theFunction: 'The function',
      blockOpen: 'opens a block',
      blockClose: 'closes a block',
      unwindsNone: 'The error leaves the program.',
      headStep: 'This step',
      headVars: 'Variables',
      headStack: 'Call stack',
      headOutput: 'Output',
      emptyVars: 'Nothing in scope yet',
      emptyStack: 'No frames reported',
      emptyOutput: 'Nothing printed yet',
      stepSeq: (index, total, line) => `Step ${index} of ${total}${line ? ` · line ${line}` : ''}`,
      summary: (total) => `That is the whole program: ${total} step${total === 1 ? '' : 's'} from start to finish.`
    },
    hi: {
      emptyCaption: 'Dikhane ke liye kuch nahi hai.',
      running: 'Pehle aapka code chala rahe hain…',
      noSteps: 'Is program se koi step nahi mila. Diagnostics panel dekho.',
      start: 'Program chalna shuru hota hai.',
      stepInto: (fn) => `Hum ${fn} ke andar jaate hain.`,
      receives: (list) => `Isko ${list} milte hain.`,
      returnsValue: (fn, value) => `${fn} ${value} return karta hai.`,
      finishes: (fn) => `${fn} khatam ho jaata hai.`,
      finishesEmpty: (fn) => `${fn} bina koi value return kiye khatam hota hai.`,
      unwinds: (fn) => `${fn} se error bahar ja raha hai, isliye wo nikal jaata hai.`,
      errorHere: (detail) => `Yahan error aata hai${detail ? `: ${detail}` : ''}.`,
      programPrints: (value) => `Program ${value} print karta hai.`,
      programWrites: 'Program kuch output likhta hai.',
      lineIn: (line, fn) => `Line ${line}${fn ? `, ${fn} ke andar` : ''}.`,
      thisLine: (described) => `Ye line ${lineFeminine(described)}.`,
      lineIs: (source) => `Line hai: ${source}.`,
      lineSays: (source) => `Line kehti hai: ${source}.`,
      itSays: (source) => `Ye likha hai: ${source}.`,
      atStart: (list) => `Shuru me hi, ${list}.`,
      sincePrevious: (list) => `Pichle step se, ${list}.`,
      becomes: (name, value) => `${name} ab ${value} ho gaya`,
      isGone: (name) => `${name} scope se hat gaya`,
      equals: (name, value) => `${name} barabar ${value}`,
      blankLineNote: (line) => `Line ${line} khaali hai.`,
      blankLineWhy: 'Khaali lines sirf blocks ko alag karti hain, isliye debugger yahan rukta nahi.',
      neverRan: 'Program kabhi is line tak pahuncha hi nahi, isliye ye chali bhi nahi.',
      ranTimes: (count) => `Ye ${count} baar chali.`,
      insideFn: (fn) => `Ye ${fn} ke andar hai.`,
      afterLine: (list) => `Is line ke chalne ke baad, ${list}.`,
      noChanges: 'Is line pe koi variable nahi badla.',
      notInScope: (name) => `${name} ab scope me nahi hai`,
      isValue: (name, value) => `${name} ki value ${value} hai`,
      printsBody: (body, newline) => `${body} print karta hai${newline ? ', phir nayi line shuru karta hai' : ''}`,
      // `printf` puts the placeholder first and the value after it, so the
      // Hinglish version has to keep the value phrase after the verb instead
      // of gluing it to the noun.
      printfLine: (head, values, newline) => `${head} print karta hai${values ? `, jisme ${values} ki value bharti hai` : ''}${newline ? ', phir nayi line shuru karta hai' : ''}`,
      forLoop: (parts) => `ek loop chalati hai: ${parts}`,
      loopStart: (name, value) => `${name} ${value} se shuru hota hai`,
      loopWhile: (condition) => `jab tak ${condition} hai`,
      loopStep: (name, value, direction) => `aur har baar ${name} ${value} ${direction === 'up' ? 'badhta hai' : 'ghatata hai'}`,
      writesError: (body, newline) => `error likhta hai: ${body}${newline ? ', phir nayi line shuru karta hai' : ''}`,
      readsInto: (list) => `keyboard se ${list} padhta hai`,
      intoValue: (name) => `${name} me ek value`,
      readsValue: 'keyboard se ek value padhta hai',
      readsTyped: 'jo user keyboard pe type karta hai, wo padhta hai',
      readsLine: 'user ke type ki hui line padhta hai',
      asksLine: 'user se ek line type karne ko kehta hai',
      printText: (label) => `text ${label}`,
      aLine: 'ek line',
      filledWith: (values) => `, jisme ${values} bhari jaati hain`,
      toConsole: ' console pe',
      valueOf: (value) => `value ${value}`,
      textOf: (value) => `text ${value}`,
      emptyString: 'khaali string',
      blankLine: 'ek khaali line',
      nothingWord: 'kuch nahi',
      and: 'aur',
      theFunction: 'Ye function',
      blockOpen: 'block kholta hai',
      blockClose: 'block band karta hai',
      unwindsNone: 'Error bahar ja raha hai, isliye program nikal jaata hai.',
      headStep: 'Ye step',
      headVars: 'Variables',
      headStack: 'Call stack',
      headOutput: 'Output',
      emptyVars: 'Abhi scope me kuch nahi',
      emptyStack: 'Koi frame nahi mila',
      emptyOutput: 'Abhi kuch print nahi hua',
      stepSeq: (index, total, line) => `Step ${index} / ${total}${line ? ` · line ${line}` : ''}`,
      summary: (total) => `Bas, poora program yahi hai: shuru se end tak ${total} steps.`
    }
  };

  function langPack() {
    return PACKS[state.narration] || PACKS.en;
  }

  // "Line" is feminine in Hindi, but the verb phrases are built for a
  // masculine subject ("print karta hai"). Flip the verb so the sentence
  // agrees with the line it is describing.
  function lineFeminine(text) {
    return String(text || '')
      .replace(/\bkarta hai\b/g, 'karti hai')
      .replace(/\bpadhta hai\b/g, 'padhti hai')
      .replace(/\blikhta hai\b/g, 'likhti hai')
      .replace(/\bkehta hai\b/g, 'kehti hai')
      .replace(/\bjaata hai\b/g, 'jaati hai');
  }

  function speakValue(part, p) {
    const pack = p || langPack();
    const literal = String(part).match(/^"([\s\S]*)"$/);
    if (literal) {
      const text = literal[1].replace(/\\n/g, ' ').replace(/\\t/g, ' ').trim();
      return text ? pack.textOf(text) : pack.emptyString;
    }
    return pack.valueOf(spoken(part));
  }

  function listPhrase(items, p) {
    if (!items.length) return '';
    const pack = p || langPack();
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} ${pack.and} ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, ${pack.and} ${items[items.length - 1]}`;
  }

  function describeStream(expression, kind, p) {
    const pack = p || langPack();
    const parts = splitOn(expression, ['<<']);
    const newline = parts.some((part) => /^endl$/.test(part) || /^"\\n"$/.test(part));
    const values = parts.filter((part) => !/^endl$/.test(part) && !/^"\\n"$/.test(part));
    const body = values.length ? listPhrase(values.map((value) => speakValue(value, pack)), pack) : pack.nothingWord;
    return kind === 'error' ? pack.writesError(body, newline) : pack.printsBody(body, newline);
  }

  // Reading `cout << total << endl;` aloud as "C out outputs total outputs end
  // line" teaches nothing. Recognise the input/output idioms and say what they
  // do, in the language the reader actually chose.
  // A `for` header read out loud is a run of punctuation ("i plus plus"), which
  // says nothing about what the loop does. Describe it instead: where the
  // counter starts, when the loop keeps going, and how the counter moves.
  function describeFor(header, pack) {
    const parts = splitOn(header, [';']);
    if (parts.length !== 3) return '';
    const [init, condition, step] = parts;
    const start = init.match(/^(?:[A-Za-z_][\w<>\[\]]*\s+)?([A-Za-z_]\w*)\s*=\s*(.+)$/);
    const test = /^[A-Za-z_]\w*\s*(?:<=|>=|==|!=|<|>)/.test(condition);
    const up = step.match(/^([A-Za-z_]\w*)\s*\+\+$/)
      || step.match(/^([A-Za-z_]\w*)\s*\+=\s*(.+)$/)
      || step.match(/^([A-Za-z_]\w*)\s*=\s*\1\s*\+\s*(.+)$/);
    const down = step.match(/^([A-Za-z_]\w*)\s*--$/)
      || step.match(/^([A-Za-z_]\w*)\s*-=\s*(.+)$/)
      || step.match(/^([A-Za-z_]\w*)\s*=\s*\1\s*-\s*(.+)$/);

    const bits = [];
    if (start) bits.push(pack.loopStart(start[1], start[2].trim()));
    if (test) bits.push(pack.loopWhile(spoken(condition)));
    if (up) bits.push(pack.loopStep(up[1], (up[2] || '1').trim(), 'up'));
    else if (down) bits.push(pack.loopStep(down[1], (down[2] || '1').trim(), 'down'));
    // Two facts is the minimum that makes a sentence worth saying; anything
    // less and the raw reading is just as clear.
    if (bits.length < 2) return '';
    return pack.forLoop(bits.join(', '));
  }

  function describeLine(code, language, p) {
    const pack = p || langPack();
    const text = String(code || '').trim().replace(/;$/, '').trim();
    if (!text) return '';

    const loop = text.match(/^for\s*\(([\s\S]*)\)\s*\{?$/);
    if (loop && ['c', 'cpp', 'java', 'javascript'].includes(language)) {
      const described = describeFor(loop[1], pack);
      if (described) return described;
    }

    if (language === 'cpp') {
      // `std::cout` is the same stream as `cout`; without this the line falls
      // through to the raw reading and comes out as "std::cout output Total".
      const plain = text.replace(/\bstd::/g, '');
      if (/^cout\s*<</.test(plain)) return describeStream(plain.replace(/^cout\s*<</, ''), 'print', pack);
      if (/^cerr\s*<</.test(plain)) return describeStream(plain.replace(/^cerr\s*<</, ''), 'error', pack);
      if (/^cin\s*>>/.test(plain)) {
        const targets = splitOn(plain.replace(/^cin\s*>>/, ''), ['>>']);
        return pack.readsInto(listPhrase(targets.map((target) => pack.intoValue(spoken(target))), pack));
      }
    }

    if (language === 'c' || language === 'cpp') {
      const printf = text.match(/^printf\s*\(([\s\S]*)\)$/);
      if (printf) {
        const args = splitOn(printf[1], [',']);
        const literal = String(args[0] || '').match(/^"([\s\S]*)"$/);
        // `%d` and friends are placeholders, not words to read out.
        const label = literal
          ? literal[1].replace(/%[-+ 0#]*\d*(?:\.\d+)?[diouxXeEfgGcs]/g, ' ').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim()
          : '';
        const values = args.slice(1);
        const newline = literal ? /\\n/.test(literal[1]) : false;
        const body = label ? pack.printText(label) : pack.aLine;
        const head = (values.length || label) ? body : pack.nothingWord;
        const valuesPhrase = values.length ? listPhrase(values.map(spoken), pack) : '';
        return pack.printfLine(head, valuesPhrase, newline);
      }
      const scanf = text.match(/^scanf\s*\(([\s\S]*)\)$/);
      if (scanf) {
        const targets = splitOn(scanf[1], [',']).slice(1).map((arg) => spoken(arg.replace(/^&/, '')));
        return targets.length
          ? pack.readsInto(listPhrase(targets.map((target) => pack.intoValue(target)), pack))
          : pack.readsValue;
      }
    }

    if (language === 'java') {
      const out = text.match(/^System\.out\.(println|print|printf)\s*\(([\s\S]*)\)$/);
      if (out) {
        // `println("Total: " + total)` is two values joined for the compiler,
        // not one expression, so read both parts instead of "value Total plus total".
        const separators = out[1] === 'printf' ? [','] : [',', '+'];
        const body = listPhrase(splitOn(out[2], separators).map((value) => speakValue(value, pack)), pack) || pack.blankLine;
        return pack.printsBody(body, out[1] === 'println');
      }
      if (/\.next(Int|Long|Double|Line|Boolean)?\s*\(\)/.test(text)) return pack.readsTyped;
    }

    if (language === 'python') {
      const print = text.match(/^print\s*\(([\s\S]*)\)$/);
      if (print) {
        const body = listPhrase(splitOn(print[1], [',']).map((value) => speakValue(value, pack)), pack) || pack.blankLine;
        return pack.printsBody(body, false);
      }
      if (/\binput\s*\(/.test(text)) return pack.readsLine;
    }

    if (language === 'javascript') {
      const log = text.match(/^console\.(log|info|warn|error)\s*\(([\s\S]*)\)$/);
      if (log) {
        const body = listPhrase(splitOn(log[2], [',']).map((value) => speakValue(value, pack)), pack) || pack.blankLine;
        return pack.printsBody(body + pack.toConsole, false);
      }
      if (/\b(prompt|readline)\s*\(/.test(text)) return pack.asksLine;
    }

    // A bare brace has no words to read, so say what it does instead of
    // leaving the caption as "the line says:" with nothing after it.
    if (/^\}+$/.test(text)) return pack.blockClose;
    if (/^\{+$/.test(text)) return pack.blockOpen;

    return '';
  }

  function readable(value) {
    if (value === undefined) return 'unknown';
    if (value === null) return 'nothing';
    if (typeof value === 'string') return value;
    try {
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch (_) {
      return String(value);
    }
  }

  function diff(previous, event) {
    const before = (previous && previous.variables) || {};
    const current = (event && event.variables) || {};
    const names = new Set([...Object.keys(before), ...Object.keys(current)]);
    const changes = [];
    names.forEach((name) => {
      const a = before[name];
      const b = current[name];
      if (JSON.stringify(a) === JSON.stringify(b)) return;
      changes.push({ name, after: b, removed: !Object.prototype.hasOwnProperty.call(current, name) });
    });
    return changes;
  }

  function buildCaption(index) {
    const pack = langPack();
    const event = state.events[index];
    const display = [];
    const speech = [];
    const push = (text, say) => { display.push(text); speech.push(say === undefined ? text : say); };
    if (!event) return { text: pack.emptyCaption, speech: pack.emptyCaption };

    const type = String(event.type || 'line').toLowerCase();
    const fn = event.function && event.function !== '<module>' ? event.function : null;
    const line = Number(event.line);
    const hasLine = Number.isInteger(line) && line > 0;
    const sourceLine = hasLine ? (state.source.split('\n')[line - 1] || '').trim() : '';
    const changes = diff(index > 0 ? state.events[index - 1] : null, event);

    if (type === 'call') {
      push(fn ? pack.stepInto(fn) : pack.start);
      const args = Object.entries(event.variables || {}).slice(0, 3);
      if (args.length) {
        push(pack.receives(args.map(([name, value]) => `${name} = ${readable(value)}`).join(', ')),
             pack.receives(args.map(([name, value]) => pack.equals(name, readable(value))).join(', ')));
      }
    } else if (type === 'return') {
      if (event.unwound) {
        push(fn ? pack.unwinds(fn) : pack.unwindsNone);
      } else if (event.return_value === undefined) {
        push(pack.finishes(fn || pack.theFunction));
      } else if (event.return_value === null) {
        push(pack.finishesEmpty(fn || pack.theFunction));
      } else {
        push(pack.returnsValue(fn || pack.theFunction, readable(event.return_value)));
      }
    } else if (type === 'exception' || type === 'error') {
      push(pack.errorHere(event.exception ? String(event.exception) : ''));
    } else if (type === 'stdout' || type === 'output') {
      const output = event.output !== undefined ? event.output : event.value;
      push(output === undefined ? pack.programWrites : pack.programPrints(readable(output)));
    } else {
      if (hasLine) push(pack.lineIn(line, fn));
      if (sourceLine) {
        const described = describeLine(sourceLine, state.language, pack);
        if (described) push(pack.thisLine(described));
        else push(pack.lineIs(sourceLine), pack.lineSays(spoken(sourceLine)));
      }
      if (changes.length) {
        const shown = changes.slice(0, 2);
        const joiner = `, ${pack.and} `;
        if (index === 0) {
          push(pack.atStart(shown.map((c) => `${c.name} = ${readable(c.after)}`).join(joiner)),
               pack.atStart(shown.map((c) => pack.equals(c.name, readable(c.after))).join(joiner)));
        } else {
          const phrase = shown.map((c) => (c.removed ? pack.isGone(c.name) : pack.becomes(c.name, readable(c.after)))).join(joiner);
          push(pack.sincePrevious(phrase));
        }
      }
    }
    return { text: display.join(' '), speech: speech.join(' ') };
  }

  // Everything said about a single clicked line is derived from the trace:
  // how often the line ran, which function it ran in, and what changed there.
  function buildLineExplanation(line) {
    const pack = langPack();
    const display = [];
    const speech = [];
    const push = (text, say) => { display.push(text); speech.push(say === undefined ? text : say); };
    const sourceLine = (state.source.split('\n')[line - 1] || '').trim();

    if (!sourceLine) {
      push(pack.blankLineNote(line));
      push(pack.blankLineWhy);
      return { text: display.join(' '), speech: speech.join(' ') };
    }

    const described = describeLine(sourceLine, state.language, pack);
    // On screen the raw line is useful; in speech it would be read twice, so
    // the sentence that describes it carries the audio instead.
    push(`Line ${line}: ${sourceLine}`, pack.lineSays(spoken(sourceLine)));
    if (described) push(pack.thisLine(described));
    else push(pack.itSays(sourceLine), pack.lineSays(spoken(sourceLine)));

    const hits = [];
    state.events.forEach((event, position) => {
      if (Number(event.line) === line) hits.push({ event, position });
    });

    if (!hits.length) {
      push(pack.neverRan);
      return { text: display.join(' '), speech: speech.join(' ') };
    }

    push(pack.ranTimes(hits.length));

    const frame = hits.find((hit) => hit.event.function && hit.event.function !== '<module>');
    if (frame) push(pack.insideFn(frame.event.function));

    const changes = new Map();
    hits.forEach((hit) => {
      const previous = hit.position > 0 ? state.events[hit.position - 1] : null;
      const before = (previous && previous.variables) || {};
      diff(previous, hit.event).forEach((change) => {
        if (change.removed) { changes.set(change.name, { kind: 'gone' }); return; }
        const had = Object.prototype.hasOwnProperty.call(before, change.name);
        // A name can show up as "changed" simply because the previous step was
        // paused before the declaration ran. Only claim a change when the
        // value actually differs.
        if (had && JSON.stringify(before[change.name]) === JSON.stringify(change.after)) {
          changes.delete(change.name);
          return;
        }
        changes.set(change.name, { kind: 'set', value: change.after });
      });
    });

    if (changes.size) {
      // Every tracer reports the moment *before* a line runs, so the values at
      // the last visit are the values going in. The step after it is the value
      // coming out, which is what "after this line" should mean.
      const next = state.events[hits[hits.length - 1].position + 1];
      const after = (next && next.variables) || {};
      const list = Array.from(changes.entries()).slice(0, 3);
      const phrase = list.map(([name, change]) => {
        if (change.kind === 'gone') return pack.notInScope(name);
        const value = Object.prototype.hasOwnProperty.call(after, name) ? after[name] : change.value;
        return pack.isValue(name, readable(value));
      }).join(`, ${pack.and} `);
      push(pack.afterLine(phrase));
    } else {
      push(pack.noChanges);
    }

    return { text: display.join(' '), speech: speech.join(' ') };
  }

  async function explainLine(line) {
    if (!Number.isInteger(line) || line < 1) return;
    stop();
    // Jump to the last time this line runs, so the variables panel shows the
    // state the sentence talks about ("after this line runs, total is 10").
    let target = -1;
    state.events.forEach((event, position) => {
      if (Number(event.line) === line) target = position;
    });
    if (target >= 0) showStep(target);
    else markLine(line);

    const explanation = buildLineExplanation(line);
    const element = $('lesson-caption');
    if (element) {
      element.classList.remove('done');
      element.textContent = '';
    }
    const token = state.token;
    await Promise.all([typeCaption(explanation.text, token), speak(explanation.speech, token)]);
    if (element && token === state.token) element.classList.add('done');
  }

  function buildCode() {
    const container = $('lesson-code');
    if (!container) return;
    const lines = state.source.split('\n');
    // Each line is a real button, so it is reachable by keyboard and announces
    // itself as "explain line N" instead of being a silent div.
    container.innerHTML = lines.map((text, index) => (
      `<button type="button" class="lesson-line" data-line="${index + 1}" aria-label="Explain line ${index + 1}"><span class="ln">${index + 1}</span><code>${highlight(text, state.language) || ' '}</code></button>`
    )).join('');
  }

  function markLine(line) {
    const container = $('lesson-code');
    if (!container) return;
    Array.from(container.children).forEach((child) => {
      const isActive = Number(child.dataset.line) === line;
      child.classList.toggle('active', isActive);
      child.classList.toggle('dim', line > 0 && !isActive);
    });
    const active = container.querySelector('.lesson-line.active');
    if (active) {
      const top = active.offsetTop - container.clientHeight / 2 + active.clientHeight / 2;
      container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }

  function renderVariables(event) {
    const container = $('lesson-vars');
    const count = $('lesson-var-count');
    if (!container) return;
    const variables = (event && event.variables) || {};
    const entries = Object.entries(variables);
    if (count) count.textContent = String(entries.length);
    if (!entries.length) {
      container.innerHTML = `<div class="lesson-empty">${escapeHtml(langPack().emptyVars)}</div>`;
      return;
    }
    const previous = state.index > 0 ? state.events[state.index - 1] : null;
    const changed = new Set(diff(previous, event).map((change) => change.name));
    container.innerHTML = entries.map(([name, value]) => (
      `<div class="lesson-var${changed.has(name) ? ' changed' : ''}"><b>${escapeHtml(name)}</b><code>${escapeHtml(readable(value))}</code></div>`
    )).join('');
  }

  function renderStack(event) {
    const container = $('lesson-stack');
    if (!container) return;
    const frames = (event && event.call_stack) || [];
    if (!frames.length) {
      container.innerHTML = `<div class="lesson-empty">${escapeHtml(langPack().emptyStack)}</div>`;
      return;
    }
    container.innerHTML = frames.slice().reverse().map((frame, index) => (
      `<div class="lesson-frame${index === 0 ? ' current' : ''}" style="animation-delay:${index * 40}ms"><i>${index === 0 ? '▸' : '↳'}</i>${escapeHtml(frame)}</div>`
    )).join('');
  }

  function renderOutput(event) {
    const container = $('lesson-output');
    if (!container) return;
    // Does any tracer in this run attribute output to a specific line? Python
    // and the offline fallback emit a `stdout` event carrying `output`; C/C++/
    // Java and the live JS tracer only report output at the top level.
    const hasPerEventOutput = state.events.some((step) => step && step.output);
    if (hasPerEventOutput) {
      // Walk every event up to and including the current step and show the
      // text printed so far. Nothing appears until the first print, which is
      // accurate — the output builds up as the lesson plays.
      const pieces = [];
      for (let position = 0; position <= state.index && position < state.events.length; position += 1) {
        const step = state.events[position];
        const value = step && step.output;
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value)) pieces.push(...value);
        else pieces.push(String(value));
      }
      const text = pieces.join('');
      container.textContent = text || langPack().emptyOutput;
      container.classList.toggle('has-output', Boolean(text));
      return;
    }
    // No per-line output available: show the program's full output (and any
    // errors) so the panel is never silently empty.
    const full = [...state.outputLines, ...state.stderrLines.map((line) => `stderr: ${line}`)].join('\n');
    container.textContent = full || langPack().emptyOutput;
    container.classList.toggle('has-output', Boolean(full));
  }

  function renderStepInfo(event) {
    const type = $('lesson-step-type');
    const fn = $('lesson-step-fn');
    const seq = $('lesson-step-seq');
    if (type) type.textContent = String((event && event.type) || 'step');
    if (fn) fn.textContent = (event && event.function) || '—';
    if (seq) {
      const line = Number(event && event.line);
      const where = Number.isInteger(line) && line > 0 ? line : 0;
      seq.textContent = langPack().stepSeq(state.index + 1, state.events.length, where);
    }
  }

  function updateProgress() {
    const total = state.events.length;
    const bar = $('lesson-bar');
    const count = $('lesson-count');
    if (bar) bar.style.width = total ? `${((state.index + 1) / total) * 100}%` : '0%';
    if (count) count.textContent = `${total ? state.index + 1 : 0} / ${total}`;
  }

  function showStep(index) {
    if (!state.events.length) return;
    state.index = Math.max(0, Math.min(state.events.length - 1, index));
    const event = state.events[state.index];
    const bridge = window.CodeFlow;
    if (bridge && bridge.goToStep) bridge.goToStep(state.index);
    markLine(Number(event.line));
    renderStepInfo(event);
    renderVariables(event);
    renderStack(event);
    renderOutput(event);
    updateProgress();
  }

  function setSpeaking(on) {
    const wave = $('lesson-wave');
    if (wave) wave.classList.toggle('speaking', Boolean(on));
  }

  function typeCaption(text, token) {
    return new Promise((resolve) => {
      const element = $('lesson-caption');
      if (!element) return resolve();
      window.clearInterval(state.typing);
      element.classList.remove('done');
      element.textContent = '';
      let cursor = 0;
      const perChar = Math.min(28, Math.max(9, 1800 / Math.max(1, text.length)));
      state.typing = window.setInterval(() => {
        if (token !== state.token) {
          window.clearInterval(state.typing);
          element.textContent = text;
          element.classList.add('done');
          resolve();
          return;
        }
        cursor += 1;
        element.textContent = text.slice(0, cursor);
        if (cursor >= text.length) {
          window.clearInterval(state.typing);
          element.classList.add('done');
          resolve();
        }
      }, perChar);
    });
  }

  // Voices are scored rather than simply matched on `lang`, because the first
  // one returned is often the worst-sounding system default. We favour the
  // high-quality engines (natural/neural/online) and the clearest accents, and
  // push compact/novelty voices to the bottom so the narration stays easy to
  // understand.
  function voiceScore(voice) {
    const lang = String(voice.lang || '').replace('_', '-');
    const name = String(voice.name || '');
    let score = 0;
    if (state.narration === 'hi') {
      // Hinglish is Roman script, so an Indian English voice pronounces the
      // Hindi words properly; a hi-IN engine would try to spell the Latin
      // letters out instead of reading them.
      if (/^en-IN/i.test(lang)) score += 95;
      else if (/^hi-IN/i.test(lang)) score += 40;
      else if (/^en-US/i.test(lang)) score += 45;
      else if (/^en-GB/i.test(lang)) score += 42;
      else if (/^en/i.test(lang)) score += 20;
      else score -= 200;
    } else if (/^en-US/i.test(lang)) score += 60;
    else if (/^en-GB/i.test(lang)) score += 55;
    else if (/^en-IN/i.test(lang)) score += 46;
    else if (/^en/i.test(lang)) score += 22;
    else score -= 200;
    if (/natural|neural|premium|enhanced/i.test(name)) score += 44;
    if (/online/i.test(name)) score += 30;
    if (/google/i.test(name)) score += 18;
    if (voice.default) score += 12;
    if (/microsoft|aria|zira|david|samantha|victoria|aaron|karen|moira|tessa|rishi|veena|allison|daniel/i.test(name)) score += 8;
    if (/compact|eloquence|novelty|whisper|bells|zarvox|albert|bad news|good news|jester|organ|superstar|trinoids|wobble|bubbles|cellos|fred|ralph/i.test(name)) score -= 60;
    return score;
  }

  // Hinglish is written in Roman letters on screen because that is how it is
  // read, but an English voice pronounces "pichle" as "pitch-lee". A Hindi
  // voice reads Devanagari correctly, so when one is installed we hand it the
  // same sentence transliterated. The vocabulary below is the entire set of
  // Hindi words the narration uses; anything else (identifiers, numbers) is
  // left in Latin and the Hindi voice says it the way Indians say it anyway.
  // Only the Hindi words are transliterated. Technical words — step, line,
  // value, program, print, return, error — stay in Latin on purpose, so the
  // Hindi voice says them in English, the way they are actually spoken in
  // Hinglish. Transliterating them ("स्टेप", "प्रिंट") sounds stilted.
  const DEVANAGARI = {
    dikhane: 'दिखाने', ke: 'के', liye: 'लिए', kuch: 'कुछ', nahi: 'नहीं', hai: 'है', hain: 'हैं',
    pehle: 'पहले', aapka: 'आपका', chala: 'चला', rahe: 'रहे', is: 'इस',
    se: 'से', koi: 'कोई', mila: 'मिला', dekho: 'देखो', chalna: 'चलना',
    shuru: 'शुरू', hota: 'होता', hoti: 'होती', hum: 'हम', andar: 'अंदर', jaate: 'जाते',
    isko: 'इसको', milte: 'मिलते', karta: 'करता', karti: 'करती',
    khatam: 'खतम', ho: 'हो', jaata: 'जाता', bina: 'बिना', kiye: 'किए',
    bahar: 'बाहर', ja: 'जा', raha: 'रहा', isliye: 'इसलिए', wo: 'वो', nikal: 'निकल',
    yahan: 'यहाँ', aata: 'आता', likhta: 'लिखता',
    ye: 'ये', kehti: 'कहती', likha: 'लिखा', me: 'में',
    mein: 'में', hi: 'ही', pichle: 'पिछले', ab: 'अब', gaya: 'गया',
    hat: 'हट', barabar: 'बराबर', khaali: 'खाली', sirf: 'सिर्फ',
    ko: 'को', alag: 'अलग', rukta: 'रुकता', kabhi: 'कभी', tak: 'तक',
    pahuncha: 'पहुँचा', chali: 'चली', bhi: 'भी', baar: 'बार', chalne: 'चलने', baad: 'बाद',
    pe: 'पे', badla: 'बदला', nayi: 'नई', phir: 'फिर',
    padhta: 'पढ़ता', ek: 'एक', jo: 'जो',
    ki: 'की', ka: 'का', hui: 'हुई', karne: 'करने',
    kehta: 'कहता', jisme: 'जिसमें', bhari: 'भरी', jaati: 'जाती', bharti: 'भरती',
    aur: 'और', bas: 'बस',
    poora: 'पूरा', diye: 'दिए', sahi: 'सही',
    chhota: 'छोटा', bada: 'बड़ा', ya: 'या', guna: 'गुणा', bhaag: 'भाग',
    kholta: 'खोलता', band: 'बंद', badhta: 'बढ़ता', ghatata: 'घटता',
    chalati: 'चलाती', jab: 'जब', har: 'हर'
    // Function and variable names are deliberately absent: they stay in Latin
    // so the Hindi voice says `main`, `greet`, `total` in English.
  };

  function toDevanagari(text) {
    return String(text || '')
      // `<function greet>` is a debugger notation, not something to read out.
      .replace(/[<>]/g, ' ')
      .replace(/[A-Za-z]+/g, (word) => DEVANAGARI[word.toLowerCase()] || word)
      .replace(/\s+/g, ' ')
      .trim();
  }

  // A Devanagari sentence needs a Devanagari voice. Without one we keep the
  // Roman text and let the best English voice try — that is still clearer than
  // a Hindi voice spelling out Latin letters.
  function hindiVoice() {
    if (!('speechSynthesis' in window)) return null;
    const voices = window.speechSynthesis.getVoices() || [];
    let best = null;
    let bestScore = -Infinity;
    voices.forEach((voice) => {
      const lang = String(voice.lang || '').replace('_', '-');
      if (!/^hi(-|$)/i.test(lang)) return;
      const name = String(voice.name || '');
      let score = 0;
      if (/natural|neural|premium|enhanced/i.test(name)) score += 40;
      if (/google/i.test(name)) score += 20;
      if (voice.default) score += 5;
      if (/compact|eloquence|novelty/i.test(name)) score -= 40;
      if (score > bestScore) { bestScore = score; best = voice; }
    });
    return best;
  }

  function speechText(text) {
    if (state.narration !== 'hi') return String(text || '');
    return hindiVoice() ? toDevanagari(text) : String(text || '');
  }

  function pickVoice() {
    if (!('speechSynthesis' in window)) return null;
    if (state.chosenVoice) return state.chosenVoice;
    // Hinglish is spoken from Devanagari, so it must use the Hindi voice that
    // can actually read it — an English voice would be given the wrong script.
    if (state.narration === 'hi') {
      const hindi = hindiVoice();
      if (hindi) { state.chosenVoice = hindi; return hindi; }
    }
    const voices = window.speechSynthesis.getVoices() || [];
    if (!voices.length) return null;
    let best = null;
    let bestScore = -Infinity;
    voices.forEach((voice) => {
      const score = voiceScore(voice);
      if (score > bestScore) { bestScore = score; best = voice; }
    });
    state.chosenVoice = bestScore > 0 ? best : null;
    return state.chosenVoice;
  }

  // Narration is split at sentence boundaries: the browser gives a natural
  // breath between utterances, and a single long utterance (Chrome cuts
  // anything past ~15 seconds) can no longer swallow the end of a sentence.
  function sentences(text) {
    const value = String(text || '');
    // Devanagari has no capital letters, so the usual "punctuation then space"
    // rule tears sentences apart at `!` inside a value ("Hello, world!").
    // Hinglish sentences are always closed with a full stop, so only that
    // counts as a boundary.
    if (state.narration === 'hi') {
      const parts = value.split(/(?<=[.?…])\s+/).map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
      return parts.length ? parts : [value.trim()].filter(Boolean);
    }
    const parts = value.match(/[^.!?…]+[.!?…]*/g) || [];
    const out = parts.map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return out.length ? out : [value.trim()].filter(Boolean);
  }

  function utter(text, token) {
    return new Promise((resolve) => {
      // Muting mid-sentence must not let the rest of the queue through.
      if (!state.voice || token !== state.token) { resolve(); return; }
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) window.clearTimeout(timer);
        resolve();
      };
      try {
        const utterance = new SpeechSynthesisUtterance(text);
        const voice = pickVoice();
        if (voice) {
          // A browser can hand back a voice the engine then refuses; that must
          // not silence the lesson, so fall back to the default voice. The
          // language is set separately because it is what makes the engine
          // pronounce Devanagari correctly even without the named voice.
          try {
            utterance.voice = voice;
          } catch (_) { /* keep the engine default voice */ }
          if (voice.lang) utterance.lang = voice.lang;
        }
        utterance.rate = 0.88 * state.rate;
        utterance.pitch = 1;
        utterance.volume = 1;
        utterance.onend = finish;
        utterance.onerror = finish;
        window.speechSynthesis.speak(utterance);
        // Some browsers never fire onend; this keeps the lesson moving.
        timer = window.setTimeout(finish, Math.max(4000, (text.length * 135) / Math.max(0.5, state.rate)));
      } catch (_) {
        finish();
      }
    });
  }

  async function speak(text, token) {
    if (!state.voice || !('speechSynthesis' in window) || !text) return;
    const engine = window.speechSynthesis;
    try {
      if (engine.speaking || engine.pending) engine.cancel();
      // Chrome drops the next utterance if speak() lands in the same tick as
      // cancel(), which is why the narration sometimes started mid-sentence.
      if (engine.speaking || engine.pending) await wait(60);
    } catch (_) { /* nothing to cancel */ }
    setSpeaking(true);
    const chunks = sentences(speechText(text));
    for (let index = 0; index < chunks.length; index += 1) {
      if (!state.voice || token !== state.token) break;
      await utter(chunks[index], token);
      if (!state.voice || token !== state.token) break;
      if (index < chunks.length - 1) await wait(110 / Math.max(0.6, state.rate));
    }
    setSpeaking(false);
  }

  async function present(index, token) {
    showStep(index);
    const caption = buildCaption(state.index);
    const typing = typeCaption(caption.text, token);
    const speaking = speak(caption.speech, token);
    await Promise.all([typing, speaking]);
  }

  function setPlayIcon() {
    const button = $('lesson-play');
    if (button) {
      button.textContent = state.playing ? 'Ⅱ' : '▶';
      button.setAttribute('aria-label', state.playing ? 'Pause lesson' : 'Play lesson');
    }
  }

  function stop() {
    state.playing = false;
    state.token += 1;
    window.clearInterval(state.typing);
    window.clearTimeout(state.guard);
    try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (_) {}
    setSpeaking(false);
    setPlayIcon();
  }

  async function run(token) {
    while (state.playing && token === state.token && state.index < state.events.length) {
      await present(state.index, token);
      if (!state.playing || token !== state.token) return;
      if (state.index >= state.events.length - 1) break;
      await wait(360 / state.rate);
      if (!state.playing || token !== state.token) return;
      state.index += 1;
    }
    if (token === state.token && state.playing) {
      state.playing = false;
      setPlayIcon();
      const total = state.events.length;
      const summary = langPack().summary(total);
      await typeCaption(summary, state.token);
      speak(summary, state.token);
    }
  }

  function play() {
    if (!state.events.length) return;
    if (state.index >= state.events.length - 1) state.index = 0;
    state.playing = true;
    state.token += 1;
    setPlayIcon();
    run(state.token);
  }

  function pause() {
    stop();
    const caption = $('lesson-caption');
    if (caption) caption.classList.add('done');
  }

  function stepBy(delta) {
    stop();
    showStep(state.index + delta);
    const caption = buildCaption(state.index);
    const element = $('lesson-caption');
    if (element) {
      element.textContent = caption.text;
      element.classList.add('done');
    }
    speak(caption.speech, state.token);
  }

  async function open() {
    const bridge = window.CodeFlow;
    if (!bridge) return;
    const snapshot = bridge.snapshot();
    state.events = snapshot.events || [];
    state.source = snapshot.source || '';
    state.language = snapshot.language || 'python';
    state.outputLines = Array.isArray(snapshot.output) ? snapshot.output.slice()
      : (snapshot.stdout ? String(snapshot.stdout).split('\n').filter(Boolean) : []);
    state.stderrLines = Array.isArray(snapshot.stderr) ? snapshot.stderr.slice()
      : (snapshot.stderr ? String(snapshot.stderr).split('\n').filter(Boolean) : []);

    const overlay = $('lesson');
    if (!overlay) return;
    overlay.hidden = false;
    state.open = true;
    document.body.style.overflow = 'hidden';

    const file = $('lesson-file');
    if (file) {
      const names = { python: 'main.py', javascript: 'main.js', java: 'Main.java', c: 'main.c', cpp: 'main.cpp' };
      file.textContent = names[state.language] || 'source';
    }

    if (!state.events.length) {
      const caption = $('lesson-caption');
      if (caption) caption.textContent = langPack().running;
      await bridge.run();
      const refreshed = bridge.snapshot();
      state.events = refreshed.events || [];
      state.source = refreshed.source || '';
      state.language = refreshed.language || state.language;
      state.outputLines = Array.isArray(refreshed.output) ? refreshed.output.slice()
        : (refreshed.stdout ? String(refreshed.stdout).split('\n').filter(Boolean) : []);
      state.stderrLines = Array.isArray(refreshed.stderr) ? refreshed.stderr.slice()
        : (refreshed.stderr ? String(refreshed.stderr).split('\n').filter(Boolean) : []);
    }

    if (!state.events.length) {
      const caption = $('lesson-caption');
      if (caption) caption.textContent = langPack().noSteps;
      return;
    }

    buildCode();
    state.index = 0;
    showStep(0);
    play();
  }

  function close() {
    stop();
    state.open = false;
    const overlay = $('lesson');
    if (overlay) overlay.hidden = true;
    document.body.style.overflow = '';
  }

  // The chrome around the narration follows the same language choice, so the
  // panel never mixes a Hinglish caption with an English heading.
  function applyNarrationChrome() {
    const pack = langPack();
    const hinglish = state.narration === 'hi';
    const heading = document.querySelector('.lesson-explain-head h4');
    if (heading) heading.textContent = hinglish ? 'Kya hua' : 'What happened';
    const hint = document.querySelector('.lesson-hint');
    if (hint) hint.textContent = hinglish ? 'Kisi bhi line pe click karke suno' : 'Click any line to hear it';
    // The side panel is part of the same lesson, so it follows the same choice.
    const step = $('lesson-head-step');
    if (step) step.textContent = pack.headStep;
    const vars = $('lesson-head-vars');
    if (vars) vars.textContent = pack.headVars;
    const stack = $('lesson-head-stack');
    if (stack) stack.textContent = pack.headStack;
    const output = $('lesson-head-output');
    if (output) output.textContent = pack.headOutput;
    if (state.open && state.events.length) {
      renderStepInfo(state.events[state.index]);
      renderVariables(state.events[state.index]);
      renderStack(state.events[state.index]);
      renderOutput(state.events[state.index]);
    }
  }

  function bind() {
    const launch = $('lesson-button');
    if (launch) launch.addEventListener('click', open);
    const closeButton = $('lesson-close');
    if (closeButton) closeButton.addEventListener('click', close);
    const playButton = $('lesson-play');
    if (playButton) playButton.addEventListener('click', () => { if (state.playing) pause(); else play(); });
    const prev = $('lesson-prev');
    if (prev) prev.addEventListener('click', () => stepBy(-1));
    const next = $('lesson-next');
    if (next) next.addEventListener('click', () => stepBy(1));
    const code = $('lesson-code');
    if (code) {
      code.addEventListener('click', (event) => {
        const line = event.target.closest('.lesson-line');
        if (!line) return;
        explainLine(Number(line.dataset.line));
      });
    }
    const voice = $('lesson-voice');
    if (voice) {
      voice.addEventListener('click', () => {
        state.voice = !state.voice;
        voice.setAttribute('aria-pressed', String(state.voice));
        voice.textContent = state.voice ? '🔊' : '🔇';
        voice.title = state.voice ? 'Mute narration' : 'Unmute narration';
        // The token invalidates any sentence loop still running, so the voice
        // stops immediately instead of finishing the paragraph it queued.
        state.token += 1;
        try { window.speechSynthesis.cancel(); } catch (_) {}
        setSpeaking(false);
        if (state.voice && state.open) {
          const caption = buildCaption(state.index);
          speak(caption.speech, state.token);
        }
      });
    }
    const speed = $('lesson-speed');
    if (speed) speed.addEventListener('change', () => { state.rate = Number(speed.value) || 1; });
    const langSelect = $('lesson-lang');
    if (langSelect) {
      try {
        const saved = localStorage.getItem('codeflow.narration');
        if (saved && PACKS[saved]) { state.narration = saved; langSelect.value = saved; }
      } catch (_) { /* persistence is optional */ }
      applyNarrationChrome();
      langSelect.addEventListener('change', () => {
        state.narration = PACKS[langSelect.value] ? langSelect.value : 'en';
        try { localStorage.setItem('codeflow.narration', state.narration); } catch (_) { /* optional */ }
        // The voice list is scored per language, so drop the cached pick.
        state.chosenVoice = null;
        applyNarrationChrome();
        // Hinglish is clearest through a Hindi voice; say so on hover when the
        // browser has none, instead of silently sounding the same as before.
        if (langSelect && state.narration === 'hi') {
          langSelect.title = hindiVoice()
            ? 'Narration language — Hindi voice found'
            : 'Narration language — no Hindi voice installed, using an English one';
        }
        if (!state.open) return;
        state.token += 1;
        const token = state.token;
        const caption = buildCaption(state.index);
        const element = $('lesson-caption');
        if (element) { element.classList.remove('done'); element.textContent = ''; }
        Promise.all([typeCaption(caption.text, token), speak(caption.speech, token)]);
      });
    }
    document.addEventListener('keydown', (event) => {
      if (!state.open) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); stepBy(1); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); stepBy(-1); }
      else if (event.key === ' ') { event.preventDefault(); if (state.playing) pause(); else play(); }
    });
    if ('speechSynthesis' in window) {
      window.speechSynthesis.onvoiceschanged = () => {
        // The list arrives asynchronously in Chrome; re-score it once.
        state.chosenVoice = null;
        pickVoice();
      };
    }
  }

  // The editor reuses this tokenizer so the two views can never disagree
  // about what counts as a keyword, a string or a comment.
  window.CodeFlowLesson = { highlight, KEYWORDS, toDevanagari };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
