# Annotation flywheel: design

Date: 2026-09-06
Status: approved in brainstorm, awaiting implementation plan

## Goal

Let the reader label any judged paragraph on a real page as Slop or Real, with a one
sentence reason, and turn those labels into corpus items the eval harness can score. The
corpus today is 63 hand-written items. This adds a path for production paragraphs to
enter it, with the model's verdict at capture time recorded alongside each label so
disagreements can be measured and acted on.

## Decisions made in brainstorm

| question | decision |
| --- | --- |
| who annotates, where data lives | one person, local only; chrome.storage.local buffer, file export into `eval/inbox/` |
| what can be annotated | any `<p>` the model has judged, flagged or not |
| labels collected | quality only (Slop or Real) plus a free text explanation |
| dismiss click | recorded as a separate weak signal, never promoted without triage |
| page context stored | URL, title and text |
| capture UI | hover pill at the paragraph's top right corner, floating popover; overlay only, no reflow |
| transport to `eval/` | manual export and file drop; no companion server |

## Non-goals

- No provenance label from the reader. The corpus keeps its `label_provenance` field and
  production items set it to `UNKNOWN`.
- No shared or remote storage. The record schema has an id and a text hash so files from
  several machines could merge later, but nothing is built for that now.
- No automatic promotion. Every record that enters `corpus.json` passes through the triage
  walk.
- No changes to the detector prompt or model in this work.

## Components

### 1. The record

One record per capture. In storage it is one array entry under the `records` key. In an
export it is one JSONL line.

```json
{
  "id": "ann_20260906T141200Z_x7k2",
  "kind": "annotation",
  "label_quality": "SLOP",
  "explanation": "Says communication matters, names nothing.",
  "text": "the exact text that was sent to the model",
  "text_sha256": "hex",
  "model": {
    "name": "qwen3:4b",
    "verdict": "REAL",
    "confidence": "medium",
    "flagged": false,
    "prompt_sha256": "hex"
  },
  "page": { "url": "https://example.com/post", "title": "Post title" },
  "created_at": "2026-09-06T14:12:00.000Z"
}
```

Rules:

- `kind` is `annotation` or `dismissal`. A dismissal has `label_quality: null` and
  `explanation: ""`. Dismissals only happen on flagged paragraphs.
- `label_quality` uses the corpus vocabulary, `SLOP` or `HUMAN`. The UI buttons read Slop
  and Real. The mapping Real to HUMAN happens once, when the record is built.
- `model.verdict` keeps what the model literally returned, `SLOP` or `REAL`.
- `model.flagged` is the verdict after the `MIN_CONFIDENCE` gate. It is stored separately
  from the verdict so a different gate can be evaluated against real pages later.
- `text` is the string that was sent to the model: `innerText`, trimmed, sliced to 4000
  characters. It is not re-read from the DOM at annotation time.
- `text_sha256` is the hex SHA-256 of `text`. It is the dedupe key everywhere.
- `model.prompt_sha256` is the hex SHA-256 of `SYSTEM_PROMPT + "\n" + FEW_SHOT`, computed
  once when the worker starts.
- `id` is `ann_` or `dis_` plus a compact UTC timestamp plus four random base36 characters.

### 2. Capture UI

**State.** `content.js` keeps a `WeakMap` from paragraph element to
`{ text, verdict, confidence, flagged, model, prompt_sha256 }`. An entry is written when
the verdict arrives. Paragraphs that errored or are still queued have no entry and get no
control.

**Host.** A single custom element, `ai-slop-annotator`, is appended to
`document.documentElement` on first hover and stays for the life of the page, hidden when
idle. It has a shadow root with its own stylesheet. It is `position: fixed` with the
highest z-index, so it lives outside the page's layout and opening it causes no reflow.
The content script continues to write nothing to page elements beyond the flag class and
title it already manages.

**Pill.** Hovering a judged paragraph for 250 ms shows a small pill reading "Label" at
the paragraph's top right corner, positioned from `getBoundingClientRect`. The pill hides
when the pointer leaves both the paragraph and the pill, and on scroll.

