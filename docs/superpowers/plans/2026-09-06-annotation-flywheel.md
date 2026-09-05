# Annotation Flywheel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the reader label any judged paragraph as Slop or Real from the page, buffer those labels locally, export them, and triage them into the eval corpus with the model's verdict at capture recorded alongside.

**Architecture:** The content script keeps a per-paragraph verdict map and shows a hover pill; a new content script owns a single fixed-position shadow-DOM host with the popover. The worker hashes the prompt, returns a richer verdict, and appends records to chrome.storage.local. An options page exports JSONL. A Node CLI in `eval/` collapses, classifies and promotes records into `corpus.json`, and `score.py` learns a production split.

**Tech Stack:** Chrome extension manifest v3 (plain scripts, no bundler), Node 22 with `node:test`, Python 3 for the scorer, Playwright 1.63 driving installed Google Chrome for the end-to-end check, Ollama with `qwen3:4b` running locally.

**Spec:** `docs/superpowers/specs/2026-09-06-annotation-flywheel-design.md`

## Global Constraints

- Node 22 is installed. Use `node:test` and `node:assert/strict`, no test framework dependency.
- The extension is plain scripts. Content scripts cannot `import`; `annotator.js` exposes one global, `window.SlopAnnotator`, and is listed before `content.js` in the manifest.
- The content script never writes to `element.style` or to any attribute on page elements beyond the flag class and title it already manages. The only node added to a page is the `ai-slop-annotator` host.
- Human labels use the corpus vocabulary `SLOP` or `HUMAN`. Model verdicts keep `SLOP` or `REAL`.
- `corpus.json` is written with `JSON.stringify(corpus, null, 2)` and no trailing newline, because the file has none today and a promotion must diff as only the new item.
- Production corpus items have ids `prod-NNN`, three digits, zero padded, `label_provenance: "UNKNOWN"`, and a `source` block.
- Production items are never copied into the few-shot examples.
- No em dashes anywhere in code comments, docs or commit messages. Use commas or colons.
- Commit after every task. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Verification means running the command and reading the output. Never claim a step passed without the output.

## File map

| file | responsibility |
| --- | --- |
| `package.json` (new) | `npm test` runs `node --test`; Playwright as the only dev dependency |
| `eval/triage_lib.mjs` (new) | pure functions: hash, collapse, classify, drop known, calibration, few-shot guard, next id, corpus item |
| `eval/triage_lib.test.mjs` (new) | unit tests for the above |
| `eval/live_prompt.mjs` (new) | reads `SYSTEM_PROMPT` and `FEW_SHOT` out of `background.js`; shared by `run.mjs`, `triage.mjs` and the worker test |
| `eval/triage.mjs` (new) | the CLI: reads `eval/inbox/*.jsonl`, prints the summary, walks promote/reject/skip, writes `corpus.json` and `triage_log.json` |
| `eval/triage_cli.test.mjs` (new) | drives the CLI with piped stdin against scratch files |
| `eval/inbox/README.md` (new) | what the directory is for |
| `eval/triage_log.json` (new) | `{}` to start; every decision keyed by text hash |
| `eval/run.mjs` (edit) | use `live_prompt.mjs`; add `--split` |
| `eval/score.py` (edit) | add `--split`; skip items without a binary label on the chosen axis |
| `eval/README.md` (edit) | the loop and its rules |
| `background.js` (edit) | prompt hash, richer `checkSlop` reply, `saveRecord` with serialised writes |
| `tests/background.test.mjs` (new) | runs the worker in a `vm` context with a fake `chrome` and `fetch` |
| `manifest.json` (edit) | `storage` permission, options page, `annotator.js` before `content.js`, version 1.2 |
| `annotator.js` (new) | the host element, pill, popover, positioning, keyboard |
| `content.js` (edit) | verdict map, hover detection, record building, dismissal logging, Escape scoping |
| `options.html`, `options.js` (new) | counts, export, clear exported |
| `e2e/fixtures/page.html` (new) | four paragraphs with known verdicts |
| `e2e/run.mjs` (new) | Playwright end-to-end: label, dismiss, export, triage |

`node --test` with no arguments finds `**/*.test.mjs` and anything under a directory named `test/`. The e2e lives in `e2e/` and the worker test in `tests/` so a unit test run never launches Chrome.

---

### Task 1: Triage library, collapse and classify

**Files:**
- Create: `package.json`
- Create: `eval/triage_lib.mjs`
- Create: `eval/triage_lib.test.mjs`

**Interfaces:**
- Produces: `sha256Hex(text) -> hex string`; `collapse(records) -> Item[]` where `Item = { sha, annotation: Record|null, dismissals: number, latest: Record }`; `classify(item) -> 'false_positive'|'false_negative'|'agree_slop'|'agree_human'|'dismissal_only'`; `CLASSES` array in that order; `CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 }`.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "ai-slop",
  "private": true,
  "version": "1.2.0",
  "description": "Local AI slop detector: Chrome extension, eval harness, annotation flywheel",
  "scripts": {
    "test": "node --test",
    "e2e": "node e2e/run.mjs"
  }
}
```

- [ ] **Step 2: Write the failing tests**

`eval/triage_lib.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex, collapse, classify, CLASSES } from './triage_lib.mjs';

const model = (verdict, confidence, flagged) => ({ name: 'qwen3:4b', verdict, confidence, flagged, prompt_sha256: 'p'.repeat(64) });
const page = { url: 'https://example.com/a', title: 'A' };

function ann(text, label, m, created_at, explanation = 'why') {
  return { id: 'ann_' + created_at, kind: 'annotation', label_quality: label, explanation, text, text_sha256: sha256Hex(text), model: m, page, created_at };
}
function dis(text, m, created_at) {
  return { id: 'dis_' + created_at, kind: 'dismissal', label_quality: null, explanation: '', text, text_sha256: sha256Hex(text), model: m, page, created_at };
}

