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
