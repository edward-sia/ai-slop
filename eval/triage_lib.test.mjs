import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex, collapse, classify, CLASSES, corpusHashes, dropKnown, nextProdId, toCorpusItem, countByClass, calibration, shingles, sharesRun } from './triage_lib.mjs';

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
