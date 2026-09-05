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
import readline from 'node:readline';
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

// Lines are queued as they arrive, so answers piped in all at once are not lost
// between questions. ask() resolves null once the input has closed.
function makePrompter(input, output) {
  const rl = readline.createInterface({ input, output });
  const waiting = [];
  const lines = [];
  let closed = false;
  rl.on('line', line => (waiting.length ? waiting.shift()(line) : lines.push(line)));
  rl.on('close', () => { closed = true; while (waiting.length) waiting.shift()(null); });
  return {
    ask(prompt) {
      output.write(prompt);
      if (lines.length) return Promise.resolve(lines.shift());
      if (closed) return Promise.resolve(null);
      return new Promise(resolve => waiting.push(resolve));
    },
    close: () => rl.close(),
  };
}

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

// Returns false when the input closed before the walk finished.
async function walk(prompter, items, corpus, log, fewshot, { defaultLabel = null } = {}) {
  const buckets = [...new Set(corpus.map(i => i.bucket))].sort();
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    show(item, i, items.length);
    const tainted = sharesRun(item.latest.text, fewshot);
    if (tainted) console.log('  WARNING: shares a run of six words with a few-shot example. Type p! to promote anyway.');
    const raw = await prompter.ask('  [p]romote  [r]eject  [s]kip > ');
    if (raw === null) return false;
    const answer = raw.trim();
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
    const rawBucket = await prompter.ask(`  bucket [${DEFAULT_BUCKET}] > `);
    if (rawBucket === null) return false;
    const bucket = rawBucket.trim() || DEFAULT_BUCKET;
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
  return true;
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

const prompter = makePrompter(stdin, stdout);
let completed = await walk(prompter, annotated, corpus, log, fewshot);
if (completed && dismissedOnly.length) {
  console.log(`\n${dismissedOnly.length} paragraph(s) were dismissed but never labelled. Promoting one records it as HUMAN.`);
  completed = await walk(prompter, dismissedOnly, corpus, log, fewshot, { defaultLabel: 'HUMAN' });
}
prompter.close();
if (!completed) console.log('\ninput closed, stopping');
console.log(`\ndone. corpus now has ${corpus.length} items.`);
