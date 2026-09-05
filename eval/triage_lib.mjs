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
