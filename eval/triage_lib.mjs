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
