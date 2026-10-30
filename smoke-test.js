const fs = require('fs');
const path = require('path');

const root = __dirname;
const required = [
  'index.html', 'styles.css', 'responsive.css', 'lesson.css',
  'app.js', 'lesson.js', 'backend.py', 'lldb_tracer.py', 'CodeFlowTracer.java',
  'js_tracer.js', 'README.md', 'package.json'
];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing ${file}`);
}

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const lesson = fs.readFileSync(path.join(root, 'lesson.js'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'backend.py'), 'utf8');
const tracer = fs.readFileSync(path.join(root, 'js_tracer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const checks = [
  ['editor', html.includes('id="code-editor"')],
  ['responsive viewport', html.includes('name="viewport"')],
  ['execute contract', js.includes("'/api/execute'")],
  ['verify contract', js.includes("'/api/verify'")],
  ['AI contract', js.includes("'/api/ai'")],
  ['offline fallback', js.includes('offlinePython')],
  ['startup guard', js.includes('DOMContentLoaded')],
  ['sound control', html.includes('id="sound-toggle"') && html.includes('id="sound-status"')],
  ['audio unlock', js.includes('AudioContext') && js.includes('toggleSound')],
  ['step sound path', js.includes('selectTimelineStep') && js.includes('playStepSound')],
  ['muted by default', js.includes('soundEnabled: false')],
  ['five languages', ['python', 'javascript', 'java', 'c', 'cpp'].every((lang) => html.includes(`data-language="${lang}"`))],
  ['languages are all visible, not a dropdown', html.includes('id="language-tabs"') && !html.includes('id="language-select"')],
  ['stdin wiring', js.includes('stdin-input') && backend.includes('stdin_data')],
  ['truncation surfaced', html.includes('id="limit-note"') && js.includes('renderLimits')],
  ['shareable link', js.includes('shareCode') && js.includes('applyShareLink')],
  ['lesson launcher', html.includes('id="lesson-button"') && lesson.includes('speechSynthesis')],
  ['lesson narration', lesson.includes('buildCaption') && lesson.includes('SpeechSynthesisUtterance')],
  ['lesson fallback without speech', lesson.includes("'speechSynthesis' in window")],
  ['return values in trace', backend.includes('"return_value"')],
  ['no line-zero events', backend.includes('event == "call" and line <= 0')],
  ['native tracing', backend.includes('lldb_tracer.py') && backend.includes('target.input-path')],
  ['javascript tracing', backend.includes('js_tracer.js') && js.includes('codeflow.language')],
  ['javascript frames keyed by script id', tracer.includes('location.scriptId === userScriptId')],
  ['javascript breakpoints armed before the first line', tracer.includes('Debugger.getPossibleBreakpoints')],
  ['no stale cache on the app shell', backend.includes('Cache-Control')],
  ['editor syntax highlighting', html.includes('id="editor-highlight-code"') && js.includes('refreshHighlight')],
  ['highlight metrics pinned to the editor', /\.editor-highlight,\s*\n#code-editor\s*\{[\s\S]*?font: 13px\/1\.65 var\(--mono\)/.test(fs.readFileSync(path.join(root, 'styles.css'), 'utf8'))],
  ['gutter and code share a line height', css.includes('grid-template-rows: 100%') && css.includes('font-variant-numeric: tabular-nums')]
];
// Examples used to be one hard-coded Python string per card, so "Try example"
// silently switched the editor back to Python. Every example must now exist in
// all five languages.
const examplesBlock = js.slice(js.indexOf('const EXAMPLES = '), js.indexOf('const EXAMPLE_TITLES'));
const exampleCounts = ['python', 'javascript', 'java', 'c', 'cpp'].map(
  (language) => [language, (examplesBlock.match(new RegExp(`\\n\\s+${language}:`, 'g')) || []).length]
);
checks.push(
  ['examples exist in all five languages', examplesBlock.length > 0 && exampleCounts.every(([, count]) => count >= 3)],
  ['example language pills', html.includes('id="example-langs"') && ['python', 'javascript', 'java', 'c', 'cpp'].every((language) => html.includes(`class="example-lang" data-language="${language}"`))],
  ['example previews per card', (html.match(/data-example-preview=/g) || []).length === 3],
  ['lesson lines are clickable buttons', lesson.includes('class="lesson-line"') && lesson.includes('function explainLine(') && lesson.includes("closest('.lesson-line')")],
  ['narration is chunked by sentence', lesson.includes('function sentences(') && lesson.includes('function voiceScore(')]
);
if (/coldchain|cold-chain/i.test(html + js + backend)) throw new Error('Standalone folder contains an unrelated product reference');
const failed = checks.filter(([, passed]) => !passed);
if (failed.length) throw new Error(`Smoke test failed: ${failed.map(([name]) => name).join(', ')}`);
console.log(`Smoke test passed: ${checks.length} checks`);
