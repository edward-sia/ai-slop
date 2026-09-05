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