**Popover.** Clicking the pill opens a popover anchored below the pill. If there is not
enough room below, it opens above. It contains:

- the first line of the paragraph in muted text, so the reader knows what is being labelled
- the model's verdict and confidence, for example "Model said Slop, medium"
- a two-way segmented control: Slop, Real
- a single line text field with the placeholder "Why? One sentence"
- Save and Cancel

Keyboard: S and R pick a label, Enter saves, Escape cancels. Save requires a label. The
explanation may be empty, but the field shows a hint when it is.

Scroll and resize reposition an open popover. If the paragraph leaves the viewport, the
popover closes.

**Save.** The content script builds the record and sends `{ action: "saveRecord",
record }` to the worker. The popover shows "Saved" for one second and closes. If the
paragraph was flagged and the label is Real, the flag is removed and no dismissal record is
written, because the annotation is the stronger signal. If the paragraph was not flagged
and the label is Slop, nothing visual changes.

**Dismissal.** The existing click to dismiss handler also sends a dismissal record.
Escape to clear all flags writes nothing.

**Escape conflict.** While the popover is open, Escape closes the popover and the existing
clear-all handler does not run.

**Repeat labels.** Labelling the same paragraph twice stores two records. Triage keeps the
latest. No client-side dedupe.

**Files.** The custom element, its stylesheet and the popover logic live in a new content
script `annotator.js`, listed in the manifest before `content.js`, exposing one global.
`content.js` owns the WeakMap, the hover detection, dismissal logging and the Escape
scoping. `background.js` computes the prompt hash and returns the richer verdict block.

### 3. Storage and export

**Manifest.** Add `"permissions": ["storage"]` and an options page opened in a tab.

**Worker.** `checkSlop` responses gain `verdict`, `model` and `prompt_sha256` next to the
existing `isSlop`, `confidence` and `reason`. A new `saveRecord` message appends to the
`records` array in chrome.storage.local. Writes go through a promise chain so two quick
saves cannot overwrite each other.

**Options page.** Shows four numbers: annotations, dismissals, disagreements (annotations
where `label_quality` disagrees with `model.flagged`), and storage used. Two buttons:

- Export downloads every record as JSONL, named `slop-inbox-YYYYMMDD-HHMM.jsonl`, and
  remembers the export time.
- Clear exported removes records with `created_at` at or before the last export time,
  after a confirm dialog. Records saved during or after the export survive.

**Inbox.** The reader drops exported files into `eval/inbox/`. Files there are append-only
history. Triage reads them and never modifies them. The directory ships with a short
README explaining this.

### 4. Triage

`node eval/triage.mjs` reads every `eval/inbox/*.jsonl` file and `eval/triage_log.json`,
then walks the reader through what is new.

1. **Collapse.** Group records by `text_sha256`. The latest annotation for a hash wins.
   Dismissals attach to it as a count. Hashes with dismissals and no annotation form a
   separate list.
2. **Drop what is known.** Skip any hash already present in `corpus.json` (hash the
   corpus text the same way) or already decided in the log.
3. **Summarise.** Print counts by class:
   - false positive: `model.flagged` true, label HUMAN
   - false negative: `model.flagged` false, label SLOP
   - agree slop, agree human
   - dismissal only

   Then a calibration table: rows are model confidence (low, medium, high) crossed with
   model verdict, columns are the reader's label. Below it, for each possible
   `MIN_CONFIDENCE` setting, the precision and flag rate the gate would have produced on
   these paragraphs. `--summary` prints this and exits.
4. **Walk.** Disagreements first, then agreements. For each item print the text, the page
   URL and title, the explanation, the model block and the dismissal count. Prompt for
   `p` promote, `r` reject, `s` skip. Promote asks for a bucket, default `P_production`,
   listing the existing bucket names so an item can join one of them.
5. **Guard.** If the text shares a run of six or more consecutive words with any few-shot
   example, warn and require `p!` to promote. Production items are never copied into the
   few-shot. The README already records that contamination inflates the score.
6. **Write.** Promoted items are appended to `corpus.json` with the next free `prod-NNN`
   id, three digits, zero padded. The corpus keeps its two-space indent. Every decision,
   including rejects, is appended to `eval/triage_log.json` as
   `{ [sha]: { decision, id, at } }`.