test('sha256Hex matches a known digest', () => {
  assert.equal(sha256Hex('hello world'), 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
});

test('collapse keeps the latest annotation per text and counts dismissals', () => {
  const m = model('SLOP', 'high', true);
  const items = collapse([
    ann('one', 'HUMAN', m, '2026-09-06T10:00:00.000Z'),
    dis('one', m, '2026-09-06T10:01:00.000Z'),
    ann('one', 'SLOP', m, '2026-09-06T10:02:00.000Z', 'changed my mind'),
    dis('one', m, '2026-09-06T10:03:00.000Z'),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].sha, sha256Hex('one'));
  assert.equal(items[0].annotation.explanation, 'changed my mind');
  assert.equal(items[0].dismissals, 2);
  assert.equal(items[0].latest.kind, 'dismissal');
});

test('collapse keeps dismissal-only paragraphs with a null annotation', () => {
  const items = collapse([dis('two', model('SLOP', 'medium', true), '2026-09-06T10:00:00.000Z')]);
  assert.equal(items[0].annotation, null);
  assert.equal(items[0].dismissals, 1);
  assert.equal(items[0].latest.text, 'two');
});

test('collapse ignores records without a text hash', () => {
  assert.deepEqual(collapse([{ kind: 'annotation', text: 'x' }]), []);
});

test('classify names the five classes', () => {
  const t = '2026-09-06T10:00:00.000Z';
  const item = (label, m) => ({ sha: 's', annotation: ann('t', label, m, t), dismissals: 0, latest: null });
  assert.equal(classify(item('HUMAN', model('SLOP', 'high', true))), 'false_positive');
  assert.equal(classify(item('SLOP', model('REAL', 'high', false))), 'false_negative');
  assert.equal(classify(item('SLOP', model('SLOP', 'low', false))), 'false_negative');
  assert.equal(classify(item('SLOP', model('SLOP', 'high', true))), 'agree_slop');
  assert.equal(classify(item('HUMAN', model('REAL', 'medium', false))), 'agree_human');
  assert.equal(classify({ sha: 's', annotation: null, dismissals: 1, latest: dis('t', model('SLOP', 'high', true), t) }), 'dismissal_only');
  assert.deepEqual(CLASSES, ['false_positive', 'false_negative', 'agree_slop', 'agree_human', 'dismissal_only']);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '.../eval/triage_lib.mjs'`

- [ ] **Step 4: Write the implementation**

`eval/triage_lib.mjs`:

```js
// Pure functions behind eval/triage.mjs. Nothing here touches the filesystem or
// stdin, so every branch is testable with plain objects.

import { createHash } from 'node:crypto';

export const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };
export const CLASSES = ['false_positive', 'false_negative', 'agree_slop', 'agree_human', 'dismissal_only'];

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Groups raw records by text hash. The latest annotation for a hash wins and
// dismissals attach to it as a count. A hash with dismissals and no annotation
// keeps its latest dismissal as `latest`, so triage can still show the text.
export function collapse(records) {
  const byHash = new Map();
  for (const r of records) {
    if (!r.text_sha256) continue;
    const entry = byHash.get(r.text_sha256) ?? { sha: r.text_sha256, annotation: null, dismissals: 0, latest: null };
    if (r.kind === 'dismissal') {
      entry.dismissals += 1;
    } else if (r.kind === 'annotation') {
      if (!entry.annotation || r.created_at > entry.annotation.created_at) entry.annotation = r;
    }
    if (!entry.latest || r.created_at > entry.latest.created_at) entry.latest = r;
    byHash.set(r.text_sha256, entry);
  }
  return [...byHash.values()];
}

// Compares what the reader said with what the extension did. `flagged` is the
// verdict after the confidence gate, so a low-confidence SLOP that was never
// drawn on the page counts as a miss when the reader calls it slop.
export function classify(item) {
  if (!item.annotation) return 'dismissal_only';
  const readerSaidSlop = item.annotation.label_quality === 'SLOP';
  const flagged = item.annotation.model.flagged === true;
  if (flagged && !readerSaidSlop) return 'false_positive';
  if (!flagged && readerSaidSlop) return 'false_negative';
  return readerSaidSlop ? 'agree_slop' : 'agree_human';
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: `# pass 5`, `# fail 0`

- [ ] **Step 6: Commit**

```bash
git add package.json eval/triage_lib.mjs eval/triage_lib.test.mjs
git commit -m "Add triage library: collapse records by text hash and classify against the model

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Triage library, known hashes, ids and corpus items

**Files:**
- Modify: `eval/triage_lib.mjs`
- Modify: `eval/triage_lib.test.mjs`

**Interfaces:**
- Consumes: `sha256Hex`, `Item` from Task 1.
- Produces: `corpusHashes(corpus) -> Set<hex>`; `dropKnown(items, corpus, log) -> Item[]` where `log` is `{ [sha]: { decision, id, at } }`; `nextProdId(corpus) -> 'prod-NNN'`; `toCorpusItem(item, { id, bucket, label, explanation }) -> corpus item`.

- [ ] **Step 1: Add the failing tests**

Append to `eval/triage_lib.test.mjs` (add `corpusHashes, dropKnown, nextProdId, toCorpusItem` to the import):

```js
test('dropKnown removes hashes already in the corpus or the log', () => {
  const m = model('SLOP', 'high', true);
  const t = '2026-09-06T10:00:00.000Z';
  const items = collapse([ann('in corpus', 'SLOP', m, t), ann('in log', 'SLOP', m, t), ann('fresh', 'SLOP', m, t)]);
  const corpus = [{ id: 'ai-01', text: 'in corpus' }];
  const log = { [sha256Hex('in log')]: { decision: 'reject', id: null, at: t } };
  assert.deepEqual(dropKnown(items, corpus, log).map(i => i.latest.text), ['fresh']);
  assert.ok(corpusHashes(corpus).has(sha256Hex('in corpus')));
});

test('nextProdId continues from the highest prod id and ignores other ids', () => {
  assert.equal(nextProdId([]), 'prod-001');
  assert.equal(nextProdId([{ id: 'ai-01' }, { id: 'prod-003' }, { id: 'prod-002' }]), 'prod-004');
  assert.equal(nextProdId([{ id: 'prod-099' }]), 'prod-100');
});

test('toCorpusItem builds the production item shape', () => {
  const m = model('REAL', 'medium', false);
  const t = '2026-09-06T10:00:00.000Z';
  const [item] = collapse([ann('a circular claim', 'SLOP', m, t, 'subject and object are the same')]);
  const out = toCorpusItem(item, { id: 'prod-001', bucket: 'K_circular_claim', label: 'SLOP', explanation: item.annotation.explanation });
  assert.deepEqual(out, {
    id: 'prod-001',
    label: 'SLOP',
    bucket: 'K_circular_claim',
    text: 'a circular claim',
    label_provenance: 'UNKNOWN',
    label_quality: 'SLOP',
    source: {
      url: 'https://example.com/a',
      title: 'A',
      annotated_at: t,
      explanation: 'subject and object are the same',
      dismissals: 0,
      model_at_capture: m,
    },
  });
});

test('toCorpusItem works for a dismissal-only paragraph', () => {
  const m = model('SLOP', 'high', true);
  const [item] = collapse([dis('dismissed twice', m, '2026-09-06T10:00:00.000Z'), dis('dismissed twice', m, '2026-09-06T10:01:00.000Z')]);
  const out = toCorpusItem(item, { id: 'prod-002', bucket: 'P_production', label: 'HUMAN', explanation: 'dismissed by reader' });
  assert.equal(out.label_quality, 'HUMAN');
  assert.equal(out.source.dismissals, 2);
  assert.equal(out.source.explanation, 'dismissed by reader');
  assert.equal(out.source.annotated_at, '2026-09-06T10:01:00.000Z');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL with `does not provide an export named 'corpusHashes'`

- [ ] **Step 3: Add the implementation**

Append to `eval/triage_lib.mjs`:

```js
export function corpusHashes(corpus) {
  return new Set(corpus.map(item => sha256Hex(item.text)));
}

// Anything already in the corpus, or already promoted or rejected, is never
// asked about again. Re-running triage on the same inbox files is free.
export function dropKnown(items, corpus, log) {
  const known = corpusHashes(corpus);
  return items.filter(item => !known.has(item.sha) && !(item.sha in log));
}

export function nextProdId(corpus) {
  let max = 0;
  for (const { id } of corpus) {
    const m = /^prod-(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `prod-${String(max + 1).padStart(3, '0')}`;
}

// `label` is written to both `label` and `label_quality`. On the hand-written
// items `label` follows provenance, but a production item has no known
// provenance, and `label` is only read for run.mjs progress marks and as the
// scorer's fallback when an axis field is missing. Both axis fields are present.
export function toCorpusItem(item, { id, bucket, label, explanation }) {
  const source = item.annotation ?? item.latest;
  return {
    id,
    label,
    bucket,
    text: source.text,
    label_provenance: 'UNKNOWN',
    label_quality: label,
    source: {
      url: source.page.url,
      title: source.page.title,
      annotated_at: source.created_at,
      explanation,
      dismissals: item.dismissals,
      model_at_capture: { ...source.model },
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: `# pass 9`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add eval/triage_lib.mjs eval/triage_lib.test.mjs
git commit -m "Triage library: skip known hashes, assign prod ids, build corpus items

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Triage library, calibration and the few-shot guard

**Files:**
- Modify: `eval/triage_lib.mjs`
- Modify: `eval/triage_lib.test.mjs`

**Interfaces:**
- Produces: `countByClass(items) -> { [class]: n }`; `calibration(items) -> { cells: { 'VERDICT/confidence': { SLOP, HUMAN } }, gates: { low|medium|high: { flagged, precision: number|null, flag_rate } }, total }`; `shingles(text, n) -> Set<string>`; `sharesRun(text, reference, n = 6) -> boolean`.

- [ ] **Step 1: Add the failing tests**

Append to `eval/triage_lib.test.mjs` (add `countByClass, calibration, shingles, sharesRun` to the import):

```js
test('countByClass tallies every class, including zeros', () => {
  const t = '2026-09-06T10:00:00.000Z';
  const items = collapse([
    ann('a', 'HUMAN', model('SLOP', 'high', true), t),
    ann('b', 'SLOP', model('REAL', 'high', false), t),
    ann('c', 'SLOP', model('SLOP', 'high', true), t),
    dis('d', model('SLOP', 'medium', true), t),
  ]);
  assert.deepEqual(countByClass(items), { false_positive: 1, false_negative: 1, agree_slop: 1, agree_human: 0, dismissal_only: 1 });
});

test('calibration crosses model output with reader labels and simulates each gate', () => {
  const t = '2026-09-06T10:00:00.000Z';
  const items = collapse([
    ann('a', 'SLOP', model('SLOP', 'high', true), t),
    ann('b', 'HUMAN', model('SLOP', 'medium', true), t),
    ann('c', 'SLOP', model('SLOP', 'low', false), t),
    ann('d', 'HUMAN', model('REAL', 'high', false), t),
    dis('e', model('SLOP', 'high', true), t),
  ]);
  const cal = calibration(items);
  assert.equal(cal.total, 4);
  assert.deepEqual(cal.cells['SLOP/high'], { SLOP: 1, HUMAN: 0 });
  assert.deepEqual(cal.cells['SLOP/medium'], { SLOP: 0, HUMAN: 1 });
  assert.deepEqual(cal.cells['REAL/high'], { SLOP: 0, HUMAN: 1 });
  assert.deepEqual(cal.gates.high, { flagged: 1, precision: 1, flag_rate: 0.25 });
  assert.deepEqual(cal.gates.medium, { flagged: 2, precision: 0.5, flag_rate: 0.5 });
  assert.deepEqual(cal.gates.low, { flagged: 3, precision: 2 / 3, flag_rate: 0.75 });
});

test('calibration reports null precision when nothing would be flagged', () => {
  const t = '2026-09-06T10:00:00.000Z';
  const cal = calibration(collapse([ann('a', 'HUMAN', model('REAL', 'high', false), t)]));
  assert.equal(cal.gates.high.precision, null);
  assert.equal(cal.gates.high.flag_rate, 0);
});

test('shingles lowercases, strips punctuation and slides a window', () => {
  assert.deepEqual([...shingles('Hello, World! Hello world again', 2)], ['hello world', 'world hello', 'world again']);
});

test('sharesRun finds a six word run and ignores shorter overlaps', () => {
  const fewshot = 'Digital transformation is no longer optional for the modern enterprise. Organisations that embrace change position themselves well.';
  assert.equal(sharesRun('Some say digital transformation is no longer optional for anyone.', fewshot), true);
  assert.equal(sharesRun('Digital transformation is no longer a buzzword here.', fewshot), false);
  assert.equal(sharesRun('', fewshot), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL with `does not provide an export named 'countByClass'`

- [ ] **Step 3: Add the implementation**

Append to `eval/triage_lib.mjs`:

```js
export function countByClass(items) {
  const counts = Object.fromEntries(CLASSES.map(c => [c, 0]));
  for (const item of items) counts[classify(item)] += 1;
  return counts;
}

// Rows are what the model returned (verdict and confidence), columns what the
// reader said. The gates block answers "what if MIN_CONFIDENCE were X" on these
// same paragraphs, which is the number that decides whether to move the gate.
export function calibration(items) {
  const annotated = items.filter(i => i.annotation).map(i => i.annotation);
  const cells = {};
  for (const a of annotated) {
    const key = `${a.model.verdict}/${a.model.confidence}`;
    cells[key] ??= { SLOP: 0, HUMAN: 0 };
    cells[key][a.label_quality] += 1;
  }
  const gates = {};
  for (const min of Object.keys(CONFIDENCE_RANK)) {
    let flagged = 0;
    let correct = 0;
    for (const a of annotated) {
      const wouldFlag = a.model.verdict === 'SLOP' && CONFIDENCE_RANK[a.model.confidence] >= CONFIDENCE_RANK[min];
      if (!wouldFlag) continue;
      flagged += 1;
      if (a.label_quality === 'SLOP') correct += 1;
    }
    gates[min] = {
      flagged,
      precision: flagged ? correct / flagged : null,
      flag_rate: annotated.length ? flagged / annotated.length : 0,
    };
  }
  return { cells, gates, total: annotated.length };
}

function words(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

export function shingles(text, n) {
  const w = words(text);
  const out = new Set();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}

// True when `text` shares a run of n consecutive words with `reference`. Used to
// keep production items that echo a few-shot example out of the corpus, since
// the README records that such overlap inflates the score.
export function sharesRun(text, reference, n = 6) {
  const ref = shingles(reference, n);
  for (const s of shingles(text, n)) if (ref.has(s)) return true;
  return false;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: `# pass 14`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add eval/triage_lib.mjs eval/triage_lib.test.mjs
git commit -m "Triage library: calibration table, gate simulation, few-shot overlap guard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Shared live prompt reader; run.mjs uses it and gains --split

**Files:**
- Create: `eval/live_prompt.mjs`
- Create: `eval/live_prompt.test.mjs`
- Modify: `eval/run.mjs` (the block from the comment `// v2 reads the live prompt out of background.js` through `const LIVE_FEWSHOT = grab('FEW_SHOT');`, and the corpus loop)

**Interfaces:**
- Produces: `readLivePrompt(file?) -> { system: string, fewshot: string }`. `run.mjs` accepts `--split=prod|synthetic|all`.

- [ ] **Step 1: Write the failing test**

`eval/live_prompt.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLivePrompt } from './live_prompt.mjs';

test('readLivePrompt returns the two prompt halves from background.js', () => {
  const { system, fewshot } = readLivePrompt();
  assert.match(system, /SLOP or REAL/);
  assert.match(system, /When unsure, answer REAL/);
  assert.match(fewshot, /<paragraph>/);
  assert.match(fewshot, /"verdict":"SLOP"/);
  assert.ok(!system.includes('const FEW_SHOT'), 'system must stop at its closing backtick');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL, `Cannot find module '.../eval/live_prompt.mjs'`

- [ ] **Step 3: Write the module**

`eval/live_prompt.mjs`:

```js
// Reads the prompt the extension actually sends, straight out of background.js,
// so the eval, the triage guard and the worker test can never drift from it.

import fs from 'node:fs';
import path from 'node:path';

const BACKGROUND = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'background.js');

// Plain string slicing rather than a regex, so backticks inside the prompt
// cannot break the extraction.
function grab(source, label) {
  const marker = 'const ' + label + ' = ' + String.fromCharCode(96);
  const from = source.indexOf(marker);
  if (from === -1) throw new Error('could not find ' + label + ' in background.js');
  const bodyStart = from + marker.length;
  const to = source.indexOf(String.fromCharCode(96) + ';', bodyStart);
  if (to === -1) throw new Error('unterminated ' + label + ' in background.js');
  return source.slice(bodyStart, to);
}

export function readLivePrompt(file = BACKGROUND) {
  const source = fs.readFileSync(file, 'utf8');
  return { system: grab(source, 'SYSTEM_PROMPT'), fewshot: grab(source, 'FEW_SHOT') };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: `# pass 15`, `# fail 0`

- [ ] **Step 5: Point run.mjs at the shared reader and add --split**

In `eval/run.mjs`, add to the imports at the top:

```js
import { readLivePrompt } from './live_prompt.mjs';
```

Replace the block that begins with the comment `// v2 reads the live prompt out of background.js so the eval can never drift` and ends with `const LIVE_FEWSHOT = grab('FEW_SHOT');` with:

```js
// v2 reads the live prompt out of background.js so the eval can never drift
// away from what the extension actually sends.
const { system: LIVE_SYSTEM, fewshot: LIVE_FEWSHOT } = readLivePrompt();
```

After the line `const MIN_CONFIDENCE = arg('min-confidence', 'medium');` add:

```js
// --split=prod scores only items promoted from reader annotations, which carry a
// `source` block. --split=synthetic scores only the hand-written items.
const SPLIT = arg('split', 'all');
const inSplit = item => {
  if (SPLIT === 'all') return true;
  const isProd = 'source' in item;
  return SPLIT === 'prod' ? isProd : !isProd;
};
```

Change the loop header `for (const item of corpus) {` to:

```js
for (const item of corpus.filter(inSplit)) {
```

And extend the final `console.log` so the split is visible:

```js
console.log(`tag=${tag} model=${MODEL} system=${sysFile ?? ARM} fewshot=${fewFile ?? ARM} split=${SPLIT} -> ${path.basename(file)}`);
```

- [ ] **Step 6: Verify run.mjs still parses and the split filter is wired**

Run: `node --check eval/run.mjs && grep -n "readLivePrompt\|inSplit\|split=" eval/run.mjs`
Expected: no syntax error; four matching lines (the import, the filter definition, the loop, the log).

Run a production-only pass, which has nothing to score yet and must finish instantly without calling Ollama:

Run: `node eval/run.mjs --arm=v3 --model=qwen3:4b --split=prod --tag=splitcheck && rm eval/results_splitcheck_qwen3_4b.json`
Expected: an empty progress line, then `tag=splitcheck ... split=prod -> results_splitcheck_qwen3_4b.json`

- [ ] **Step 7: Commit**

```bash
git add eval/live_prompt.mjs eval/live_prompt.test.mjs eval/run.mjs
git commit -m "Share the live prompt reader between run.mjs and triage; add --split to run.mjs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The triage CLI

**Files:**
- Create: `eval/triage.mjs`
- Create: `eval/triage_cli.test.mjs`
- Create: `eval/inbox/README.md`
- Create: `eval/triage_log.json`

**Interfaces:**
- Consumes: everything exported by `eval/triage_lib.mjs`; `readLivePrompt` from `eval/live_prompt.mjs`.
- Produces: `node eval/triage.mjs [--summary] [--inbox=DIR] [--corpus=FILE] [--log=FILE]`. Exit 0 always on a clean run.

- [ ] **Step 1: Create the inbox README and the empty log**

`eval/inbox/README.md`:

```markdown
# Inbox

Exported annotation files from the extension's options page go here, one
`slop-inbox-YYYYMMDD-HHMM.jsonl` per export. They are append-only history.
`node eval/triage.mjs` reads every file in this directory and never modifies them.
Decisions live in `eval/triage_log.json`, keyed by text hash, so re-running triage
on the same files asks nothing twice.
```

`eval/triage_log.json`:

```json
{}
```

- [ ] **Step 2: Write the failing CLI test**

`eval/triage_cli.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256Hex } from './triage_lib.mjs';

const TRIAGE = new URL('./triage.mjs', import.meta.url).pathname;
const T = '2026-09-06T10:00:00.000Z';
const page = { url: 'https://example.com/post', title: 'Post' };
const model = (verdict, confidence, flagged) => ({ name: 'qwen3:4b', verdict, confidence, flagged, prompt_sha256: 'p'.repeat(64) });
const rec = (kind, text, label, m, explanation, created_at = T) =>
  ({ id: `${kind}_${created_at}`, kind, label_quality: label, explanation, text, text_sha256: sha256Hex(text), model: m, page, created_at });

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
  fs.mkdirSync(path.join(dir, 'inbox'));
  const corpus = [
    { id: 'ai-01', label: 'SLOP', bucket: 'A_classic_ai_slop', text: 'existing slop', label_provenance: 'SLOP', label_quality: 'SLOP' },
    { id: 'circ-01', label: 'HUMAN', bucket: 'K_circular_claim', text: 'existing circular', label_provenance: 'HUMAN', label_quality: 'SLOP' },
  ];
  fs.writeFileSync(path.join(dir, 'corpus.json'), JSON.stringify(corpus, null, 2));
  fs.writeFileSync(path.join(dir, 'log.json'), '{}\n');
  const lines = [
    rec('annotation', 'flagged but the reader says real', 'HUMAN', model('SLOP', 'high', true), 'it names a date and a price'),
    rec('annotation', 'missed circular claim', 'SLOP', model('REAL', 'medium', false), 'the subject is the object'),
    rec('dismissal', 'clicked away', null, model('SLOP', 'medium', true), ''),
    rec('annotation', 'existing slop', 'SLOP', model('SLOP', 'high', true), 'already in corpus'),
  ];
  fs.writeFileSync(path.join(dir, 'inbox', 'slop-inbox-20260906-1000.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return dir;
}

function run(dir, input, ...extra) {
  const r = spawnSync(process.execPath, [TRIAGE, `--inbox=${path.join(dir, 'inbox')}`, `--corpus=${path.join(dir, 'corpus.json')}`, `--log=${path.join(dir, 'log.json')}`, ...extra], { input, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('--summary counts classes, drops what the corpus already has, and simulates the gate', () => {
  const dir = scratch();
  const out = run(dir, '', '--summary');
  assert.match(out, /records read: 4 {3}already decided or in corpus: 1/);
  assert.match(out, /new paragraphs: 3/);
  assert.match(out, /false_positive {5}1/);
  assert.match(out, /false_negative {5}1/);
  assert.match(out, /dismissal_only {5}1/);
  assert.match(out, /SLOP\/high {17}0 {6}1/);
  assert.match(out, /REAL\/medium {15}1 {6}0/);
  assert.match(out, /high {27}1 {7}0\.0%/);
  assert.match(out, /low {28}1 {7}0\.0%/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8')).length, 2, 'summary never writes');
});

test('the walk promotes, rejects and skips, writing the corpus and the log as it goes', () => {
  const dir = scratch();
  // false positive: promote with the default bucket
  // false negative: promote into K_circular_claim
  // dismissal only: skip
  const out = run(dir, 'p\n\np\nK_circular_claim\ns\n');
  assert.match(out, /-> prod-001 in P_production/);
  assert.match(out, /-> prod-002 in K_circular_claim/);
  assert.match(out, /dismissed but never labelled/);

  const raw = fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8');
  assert.ok(!raw.endsWith('\n'), 'corpus keeps no trailing newline');
  const corpus = JSON.parse(raw);
  assert.equal(corpus.length, 4);
  const [p1, p2] = corpus.slice(2);
  assert.equal(p1.id, 'prod-001');
  assert.equal(p1.label_quality, 'HUMAN');
  assert.equal(p1.label, 'HUMAN');
  assert.equal(p1.label_provenance, 'UNKNOWN');
  assert.equal(p1.bucket, 'P_production');
  assert.equal(p1.source.explanation, 'it names a date and a price');
  assert.equal(p1.source.model_at_capture.verdict, 'SLOP');
  assert.equal(p2.id, 'prod-002');
  assert.equal(p2.label_quality, 'SLOP');
  assert.equal(p2.bucket, 'K_circular_claim');

  const log = JSON.parse(fs.readFileSync(path.join(dir, 'log.json'), 'utf8'));
  assert.deepEqual(Object.values(log).map(d => [d.decision, d.id]).sort(), [['promote', 'prod-001'], ['promote', 'prod-002']]);

  // Second run: only the skipped dismissal remains, and the decided ones are gone.
  const again = run(dir, '', '--summary');
  assert.match(again, /new paragraphs: 1/);
  assert.match(again, /dismissal_only {5}1/);
});

test('rejecting logs the hash and promoting a dismissal records HUMAN', () => {
  const dir = scratch();
  const out = run(dir, 'r\nr\np\n\n');
  assert.match(out, /-> prod-001 in P_production/);
  const corpus = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8'));
  assert.equal(corpus.at(-1).label_quality, 'HUMAN');
  assert.equal(corpus.at(-1).source.explanation, 'dismissed by reader');
  assert.equal(corpus.at(-1).source.dismissals, 1);
  const log = JSON.parse(fs.readFileSync(path.join(dir, 'log.json'), 'utf8'));
  assert.equal(Object.values(log).filter(d => d.decision === 'reject').length, 2);
});

test('the few-shot guard refuses a plain p and accepts p!', () => {
  const dir = scratch();
  const echo = rec('annotation', 'Digital transformation is no longer optional for the modern enterprise, they said.', 'SLOP', model('SLOP', 'high', true), 'echoes an example');
  fs.writeFileSync(path.join(dir, 'inbox', 'slop-inbox-20260906-1100.jsonl'), JSON.stringify(echo) + '\n');
  // skip the false positive and the false negative, then reach the guarded item
  const out = run(dir, 's\ns\np\np!\n\ns\n');
  assert.match(out, /WARNING: shares a run of six words with a few-shot example/);
  assert.match(out, /refused: type p! to override/);
  assert.match(out, /-> prod-001 in P_production/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: the four CLI tests FAIL (the spawned process exits non-zero because `triage.mjs` does not exist).

- [ ] **Step 4: Write the CLI**

`eval/triage.mjs`:

```js
// Walks new reader annotations from eval/inbox/ into corpus.json.
//
//   node eval/triage.mjs             summary, then the promote / reject / skip walk
//   node eval/triage.mjs --summary   counts and calibration only, writes nothing
//
// --inbox=DIR --corpus=FILE --log=FILE override the paths. The tests use them.
//
// Disagreements with the model come first, then agreements, then a second pass
// over paragraphs that were dismissed but never labelled. Every decision is
// written to the log as it is made, so stopping midway loses nothing.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readLivePrompt } from './live_prompt.mjs';
import {
  CLASSES, collapse, classify, dropKnown, countByClass, calibration,
  sharesRun, nextProdId, toCorpusItem,
} from './triage_lib.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const has = name => process.argv.includes(`--${name}`);

const INBOX = arg('inbox', path.join(DIR, 'inbox'));
const CORPUS_FILE = arg('corpus', path.join(DIR, 'corpus.json'));
const LOG_FILE = arg('log', path.join(DIR, 'triage_log.json'));
const DEFAULT_BUCKET = 'P_production';

function readInbox(dir) {
  if (!fs.existsSync(dir)) return [];
  const records = [];
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort()) {
    fs.readFileSync(path.join(dir, name), 'utf8').split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      try { records.push(JSON.parse(line)); }
      catch { console.warn(`skipping ${name}:${i + 1}: not JSON`); }
    });
  }
  return records;
}

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);
// corpus.json has no trailing newline. Keep it that way so a promotion diffs as
// only the new item.
const writeCorpus = corpus => fs.writeFileSync(CORPUS_FILE, JSON.stringify(corpus, null, 2));
const writeLog = log => fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2) + '\n');
const pct = x => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

function printSummary(items) {
  const counts = countByClass(items);
  console.log(`new paragraphs: ${items.length}`);
  for (const c of CLASSES) console.log(`  ${c.padEnd(18)} ${counts[c]}`);
  const cal = calibration(items);
  if (cal.total === 0) return;
  console.log('\ncalibration (model said, then what the reader said)');
  console.log('  verdict/confidence     SLOP  HUMAN');
  for (const key of Object.keys(cal.cells).sort()) {
    const c = cal.cells[key];
    console.log(`  ${key.padEnd(22)} ${String(c.SLOP).padStart(4)}  ${String(c.HUMAN).padStart(5)}`);
  }
  console.log('\nif MIN_CONFIDENCE were    flagged  precision  flag rate');
  for (const [min, g] of Object.entries(cal.gates)) {
    console.log(`  ${min.padEnd(24)} ${String(g.flagged).padStart(7)}  ${pct(g.precision).padStart(9)}  ${pct(g.flag_rate).padStart(9)}`);
  }
}

function show(item, index, total) {
  const rec = item.annotation ?? item.latest;
  const dismissed = item.dismissals ? `   dismissed ${item.dismissals}x` : '';
  console.log(`\n[${index + 1}/${total}] ${classify(item)}${dismissed}`);
  console.log(`  ${rec.page.title || '(no title)'}\n  ${rec.page.url}`);
  console.log(`  model: ${rec.model.verdict} ${rec.model.confidence}${rec.model.flagged ? ' (flagged)' : ''}   prompt ${String(rec.model.prompt_sha256).slice(0, 8)}`);
  if (item.annotation) console.log(`  reader: ${item.annotation.label_quality}   "${item.annotation.explanation}"`);
  console.log('\n  ' + rec.text.replace(/\n/g, '\n  ') + '\n');
}

async function walk(rl, items, corpus, log, fewshot, { defaultLabel = null } = {}) {
  const buckets = [...new Set(corpus.map(i => i.bucket))].sort();
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    show(item, i, items.length);
    const tainted = sharesRun(item.latest.text, fewshot);
    if (tainted) console.log('  WARNING: shares a run of six words with a few-shot example. Type p! to promote anyway.');
    const answer = (await rl.question('  [p]romote  [r]eject  [s]kip > ')).trim();
    if (answer === 's' || answer === '') { i++; continue; }
    if (answer === 'r') {
      log[item.sha] = { decision: 'reject', id: null, at: new Date().toISOString() };
      writeLog(log);
      i++;
      continue;
    }
    if (answer === 'p' && tainted) { console.log('  refused: type p! to override the few-shot guard'); continue; }
    if (answer !== 'p' && answer !== 'p!') continue;

    console.log(`  buckets: ${buckets.join(', ')}`);
    const bucket = (await rl.question(`  bucket [${DEFAULT_BUCKET}] > `)).trim() || DEFAULT_BUCKET;
    const id = nextProdId(corpus);
    const label = item.annotation ? item.annotation.label_quality : defaultLabel;
    const explanation = item.annotation ? item.annotation.explanation : 'dismissed by reader';
    corpus.push(toCorpusItem(item, { id, bucket, label, explanation }));
    writeCorpus(corpus);
    log[item.sha] = { decision: 'promote', id, at: new Date().toISOString() };
    writeLog(log);
    if (!buckets.includes(bucket)) buckets.push(bucket);
    console.log(`  -> ${id} in ${bucket}`);
    i++;
  }
}

const records = readInbox(INBOX);
const corpus = readJson(CORPUS_FILE, []);
const log = readJson(LOG_FILE, {});
const all = collapse(records);
const fresh = dropKnown(all, corpus, log);

console.log(`records read: ${records.length}   already decided or in corpus: ${all.length - fresh.length}`);
printSummary(fresh);
if (has('summary') || fresh.length === 0) process.exit(0);

const order = ['false_positive', 'false_negative', 'agree_slop', 'agree_human'];
const annotated = fresh
  .filter(i => i.annotation)
  .sort((a, b) => order.indexOf(classify(a)) - order.indexOf(classify(b)));
const dismissedOnly = fresh.filter(i => !i.annotation);
const { fewshot } = readLivePrompt();

const rl = readline.createInterface({ input: stdin, output: stdout });
let finished = false;
rl.on('close', () => {
  if (!finished) { console.log('\ninput closed, stopping'); process.exit(0); }
});
await walk(rl, annotated, corpus, log, fewshot);
if (dismissedOnly.length) {
  console.log(`\n${dismissedOnly.length} paragraph(s) were dismissed but never labelled. Promoting one records it as HUMAN.`);
  await walk(rl, dismissedOnly, corpus, log, fewshot, { defaultLabel: 'HUMAN' });
}
finished = true;
rl.close();
console.log(`\ndone. corpus now has ${corpus.length} items.`);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: `# pass 19`, `# fail 0`. If a padding assertion fails, fix the `padEnd` and `padStart` widths in `printSummary` to match the test's regexes rather than loosening the regexes.

- [ ] **Step 6: Run the real command against the empty inbox**

Run: `node eval/triage.mjs --summary`
Expected:

```
records read: 0   already decided or in corpus: 0
new paragraphs: 0
  false_positive     0
  ...
```

and `git status --short eval/corpus.json` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add eval/triage.mjs eval/triage_cli.test.mjs eval/inbox/README.md eval/triage_log.json
git commit -m "Add eval/triage.mjs: summarise, calibrate and promote reader annotations into the corpus

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: score.py learns --split and skips non-binary labels

**Files:**
- Modify: `eval/score.py` (the first ten lines, argument handling)

**Interfaces:**
- Produces: `python3 eval/score.py RESULTS [quality|provenance] [--split=prod|synthetic|all]`. Existing invocations keep working.

- [ ] **Step 1: Record the baseline output**

Run: `python3 eval/score.py eval/results_shipped_qwen3_4b.json quality | head -3`
Expected (copy what you see; it is the baseline the next step must reproduce):

```
grading against label_quality
n=63  accuracy=88.9%   precision=100.0%  recall=78.1%  F1=0.88
confusion:  TP=25  FP=0  FN=7  TN=31
```

- [ ] **Step 2: Replace the argument handling**

Replace the first eight lines of `eval/score.py` (from `import json,sys,collections,re` through `print(f'grading against {AXIS}')`) with:

```python
import json,sys,collections,re
positional=[a for a in sys.argv[1:] if not a.startswith('--')]
options=dict(a[2:].split('=',1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
p=positional[0]
# second positional arg picks the label axis: 'quality' (default) or 'provenance'
AXIS='label_'+(positional[1] if len(positional)>1 else 'quality')
# --split=prod scores only items promoted from reader annotations (they carry a
# `source` block). --split=synthetic scores only the hand-written items.
SPLIT=options.get('split','all')
d=json.load(open(p))
if SPLIT=='prod': d=[x for x in d if 'source' in x]
elif SPLIT=='synthetic': d=[x for x in d if 'source' not in x]
for x in d:
    if AXIS in x: x['label']=x[AXIS]
# production items carry label_provenance UNKNOWN. Skip anything without a
# binary label on the chosen axis rather than counting it as wrong.
skipped=sum(1 for x in d if x['label'] not in ('SLOP','HUMAN'))
d=[x for x in d if x['label'] in ('SLOP','HUMAN')]
print(f'grading against {AXIS}  split={SPLIT}'+(f'  skipped {skipped} without a binary {AXIS}' if skipped else ''))
if not d:
    print('nothing to score'); sys.exit(0)
```

- [ ] **Step 3: Verify the baseline is unchanged and the new flags work**

Run: `python3 eval/score.py eval/results_shipped_qwen3_4b.json quality | head -3`
Expected: the same three numbers as Step 1, with `split=all` appended to the first line.

Run: `python3 eval/score.py eval/results_shipped_qwen3_4b.json quality --split=synthetic | sed -n 2p`
Expected: identical `n=63` line.

Run: `python3 eval/score.py eval/results_shipped_qwen3_4b.json quality --split=prod`
Expected:

```
grading against label_quality  split=prod
nothing to score
```

Run a synthetic results file with one UNKNOWN provenance item to confirm the skip:

```bash
python3 - <<'EOF'
import json
d=json.load(open('eval/results_shipped_qwen3_4b.json'))
d.append({**d[0], 'id':'prod-001','label':'SLOP','label_provenance':'UNKNOWN','label_quality':'SLOP','source':{}})
json.dump(d, open('/private/tmp/claude-501/-Users-esia-repos-ai-slop/379db28f-c0b2-4e2d-b3b1-c1a6fce6de59/scratchpad/withprod.json','w'))
EOF
python3 eval/score.py /private/tmp/claude-501/-Users-esia-repos-ai-slop/379db28f-c0b2-4e2d-b3b1-c1a6fce6de59/scratchpad/withprod.json provenance | head -2
python3 eval/score.py /private/tmp/claude-501/-Users-esia-repos-ai-slop/379db28f-c0b2-4e2d-b3b1-c1a6fce6de59/scratchpad/withprod.json quality --split=prod | head -2
```

Expected: the provenance run prints `skipped 1 without a binary label_provenance` and `n=63`; the prod run prints `n=1`.

- [ ] **Step 4: Commit**

```bash
git add eval/score.py
git commit -m "score.py: add --split and skip items without a binary label on the chosen axis

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The worker hashes the prompt, returns the verdict block, and saves records

**Files:**
- Modify: `background.js`
- Create: `tests/background.test.mjs`

**Interfaces:**
- Consumes: `readLivePrompt` from `eval/live_prompt.mjs` (test only).
- Produces: `checkSlop` reply `{ isSlop, verdict, confidence, model, prompt_sha256, reason }`; `saveRecord` message `{ action: "saveRecord", record }` replying `{ ok: true }` or `{ ok: false, error }`, where the stored record gains `text_sha256`.

- [ ] **Step 1: Write the failing test**

`tests/background.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { readLivePrompt } from '../eval/live_prompt.mjs';

const SOURCE = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');

// Runs background.js in a bare context with a fake chrome API and a fake fetch,
// then talks to it through the onMessage listener it registered.
function loadWorker(fetchImpl) {
  const store = {};
  const listeners = [];
  const sandbox = {
    chrome: {
      runtime: { onMessage: { addListener: fn => listeners.push(fn) } },
      storage: {
        local: {
          get: async key => (key in store ? { [key]: store[key] } : {}),
          set: async obj => { Object.assign(store, obj); },
        },
      },
    },
    fetch: fetchImpl,
    crypto: globalThis.crypto,
    TextEncoder,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'background.js' });
  // A message the worker never answers must fail, not hang the test run.
  const send = message => Promise.race([
    new Promise(resolve => listeners[0](message, {}, resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`no reply to ${message.action}`)), 2000)),
  ]);
  return { send, store };
}

const ollamaSays = verdict => async () => ({
  ok: true,
  json: async () => ({ response: JSON.stringify({ verdict, confidence: 'high' }) }),
});

const record = {
  id: 'ann_x', kind: 'annotation', label_quality: 'SLOP', explanation: 'e', text: 'hello world',
  model: {}, page: {}, created_at: '2026-09-06T00:00:00.000Z',
};

test('saveRecord appends the record with its text hash', async () => {
  const { send, store } = loadWorker(ollamaSays('REAL'));
  assert.deepEqual(await send({ action: 'saveRecord', record }), { ok: true });
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0].text_sha256, sha('hello world'));
  assert.equal(store.records[0].id, 'ann_x');
});

test('two saves arriving together both land', async () => {
  const { send, store } = loadWorker(ollamaSays('REAL'));
  await Promise.all([
    send({ action: 'saveRecord', record: { ...record, id: 'a' } }),
    send({ action: 'saveRecord', record: { ...record, id: 'b' } }),
  ]);
  assert.deepEqual(store.records.map(r => r.id).sort(), ['a', 'b']);
});

test('checkSlop returns the verdict block and the prompt hash', async () => {
  const { send } = loadWorker(ollamaSays('SLOP'));
  const reply = await send({ action: 'checkSlop', text: 'x' });
  const { system, fewshot } = readLivePrompt();
  assert.equal(reply.isSlop, true);
  assert.equal(reply.verdict, 'SLOP');
  assert.equal(reply.confidence, 'high');
  assert.equal(reply.model, 'qwen3:4b');
  assert.equal(reply.prompt_sha256, sha(`${system}\n${fewshot}`));
  assert.match(reply.reason, /high confidence/);
});

test('checkSlop fails closed when Ollama is unreachable', async () => {
  const { send } = loadWorker(async () => { throw new Error('ECONNREFUSED'); });
  assert.deepEqual(await send({ action: 'checkSlop', text: 'x' }), { isSlop: false, error: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: the first three worker tests FAIL. The two `saveRecord` tests reject with `no reply to saveRecord` after two seconds, and `checkSlop` lacks `verdict`. The fail-closed test passes already.

- [ ] **Step 3: Edit background.js**

After the line `const TIMEOUT_MS = 20000;` add:

```js
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
```

After the `RESPONSE_SCHEMA` constant add:

```js
// Identifies which prompt produced a verdict. It travels on every annotation
// record, so a label captured under one prompt is never read as a verdict of a
// later one. Computed once; the prompt does not change while the worker runs.
const PROMPT_HASH = sha256Hex(`${SYSTEM_PROMPT}\n${FEW_SHOT}`);
```

In `judge`, replace the `return { ... }` block with:

```js
    return {
      isSlop: parsed.verdict === "SLOP" && confident,
      verdict: parsed.verdict,
      confidence: parsed.confidence,
      model: MODEL,
      prompt_sha256: await PROMPT_HASH,
      reason: `Flagged as low-information filler (${parsed.confidence} confidence). Click to dismiss, Escape to clear the page.`
    };
```

After `judge` and before the `chrome.runtime.onMessage.addListener` call add:

```js
// Appends one annotation or dismissal record. Reads and writes are chained so
// two saves arriving together cannot each read the old array and drop the
// other's entry. A failed write does not poison the chain for the next one.
let storageChain = Promise.resolve();
function appendRecord(record) {
  const next = storageChain.catch(() => {}).then(async () => {
    const { records = [] } = await chrome.storage.local.get("records");
    records.push(record);
    await chrome.storage.local.set({ records });
  });
  storageChain = next;
  return next;
}

// The content script cannot hash on plain http pages, where crypto.subtle is
// missing, so the hash is added here where it is always available.
async function finishRecord(record) {
  return { ...record, text_sha256: await sha256Hex(record.text) };
}
```

Replace the whole `chrome.runtime.onMessage.addListener(...)` block with:

```js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "checkSlop") {
    judge(request.text)
      .then(sendResponse)
      .catch(error => {
        console.error("[slop] local model call failed:", error);
        // Fail closed: never flag when we could not get a real verdict.
        sendResponse({ isSlop: false, error: true });
      });
    return true; // tells Chrome the response is asynchronous
  }

  if (request.action === "saveRecord") {
    finishRecord(request.record)
      .then(appendRecord)
      .then(() => sendResponse({ ok: true }))
      .catch(error => {
        console.error("[slop] could not save record:", error);
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: `# pass 23`, `# fail 0`

- [ ] **Step 5: Confirm the eval still reads the prompt after the edit**

Run: `node -e "import('./eval/live_prompt.mjs').then(m => { const p = m.readLivePrompt(); console.log(p.system.length, p.fewshot.length); })"`
Expected: two positive numbers, no error.

- [ ] **Step 6: Commit**

```bash
git add background.js tests/background.test.mjs
git commit -m "Worker: hash the prompt, return the full verdict block, save annotation records

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end harness and fixture, written before the UI exists

**Files:**
- Create: `e2e/fixtures/page.html`
- Create: `e2e/run.mjs`
- Modify: `package.json` (add Playwright as a dev dependency; commit the resulting `package-lock.json`)

**Interfaces:**
- Consumes: the CSS class `ai-slop-flagged` from `slop.css`; the shadow host tag `ai-slop-annotator` with children `.pill`, `.popover`, `.saved` (Task 9); the options page ids `annotations`, `dismissals`, `disagreements`, `export` (Task 10); the triage CLI flags (Task 5).
- Produces: `npm run e2e`, exit 0 on success with a `PASS` line.

- [ ] **Step 1: Install Playwright without downloading browsers**

Run: `npm install --save-dev playwright@1.63.0 && node -e "console.log(require('playwright/package.json').version)"`
Expected: `1.63.0`. No browser download happens; the e2e uses the installed Google Chrome through `channel: 'chrome'`.

- [ ] **Step 2: Create the fixture page**

`e2e/fixtures/page.html`. The four paragraphs were run through the live prompt on 2026-09-06: both slop paragraphs return SLOP high, both real ones return REAL high. None share six words with the few-shot or appear in the corpus.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Slop fixture</title>
<style>
  body { max-width: 640px; margin: 40px auto; padding: 0 20px; font: 17px/1.6 Georgia, serif; }
</style>
</head>
<body>
<h1>Fixture page for the annotation flow</h1>
<p id="real-a">The dishwasher started tripping the breaker last Tuesday, so I pulled the kick plate and found the heating element terminal had corroded through. A replacement element from the appliance shop on Mill Road was 38 pounds. Twenty minutes with a socket set and it has run six loads since without a fault.</p>
<p id="slop-a">In a world that never stops moving, the organisations that thrive are the ones that embrace what comes next. Success is not a destination but a journey, and every step forward builds on the last. The future belongs to those bold enough to shape it, and the time to begin is now.</p>
<p id="real-b">Our build went from 14 minutes to 6 after we switched the CI runners from the shared pool to two dedicated 8-core machines and cached the node_modules directory between jobs. The cache key is a hash of package-lock.json, so a dependency bump still forces a clean install.</p>
<p id="slop-b">Great teams are built on trust, and trust is built one conversation at a time. When people feel valued, they bring their best selves to work, and when they bring their best selves, remarkable things happen. Culture is not what you say. It is what you do every single day.</p>
</body>
</html>
```

- [ ] **Step 3: Write the e2e script**

`e2e/run.mjs`:

```js
// End-to-end check of the extension in real Chrome against the local Ollama.
//
//   npm run e2e
//
// Loads the unpacked extension from the repo root into a fresh Chrome profile,
// serves the fixture page over http (content scripts do not run on file:// by
// default), waits for the model to flag both slop paragraphs, then labels one
// flagged paragraph Real, labels one clean paragraph Slop, dismisses the other
// flag, exports from the options page, and runs triage on the export against a
// scratch copy of the corpus. The real corpus.json is never touched.

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = fs.readFileSync(path.join(ROOT, 'e2e', 'fixtures', 'page.html'));
const step = msg => console.log(`  ${msg}`);

const ollama = await fetch('http://localhost:11434/api/tags').catch(() => null);
if (!ollama?.ok) {
  console.error('Ollama is not reachable at localhost:11434. Start it and pull qwen3:4b first.');
  process.exit(2);
}

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(FIXTURE);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-e2e-'));
const profile = path.join(scratch, 'profile');
const inbox = path.join(scratch, 'inbox');
fs.mkdirSync(inbox);
const corpusCopy = path.join(scratch, 'corpus.json');
const logCopy = path.join(scratch, 'log.json');
fs.copyFileSync(path.join(ROOT, 'eval', 'corpus.json'), corpusCopy);
fs.writeFileSync(logCopy, '{}\n');

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: false,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  step(`extension loaded as ${extensionId}`);

  const page = await context.newPage();
  await page.goto(pageUrl);
  await page.locator('#slop-a.ai-slop-flagged').waitFor({ timeout: 90_000 });
  await page.locator('#slop-b.ai-slop-flagged').waitFor({ timeout: 90_000 });
  step('both slop paragraphs flagged');
  assert.equal(await page.locator('p.ai-slop-flagged').count(), 2, 'only the two slop paragraphs are flagged');

  const pill = page.locator('ai-slop-annotator .pill');
  const popover = page.locator('ai-slop-annotator .popover');
  const saved = page.locator('ai-slop-annotator .saved');

  // The pill only appears once the paragraph has a verdict. Hover, and if it is
  // not there yet, move away and hover again until the verdict has arrived.
  async function revealPill(selector) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await page.mouse.move(5, 5);
      await page.locator(selector).hover();
      try {
        await pill.waitFor({ state: 'visible', timeout: 1500 });
        return;
      } catch { /* not judged yet */ }
    }
    throw new Error(`pill never appeared for ${selector}`);
  }

  async function label(selector, key, why) {
    await revealPill(selector);
    await pill.click();
    await popover.waitFor({ state: 'visible' });
    await page.keyboard.press(key);
    await page.keyboard.type(why);
    await page.keyboard.press('Enter');
    await saved.waitFor({ state: 'visible', timeout: 5000 });
    await popover.waitFor({ state: 'hidden', timeout: 5000 });
  }

  await label('#slop-a', 'r', 'e2e: flagged but real');
  await page.waitForFunction(() => !document.querySelector('#slop-a').classList.contains('ai-slop-flagged'));
  step('labelled a flagged paragraph Real; flag removed');

  await label('#real-a', 's', 'e2e: clean but slop');
  assert.equal(await page.locator('#real-a.ai-slop-flagged').count(), 0, 'labelling Slop draws nothing');
  step('labelled a clean paragraph Slop');

  await page.locator('#slop-b').click();
  await page.waitForFunction(() => !document.querySelector('#slop-b').classList.contains('ai-slop-flagged'));
  step('dismissed the other flag');

  assert.equal(await page.locator('ai-slop-annotator').count(), 1, 'exactly one host node on the page');

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForFunction(() => document.getElementById('annotations').textContent === '2');
  assert.equal(await options.locator('#dismissals').textContent(), '1');
  assert.equal(await options.locator('#disagreements').textContent(), '2');
  step('options page counts: 2 annotations, 1 dismissal, 2 disagreements');

  const [download] = await Promise.all([options.waitForEvent('download'), options.click('#export')]);
  assert.match(download.suggestedFilename(), /^slop-inbox-\d{8}-\d{4}\.jsonl$/);
  const exported = path.join(inbox, download.suggestedFilename());
  await download.saveAs(exported);
  const lines = fs.readFileSync(exported, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 3);
  for (const r of lines) {
    assert.match(r.text_sha256, /^[0-9a-f]{64}$/);
    assert.match(r.model.prompt_sha256, /^[0-9a-f]{64}$/);
    assert.equal(r.model.name, 'qwen3:4b');
    assert.equal(r.page.url, pageUrl);
    assert.equal(r.page.title, 'Slop fixture');
  }
  step(`exported ${lines.length} records`);

  const triageArgs = [path.join(ROOT, 'eval', 'triage.mjs'), `--inbox=${inbox}`, `--corpus=${corpusCopy}`, `--log=${logCopy}`];
  const summary = spawnSync(process.execPath, [...triageArgs, '--summary'], { encoding: 'utf8' });
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /new paragraphs: 3/);
  assert.match(summary.stdout, /false_positive {5}1/);
  assert.match(summary.stdout, /false_negative {5}1/);
  assert.match(summary.stdout, /dismissal_only {5}1/);
  step('triage summary classifies the three paragraphs');

  const walk = spawnSync(process.execPath, triageArgs, { input: 'p\n\np\nK_circular_claim\ns\n', encoding: 'utf8' });
  assert.equal(walk.status, 0, walk.stderr);
  assert.match(walk.stdout, /-> prod-001 in P_production/);
  assert.match(walk.stdout, /-> prod-002 in K_circular_claim/);
  const corpus = JSON.parse(fs.readFileSync(corpusCopy, 'utf8'));
  assert.equal(corpus.length, 65);
  assert.equal(corpus[63].label_quality, 'HUMAN');
  assert.equal(corpus[64].label_quality, 'SLOP');
  step('triage walk promoted two items into the scratch corpus');

  const untouched = spawnSync('git', ['status', '--short', 'eval/corpus.json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(untouched.stdout.trim(), '', 'the real corpus.json was not modified');

  console.log(`PASS  scratch files in ${scratch}`);
} finally {
  await context.close();
  server.close();
}
```

- [ ] **Step 4: Run it to verify it fails at the pill**

Run: `npm run e2e`
Expected: a Chrome window opens, the two flags appear, then the script fails with `pill never appeared for #slop-a` after about a minute. If it fails earlier at `both slop paragraphs flagged`, Ollama is slow to load the model; run it once more. Close the Chrome window if the script leaves it open.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json e2e/
git commit -m "Add Playwright end-to-end harness and fixture page for the annotation flow

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The capture UI: manifest, annotator.js, content.js

**Files:**
- Modify: `manifest.json`
- Create: `annotator.js`
- Modify: `content.js`

**Interfaces:**
- Consumes: `checkSlop` reply fields `verdict`, `confidence`, `isSlop`, `model`, `prompt_sha256` (Task 7); `saveRecord` message (Task 7).
- Produces: `window.SlopAnnotator = { showPill(element, onClick), hidePill(), isShowing(element), open({ element, excerpt, model, onSave, onCancel }), close(), isOpen(), isHost(node) }`. The host tag is `ai-slop-annotator` with children `.pill`, `.popover`, `.popover .saved`. Records built by `content.js` have every field from the spec except `text_sha256`, which the worker adds.

- [ ] **Step 1: Update the manifest**

Replace `manifest.json` with:

```json
{
  "manifest_version": 3,
  "name": "AI Slop Detector (Local)",
  "version": "1.2",
  "description": "Uses a local Ollama model to flag low-information filler text on the pages you read.",
  "permissions": [
    "storage"
  ],
  "host_permissions": [
    "http://localhost:11434/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "options_ui": {
    "page": "options.html",
    "open_in_tab": true
  },
  "content_scripts": [
    {
      "matches": [
        "<all_urls>"
      ],
      "js": [
        "annotator.js",
        "content.js"
      ],
      "css": [
        "slop.css"
      ],
      "run_at": "document_idle"
    }
  ]
}
```

- [ ] **Step 2: Write annotator.js**

```js
// The one node the extension adds to a page: a fixed-position host with a shadow
// root holding the "Label" pill and the annotation popover. Being fixed, it sits
// outside the page's layout, so showing or hiding it never moves anything.
//
// content.js decides which paragraphs are judged and when to show the pill. This
// file only draws, positions and collects the form. It exposes one global,
// SlopAnnotator, because content scripts cannot import modules.

(() => {
  const TAG = "ai-slop-annotator";
  const POPOVER_WIDTH = 320;
  const GAP = 6;
  const EDGE = 8;
  const HINT = "Enter saves, Esc cancels";

  const STYLE = `
    :host { all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none; }
    * { box-sizing: border-box; }
    .pill, .popover {
      position: fixed; pointer-events: auto;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #1f1f1f; background: #fff; border: 1px solid #c9c9c9; border-radius: 8px;
    }
    .pill { padding: 3px 10px; border-radius: 999px; cursor: pointer; font-size: 12px; user-select: none; }
    .pill:hover { border-color: #888; }
    .popover { width: ${POPOVER_WIDTH}px; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; outline: none; }
    .excerpt, .model, .hint { color: #666; font-size: 12px; }
    .excerpt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .model b { color: #b26b00; font-weight: 500; }
    .seg { display: inline-flex; border: 1px solid #888; border-radius: 8px; overflow: hidden; align-self: flex-start; }
    .seg button { all: unset; padding: 6px 14px; cursor: pointer; font: inherit; color: inherit; }
    .seg button + button { border-left: 1px solid #888; }
    .seg button[aria-pressed="true"] { background: #e6f1fb; color: #0c447c; }
    input { all: unset; font: inherit; color: inherit; border: 1px solid #c9c9c9; border-radius: 8px; padding: 7px 10px; width: 100%; }
    input:focus { border-color: #378add; }
    .row { display: flex; align-items: center; gap: 8px; }
    .hint { flex: 1; font-size: 11px; }
    .btn { all: unset; font: inherit; cursor: pointer; border: 1px solid #c9c9c9; border-radius: 8px; padding: 6px 12px; }
    .btn.save { border-color: #378add; color: #0c447c; }
    .saved { color: #1d9e75; font-size: 12px; }
    [hidden] { display: none !important; }
    @media (prefers-color-scheme: dark) {
      .pill, .popover { color: #eee; background: #1e1e1e; border-color: #555; }
      .excerpt, .model, .hint { color: #aaa; }
      .model b { color: #ffc046; }
      .seg button[aria-pressed="true"] { background: #0c447c; color: #e6f1fb; }
      input, .btn { border-color: #555; }
    }
  `;

  let host = null;
  let pill = null;
  let popover = null;
  let anchor = null;        // the paragraph the pill or popover belongs to
  let pillClick = null;     // content.js's handler for a click on the pill
  let saveHandler = null;
  let cancelHandler = null;
  let pillHovered = false;
  let choice = null;

  function ensureHost() {
    if (host) return;
    host = document.createElement(TAG);
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    root.append(style);

    pill = document.createElement("div");
    pill.className = "pill";
    pill.textContent = "Label";
    pill.hidden = true;
    pill.addEventListener("mouseenter", () => { pillHovered = true; });
    pill.addEventListener("mouseleave", event => {
      pillHovered = false;
      // Going back into the paragraph keeps the pill; content.js hides it when
      // the pointer leaves the paragraph itself.
      if (!isOpen() && !(anchor && anchor.contains(event.relatedTarget))) hidePill();
    });
    pill.addEventListener("click", event => {
      event.stopPropagation();
      if (pillClick && anchor) pillClick(anchor);
    });
    root.append(pill);

    popover = document.createElement("div");
    popover.className = "popover";
    popover.tabIndex = -1;
    popover.hidden = true;
    popover.innerHTML = `
      <div class="excerpt"></div>
      <div class="model"></div>
      <div class="seg" role="group" aria-label="Label">
        <button type="button" data-label="SLOP" aria-pressed="false"><u>S</u>lop</button>
        <button type="button" data-label="HUMAN" aria-pressed="false"><u>R</u>eal</button>
      </div>
      <input type="text" placeholder="Why? One sentence" aria-label="Explanation">
      <div class="row">
        <span class="hint">${HINT}</span>
        <button type="button" class="btn cancel">Cancel</button>
        <button type="button" class="btn save">Save</button>
      </div>
      <div class="saved" hidden>Saved</div>
    `;
    // Keys typed into the popover belong to it. Stopping them here keeps the
    // page's own shortcuts and content.js's Escape handler from also firing.
    for (const type of ["keydown", "keyup", "keypress"]) popover.addEventListener(type, e => e.stopPropagation());
    popover.addEventListener("keydown", onKey);
    popover.addEventListener("click", event => {
      event.stopPropagation();
      const seg = event.target.closest("[data-label]");
      if (seg) { pick(seg.dataset.label); return; }
      if (event.target.closest(".cancel")) cancel();
      else if (event.target.closest(".save")) save();
    });
    root.append(popover);

    document.documentElement.append(host);
    window.addEventListener("scroll", onViewportChange, { capture: true, passive: true });
    window.addEventListener("resize", onViewportChange, { passive: true });
    // Events from inside the shadow root reach the document retargeted to the
    // host, so anything else is a click outside.
    document.addEventListener("mousedown", event => {
      if (isOpen() && event.target !== host) cancel();
    }, true);
  }

  const place = (el, left, top) => {
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  };

  function placePill() {
    const r = anchor.getBoundingClientRect();
    const w = pill.offsetWidth;
    const h = pill.offsetHeight;
    place(pill, Math.min(Math.max(EDGE, r.right - w), window.innerWidth - w - EDGE), Math.max(EDGE, r.top - h / 2));
    return r;
  }

  function position() {
    if (!anchor || !isOpen()) return;
    const r = placePill();
    if (r.bottom < 0 || r.top > window.innerHeight) { cancel(); return; }
    const pw = popover.offsetWidth;
    const ph = popover.offsetHeight;
    const pillRect = pill.getBoundingClientRect();
    const left = Math.min(Math.max(EDGE, r.right - pw), window.innerWidth - pw - EDGE);
    let top = pillRect.bottom + GAP;
    if (top + ph > window.innerHeight - EDGE) top = pillRect.top - ph - GAP;
    place(popover, left, Math.max(EDGE, top));
  }

  function onViewportChange() {
    if (isOpen()) position();
    else if (pill && !pill.hidden) { pillHovered = false; pill.hidden = true; }
  }

  function isOpen() {
    return Boolean(popover) && !popover.hidden;
  }

  function isShowing(element) {
    return Boolean(pill) && !pill.hidden && anchor === element;
  }

  function showPill(element, onClick) {
    ensureHost();
    if (isOpen()) return;
    anchor = element;
    pillClick = onClick;
    pill.hidden = false;
    placePill();
  }

  function hidePill() {
    if (!pill || pillHovered || isOpen()) return;
    pill.hidden = true;
  }

  function open({ element, excerpt, model, onSave, onCancel }) {
    ensureHost();
    anchor = element;
    saveHandler = onSave;
    cancelHandler = onCancel ?? null;
    choice = null;
    for (const b of popover.querySelectorAll("[data-label]")) b.setAttribute("aria-pressed", "false");
    popover.querySelector(".excerpt").textContent = excerpt;
    const m = popover.querySelector(".model");
    m.textContent = "Model said ";
    const strong = document.createElement("b");
    strong.textContent = model.verdict === "SLOP" ? "Slop" : "Real";
    m.append(strong, `, ${model.confidence}`);
    popover.querySelector("input").value = "";
    popover.querySelector(".hint").textContent = HINT;
    popover.querySelector(".saved").hidden = true;
    if (pill.hidden) { pill.hidden = false; }
    popover.hidden = false;
    position();
    popover.focus();
  }

  function pick(label) {
    choice = label;
    for (const b of popover.querySelectorAll("[data-label]")) {
      b.setAttribute("aria-pressed", String(b.dataset.label === label));
    }
    popover.querySelector("input").focus();
  }

  function save() {
    const hint = popover.querySelector(".hint");
    if (!choice) { hint.textContent = "Pick Slop or Real first"; return; }
    const explanation = popover.querySelector("input").value.trim();
    Promise.resolve(saveHandler(choice, explanation)).then(
      () => {
        popover.querySelector(".saved").hidden = false;
        setTimeout(close, 1000);
      },
      () => { hint.textContent = "Could not save"; }
    );
  }

  function cancel() {
    const handler = cancelHandler;
    close();
    if (handler) handler();
  }

  function close() {
    if (!popover) return;
    popover.hidden = true;
    pill.hidden = true;
    pillHovered = false;
    anchor = null;
    saveHandler = null;
    cancelHandler = null;
    choice = null;
  }

  function onKey(event) {
    if (event.key === "Escape") { cancel(); return; }
    if (event.key === "Enter") { event.preventDefault(); save(); return; }
    if (event.target.tagName === "INPUT") return;
    if (event.key === "s" || event.key === "S") pick("SLOP");
    if (event.key === "r" || event.key === "R") pick("HUMAN");
  }

  window.SlopAnnotator = { showPill, hidePill, isShowing, open, close, isOpen, isHost: node => node === host };
})();
```

- [ ] **Step 3: Edit content.js**

After the `borrowedTitle` declaration add:

```js
// What the model said about each paragraph, kept so a label can be recorded
// alongside the verdict it disagrees or agrees with. Only paragraphs with an
// entry here get the Label pill.
const judged = new WeakMap();
const HOVER_DELAY_MS = 250;
```

In `scanPageForSlop`, replace the queued job:

```js
    queue.push(async () => {
      const response = await ask(text);
      if (!response || response.error) return;
      if (!element.isConnected) return;
      judged.set(element, {
        text,
        verdict: response.verdict,
        confidence: response.confidence,
        flagged: Boolean(response.isSlop),
        model: response.model,
        prompt_sha256: response.prompt_sha256
      });
      if (!response.isSlop) return;
      flag(element, response.reason ?? "Flagged as AI slop by the local model. Click to dismiss.");
    });
```

After `scanPageForSlop` and before the click listener add:

```js
// Records. The worker adds text_sha256, because crypto.subtle is missing on
// plain http pages and the worker always has it.
function recordId(kind) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return `${kind === "annotation" ? "ann" : "dis"}_${stamp}_${Math.random().toString(36).slice(2, 6)}`;
}

function buildRecord(kind, info, label, explanation) {
  return {
    id: recordId(kind),
    kind,
    label_quality: label,
    explanation,
    text: info.text,
    model: {
      name: info.model,
      verdict: info.verdict,
      confidence: info.confidence,
      flagged: info.flagged,
      prompt_sha256: info.prompt_sha256
    },
    page: { url: location.href, title: document.title },
    created_at: new Date().toISOString()
  };
}

function saveRecord(record) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "saveRecord", record }, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error ?? "save failed"));
      resolve();
    });
  });
}

function openAnnotation(paragraph) {
  const info = judged.get(paragraph);
  if (!info) return;
  SlopAnnotator.open({
    element: paragraph,
    excerpt: info.text.slice(0, 90),
    model: { verdict: info.verdict, confidence: info.confidence },
    onSave: async (label, explanation) => {
      await saveRecord(buildRecord("annotation", info, label, explanation));
      // The reader called a flagged paragraph Real. Their word beats the model's,
      // and the annotation already says so, so no dismissal record is written.
      if (label === "HUMAN" && paragraph.classList.contains(FLAG_CLASS)) unflag(paragraph);
    }
  });
}

// Hover a judged paragraph for a moment and the Label pill appears at its top
// right corner. Both listeners are delegated and neither stops propagation.
let hoverTimer = null;
document.addEventListener("mouseover", event => {
  const paragraph = event.target.closest?.("p");
  if (!paragraph || !judged.has(paragraph)) return;
  if (SlopAnnotator.isOpen() || SlopAnnotator.isShowing(paragraph)) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => SlopAnnotator.showPill(paragraph, openAnnotation), HOVER_DELAY_MS);
});

document.addEventListener("mouseout", event => {
  const paragraph = event.target.closest?.("p");
  if (!paragraph || !judged.has(paragraph)) return;
  // Moving within the paragraph, or onto the pill itself, is not leaving.
  if (paragraph.contains(event.relatedTarget) || SlopAnnotator.isHost(event.relatedTarget)) return;
  clearTimeout(hoverTimer);
  SlopAnnotator.hidePill();
});
```

In the click listener, after `unflag(element);` add:

```js
  // A dismissal is a weak signal that the flag was wrong. Record it; triage
  // decides what it means.
  const info = judged.get(element);
  if (info) {
    saveRecord(buildRecord("dismissal", info, null, "")).catch(error => {
      console.warn("[slop] dismissal not saved:", error.message);
    });
  }
```

In the Escape listener, after `if (event.key !== "Escape") return;` add:

```js
  // The popover owns Escape while it is open. Its own handler also stops the
  // event, so this is a second guard rather than the only one.
  if (SlopAnnotator.isOpen()) return;
```

- [ ] **Step 4: Syntax check both scripts and run the unit tests**

Run: `node --check annotator.js && node --check content.js && npm test`
Expected: no syntax errors; `# pass 23`, `# fail 0`

- [ ] **Step 5: Run the e2e to verify it now reaches the options page**

Run: `npm run e2e`
Expected: the steps up to `dismissed the other flag` and `exactly one host node` pass, then the script fails with a navigation or `waitForFunction` error on `options.html`, because the page does not exist yet.

If it fails earlier, read the message. The likely causes and fixes:
- `pill never appeared`: check the Chrome window for a console error in the content script (open DevTools on the fixture tab).
- `.saved` never visible: `saveRecord` rejected. Open `chrome://extensions`, click the service worker link for the extension, and read its console.

- [ ] **Step 6: Commit**

```bash
git add manifest.json annotator.js content.js
git commit -m "Add the Label pill and popover: annotate any judged paragraph as Slop or Real

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The options page: counts, export, clear

**Files:**
- Create: `options.html`
- Create: `options.js`

**Interfaces:**
- Consumes: the `records` array and `lastExportAt` key in chrome.storage.local (Task 7 shape).
- Produces: element ids `annotations`, `dismissals`, `disagreements`, `bytes`, `export`, `clear`, `status`. Export downloads `slop-inbox-YYYYMMDD-HHMM.jsonl`.

- [ ] **Step 1: Write options.html**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AI Slop Detector: annotations</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 560px; margin: 40px auto; padding: 0 20px; color: #1f1f1f; background: #fff; }
  h1 { font-size: 18px; font-weight: 500; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin: 20px 0; }
  .stat { background: #f4f4f2; border-radius: 8px; padding: 12px 14px; }
  .stat .label { color: #666; font-size: 12px; }
  .stat .value { font-size: 24px; font-weight: 500; }
  button { font: inherit; padding: 8px 14px; border: 1px solid #888; border-radius: 8px; background: #fff; color: inherit; cursor: pointer; margin-right: 8px; }
  button:disabled { opacity: 0.5; cursor: default; }
  p.note { color: #666; font-size: 13px; }
  code { font-size: 12px; }
  @media (prefers-color-scheme: dark) {
    body { color: #eee; background: #1e1e1e; }
    .stat { background: #2a2a2a; }
    .stat .label, p.note { color: #aaa; }
    button { background: #1e1e1e; border-color: #666; }
  }
</style>
</head>
<body>
<h1>Annotations</h1>
<div class="grid">
  <div class="stat"><div class="label">Annotations</div><div class="value" id="annotations">0</div></div>
  <div class="stat"><div class="label">Dismissals</div><div class="value" id="dismissals">0</div></div>
  <div class="stat"><div class="label">Disagree with the model</div><div class="value" id="disagreements">0</div></div>
  <div class="stat"><div class="label">Storage used</div><div class="value" id="bytes">0 KB</div></div>
</div>
<button id="export">Export JSONL</button>
<button id="clear" disabled>Clear exported</button>
<p class="note" id="status">Drop the exported file into <code>eval/inbox/</code> and run <code>node eval/triage.mjs</code>.</p>
<script src="options.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write options.js**

```js
// Shows what has been captured and gets it out as a JSONL file for eval/inbox/.

const $ = id => document.getElementById(id);
const DEFAULT_STATUS = "Drop the exported file into eval/inbox/ and run node eval/triage.mjs.";

async function load() {
  const { records = [], lastExportAt = null } = await chrome.storage.local.get(["records", "lastExportAt"]);
  const annotations = records.filter(r => r.kind === "annotation");
  // The reader disagreed when their label points the other way from what the
  // extension drew on the page.
  const disagreements = annotations.filter(r => (r.label_quality === "SLOP") !== Boolean(r.model.flagged));
  $("annotations").textContent = annotations.length;
  $("dismissals").textContent = records.filter(r => r.kind === "dismissal").length;
  $("disagreements").textContent = disagreements.length;
  const bytes = await chrome.storage.local.getBytesInUse(null);
  $("bytes").textContent = `${(bytes / 1024).toFixed(1)} KB`;
  $("clear").disabled = !lastExportAt || !records.some(r => r.created_at <= lastExportAt);
  return { records, lastExportAt };
}

function stamp(date) {
  const two = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`;
}

$("export").addEventListener("click", async () => {
  const { records } = await load();
  if (records.length === 0) { $("status").textContent = "Nothing to export yet."; return; }
  const now = new Date();
  const body = records.map(r => JSON.stringify(r)).join("\n") + "\n";
  const url = URL.createObjectURL(new Blob([body], { type: "application/x-ndjson" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `slop-inbox-${stamp(now)}.jsonl`;
  link.click();
  // Revoking straight away can cancel the download in some builds. Give it time.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  await chrome.storage.local.set({ lastExportAt: now.toISOString() });
  $("status").textContent = `Exported ${records.length} record(s). ${DEFAULT_STATUS}`;
  await load();
});

$("clear").addEventListener("click", async () => {
  const { records, lastExportAt } = await load();
  const keep = records.filter(r => r.created_at > lastExportAt);
  const removing = records.length - keep.length;
  if (!confirm(`Delete ${removing} exported record(s)? Anything saved after the last export is kept.`)) return;
  await chrome.storage.local.set({ records: keep });
  $("status").textContent = `Removed ${removing} record(s), kept ${keep.length}.`;
  await load();
});

load();
```

- [ ] **Step 3: Run the full e2e**

Run: `npm run e2e`
Expected: every step line prints, ending in `PASS  scratch files in /var/folders/...`. Then `git status --short eval/corpus.json` prints nothing.

- [ ] **Step 4: Check the Clear button by hand in the e2e profile**

The e2e never presses Clear, and it closes its profile when it finishes. Check the button with a one-off Playwright snippet that seeds storage directly:

```bash
node --input-type=module -e "
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const ROOT = process.cwd();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-clear-'));
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, args: ['--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
await sw.evaluate(() => chrome.storage.local.set({ records: [
  { id: 'a', kind: 'annotation', label_quality: 'SLOP', model: { flagged: false }, created_at: '2026-09-06T10:00:00.000Z' },
  { id: 'b', kind: 'dismissal', label_quality: null, model: { flagged: true }, created_at: '2026-09-06T10:01:00.000Z' },
], lastExportAt: '2026-09-06T10:00:30.000Z' }));
const page = await ctx.newPage();
page.on('dialog', d => d.accept());
await page.goto('chrome-extension://' + id + '/options.html');
await page.waitForFunction(() => document.getElementById('annotations').textContent === '1');
console.log('clear enabled:', !(await page.locator('#clear').isDisabled()));
await page.click('#clear');
await page.waitForFunction(() => document.getElementById('annotations').textContent === '0');
console.log('after clear:', await page.locator('#status').textContent(), '| dismissals:', await page.locator('#dismissals').textContent());
await ctx.close();
"
```

Expected:

```
clear enabled: true
after clear: Removed 1 record(s), kept 1. | dismissals: 1
```

- [ ] **Step 5: Commit**

```bash
git add options.html options.js
git commit -m "Add the options page: counts, JSONL export, clear exported records

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Document the loop

**Files:**
- Modify: `eval/README.md` (append a section after "Reading the score" and before "Two things this model cannot see", and add the new commands to "Running it")

- [ ] **Step 1: Add the production annotations section**

Insert before the heading `## Two things this model cannot see`:

```markdown
## Production annotations

The extension lets the reader label any judged paragraph on a real page as Slop or Real,
with a one sentence reason. Hover a paragraph, click the Label pill, pick, type, Enter. A
dismissed flag is also recorded, as a weaker signal. Every record carries what the model
said about that same paragraph, the model name, and a hash of the prompt in force.

The loop:

1. Read with the extension on. Label paragraphs when you disagree with the model, and
   sometimes when you agree, so agreements are represented too.
2. Open the extension's options page, export, and drop the file into `eval/inbox/`.
3. `node eval/triage.mjs --summary` prints the counts by class and a calibration table:
   what the model said against what you said, and the precision and flag rate each
   `MIN_CONFIDENCE` setting would have had on these paragraphs.
4. `node eval/triage.mjs` walks the new paragraphs, disagreements first. Promote, reject or
   skip. Promoted items get `prod-NNN` ids, `label_provenance: "UNKNOWN"`, and a `source`
   block with the URL, your explanation and the model's verdict at capture.
5. `node eval/run.mjs --arm=v3 --model=qwen3:4b --split=prod` then
   `python3 eval/score.py eval/results_v3_qwen3_4b.json quality --split=prod` scores the
   production items on their own.

Two rules. Production items never go into the few-shot; triage warns when a paragraph
shares six consecutive words with an example and needs `p!` to promote it. And
disagreements are triaged before agreements, because they are the items that move the
score.

Decisions live in `eval/triage_log.json`, keyed by text hash, so re-running triage on the
same inbox files asks nothing twice. Inbox files are append-only and are never modified.

`npm test` runs the triage and worker unit tests. `npm run e2e` drives the extension in
Chrome against the local Ollama, labels two paragraphs, dismisses a flag, exports, and runs
triage on the export against a scratch copy of the corpus.
```

- [ ] **Step 2: Add the split flag to "Running it"**

After the paragraph that starts with `` `--min-confidence=high` flags less `` add:

```markdown
`--split=prod` runs or scores only the items promoted from reader annotations, and
`--split=synthetic` only the hand-written ones. Both `run.mjs` and `score.py` accept it.
```

- [ ] **Step 3: Check for em dashes in everything written by this plan**

Run: `grep -rn $'—' --include='*.md' --include='*.js' --include='*.mjs' --include='*.py' --include='*.html' --include='*.json' . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs --exclude=corpus.json --exclude='results_*.json' --exclude-dir=prompts`
Expected: only lines in `eval/README.md` that existed before this work (the prompt lineage list and the headline results). Any hit in a file this plan created or in text this plan added is a defect to fix.

- [ ] **Step 4: Commit**

```bash
git add eval/README.md
git commit -m "README: document the annotation loop, triage, and the production split

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Final verification and push

**Files:**
- None new. Memory note update at `/Users/esia/.claude/projects/-Users-esia-repos-ai-slop/memory/`.

- [ ] **Step 1: Run everything from a clean state**

```bash
npm test && npm run e2e && node eval/triage.mjs --summary && git status --short
```

Expected: `# fail 0`; `PASS` from the e2e; `records read: 0`; and `git status --short` prints nothing.

- [ ] **Step 2: Load the extension by hand once**

Open `chrome://extensions`, enable Developer mode, Load unpacked, choose `/Users/esia/repos/ai-slop`. If an extension from an earlier session is already loaded from this directory, click its reload button instead. Open any article, wait for a flag, hover a paragraph and confirm the pill appears at its top right and the popover opens as an overlay that moves nothing on the page. Press Escape and confirm only the popover closes and the flags stay. Then press Escape again with no popover open and confirm all flags clear. Report what you saw.

- [ ] **Step 3: Update the project memory**

Add a memory file `annotation-flywheel-shipped.md` with type `project`, saying that as of 2026-09-06 the annotation flywheel exists: pill and popover in `annotator.js`, records in chrome.storage.local, `eval/triage.mjs` promotes into `corpus.json` with `prod-NNN` ids, and that the two open holes from `ai-slop-detector-open-holes` are now what production labels are meant to fill. Link `[[ai-slop-detector-open-holes]]`. Add its line to `MEMORY.md`.

- [ ] **Step 4: Push**

```bash
git push origin main && git log --oneline origin/main | head -15
```

Expected: the twelve task commits plus the initial one appear on `origin/main`.