Dismissal-only paragraphs come in a second pass with default skip. Promoting one records it
as HUMAN with the explanation "dismissed by reader".

**Promoted item shape.**

```json
{
  "id": "prod-001",
  "label": "SLOP",
  "bucket": "K_circular_claim",
  "text": "...",
  "label_provenance": "UNKNOWN",
  "label_quality": "SLOP",
  "source": {
    "url": "https://example.com/post",
    "title": "Post title",
    "annotated_at": "2026-09-06T14:12:00.000Z",
    "explanation": "Says communication matters, names nothing.",
    "dismissals": 0,
    "model_at_capture": {
      "name": "qwen3:4b",
      "verdict": "REAL",
      "confidence": "medium",
      "flagged": false,
      "prompt_sha256": "hex"
    }
  }
}
```

`label` is set to the quality label. On the existing items `label` follows provenance, but
production items have no known provenance, and the field is only read in two places:
`run.mjs` uses it for the dot-or-x progress marks, and `score.py` uses it as a fallback when
the requested axis field is missing. Both axis fields are always present on production
items, so the score is unaffected and the progress marks stay meaningful.

**Code layout.** Pure logic (collapse, classify, calibration, guard, next id, merge into
corpus) lives in `eval/triage_lib.mjs`. The readline walk and file IO live in
`eval/triage.mjs`. Tests in `eval/triage_lib.test.mjs` run with `node --test eval/`.

### 5. Eval integration

- `score.py` gains `--split=prod|synthetic|all`, default `all`. Production means the item
  has a `source` field. It also skips items whose label on the chosen axis is not `SLOP`
  or `HUMAN`, so `UNKNOWN` provenance cannot distort the provenance axis.
- `run.mjs` gains the same `--split` flag.
- `README.md` in `eval/` gains a section describing the loop and its two rules: production
  items never go into the few-shot, and disagreements are triaged first.

## The loop

1. Read pages with the extension on. Label paragraphs when you disagree with the model,
   and sometimes when you agree, so agreements are represented too. Dismiss flags as
   before.
2. Open the options page, export, drop the file in `eval/inbox/`.
3. `node eval/triage.mjs --summary` to see the counts and the calibration table.
4. `node eval/triage.mjs` to promote.
5. `node eval/run.mjs --arm=v3 --model=qwen3:4b` then
   `python3 eval/score.py <results> quality --split=prod`.
6. Change the prompt, the confidence gate, or the model. The prompt hash on future records
   ties each captured verdict to the prompt that produced it.

What the data answers over time: the real false positive rate on pages actually read, how
often the two known holes (circular claims, em dashes) appear in the wild, where
`MIN_CONFIDENCE` should sit, which sites produce the most slop, and whether a larger model
is worth its latency. With a few hundred labelled production paragraphs the inbox becomes
fine-tuning data.

## Privacy note

Records hold the URL and title of pages the reader was on. The repository at
`github.com/edward-sia/ai-slop` is public. Inbox files and promoted corpus items are
committed by default. If that is not wanted, add `eval/inbox/*.jsonl` to `.gitignore`
and be selective at promotion time.

## Testing

- `node --test eval/` covers the triage library: collapse with latest-wins, dropping known
  hashes, the five classes, the calibration table, the six word guard, id assignment
  across gaps, and the merge into a corpus copy.
- The extension is verified by loading it unpacked in Chrome and running one full pass:
  open a page, wait for verdicts, hover, label one paragraph Slop and one Real, dismiss a
  flag, open the options page, check the four numbers, export, drop the file in the inbox,
  run triage, promote one item, run the eval on the production split.

## Files

New: `annotator.js`, `options.html`, `options.js`, `eval/triage.mjs`,
`eval/triage_lib.mjs`, `eval/triage_lib.test.mjs`, `eval/inbox/README.md`,
`eval/triage_log.json`.

Edited: `manifest.json`, `background.js`, `content.js`, `eval/score.py`, `eval/run.mjs`,
`eval/README.md`.
