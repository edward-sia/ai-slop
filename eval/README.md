# Eval harness

Measures how well a given model and prompt separate low-information filler from real
writing, so prompt changes can be checked instead of guessed at.

## Running it

Ollama must be running with the model pulled.

```
node eval/run.mjs --arm=v3 --model=qwen3:4b
python3 eval/score.py eval/results_v3_qwen3_4b.json quality
```

`--arm=v3` reads `SYSTEM_PROMPT` and `FEW_SHOT` straight out of `background.js`, so editing
the prompt changes what the eval measures. `--arm=v1` replays the original design for
comparison: instructions glued onto the front of the text, free-form reply, decision by
`.includes("YES")`.

To attribute a change, swap one half at a time and compare with `compare.py`:

```
node eval/run.mjs --arm=v3 --system=system_v5.txt --fewshot=fewshot_clean.txt --tag=mine
python3 eval/compare.py eval/results_shipped_qwen3_4b.json eval/results_mine_qwen3_4b.json
```

`--min-confidence=high` flags less. `--min-confidence=low` flags more. That is the
precision knob, and it needs no prompt change.

`--split=prod` runs or scores only the items promoted from reader annotations, and
`--split=synthetic` only the hand-written ones. Both `run.mjs` and `score.py` accept it.

## Results

49 paragraphs, graded on the quality axis. Every run below uses the decontaminated
few-shot, so no example closely mirrors a corpus item.

| model | prompt | accuracy | precision | recall | median latency |
| --- | --- | --- | --- | --- | --- |
| tinyllama | original | 46.9% | 44.4% | 53.3% | 958ms |
| qwen3:4b | original | 62.5% | 66.7% | 40.0% | 20156ms |
| qwen3:4b | shipped | **95.9%** | **100%** | 91.7% | 394ms |

The corpus later grew to 63. On that set the shipped prompt scores 88.9% at 100% precision,
and the drop is entirely the fourteen items in `K` through `N` described below.

| prompt | corpus | accuracy | precision | recall |
| --- | --- | --- | --- | --- |
| shipped (v6) | 63 | 88.9% | 100% | 78.1% |
| v7 | 63 | 88.9% | 96.3% | 81.2% |
| v8 | 63 | 87.3% | 100% | 75.0% |

tinyllama cannot do this task at any prompt. With constrained decoding it returns the same
verdict for all 49 inputs, and on the two most obvious cases it answers backwards. The
46.9% above is noise: 13 of its 18 flags came from the model quoting its own instruction
line, which contains the word YES.

## Two labels per paragraph

Each item carries `label_provenance` (was it machine-written) and `label_quality` (is the
paragraph empty). They disagree on seven items, and that disagreement is the point.
`aiq-06` is machine-written and genuinely useful. `hfm-03` is a human speech that says
nothing. A detector has to pick one axis. `background.js` judges quality, so grade against
`quality` unless you are deliberately testing the other question.

## The corpus

| bucket | what it catches |
| --- | --- |
| `A_classic_ai_slop` | hype vocabulary and empty conclusions |
| `B_human_casual` | blunt, messy, first-person writing |
| `C_human_formal_triggerwords` | legal and academic prose using *moreover*, *paramount* legitimately |
| `D_ai_written_but_informative` | machine text that is actually useful and must not be flagged |
| `E_prompt_injection` | page text instructing the model to answer a certain way |
| `F_nonprose_neutral` | cookie notices, shipping terms, biographies |
| `G_hard_human` | terse factual writing, plain without being empty |
| `H_empty_no_keywords` | clean polite prose that states nothing |
| `I_structural_tells` | binary contrast, colon reveal, negative listing, faux insight |
| `J_human_resembling_tells` | humans using those same shapes to deliver real facts |
| `K_circular_claim` | the subject and the object of the sentence are the same thing |
| `L_circular_real` | the same self-referential shape carrying real facts |
| `M_em_dash_slop` | em dashes in a paragraph that says nothing |
| `N_em_dash_human` | em dashes in academic, personal and technical writing |

`C` and `D` catch the keyword trap in both directions. `I` and `J` are a matched pair: `I`
must be flagged and `J` must not, and a prompt that pattern-matches on sentence shape alone
will fail `J`.

## Prompt lineage

`prompts/` keeps each version so regressions stay visible.

- `system_v3` — structural taxonomy added. 83.7%.
- `system_v4` — tried making the substitutability test primary and compressing the
  structural list. **Regression to 77.6%**, kept as a warning. Casual human writing dropped
  to 3/7 because an aggressive fact requirement flags opinion-only personal writing.
- `system_v5` — v3 plus a sharper emptiness test and a carve-out for transactional
  notices. 87.8%.
- `system_v6` — v5 plus two changes: sentence-shape tells may fire on their own when the
  claim is generic, and first-person informal writing is never flagged. 95.9%. This is what
  `background.js` ships.

- `system_v7` — the circular claim written into Test 1 as prose, plus an em dash rule.
  **No gain on either target bucket and precision fell to 96.3%**, because the extra prose
  raised the model's general suspicion rather than teaching it a shape: it fixed `empty-04`
  and broke `hfm-01`, a legal brief.
- `system_v8` — the same two rules cut down to Test 2 bullets, matching the format the model
  demonstrably applies. Precision held at 100% and `K` and `M` did not move at all. Cost one
  item in `I`. **87.3%.**
- `system_v9` — v8 plus an em dash count measured in code and passed in a `<signals>` block
  before the paragraph. **Worst of the three.** It flagged `dash-real-02`, a human account of
  a cancelled train, on the dash count, and still missed the empty ones.

`fewshot_contaminated` is kept only to show the effect: examples that mirror corpus items
inflate the score by roughly 2 points.

## Reading the score

Precision matters more than recall here. A false positive draws a box on a page the reader
trusts. A false negative just leaves a paragraph alone. The shipped prompt sits at 100%
precision on 25 human paragraphs, and the remaining misses are two items in `H` and `I`.

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
Playwright's Chromium against the local Ollama, labels two paragraphs, dismisses a flag,
exports, and runs triage on the export against a scratch copy of the corpus.

## Two things this model cannot see

`K` and `M` are open. Four prompt versions moved neither, and the reason is the same both
times: the model is not evaluating the thing the rule describes.

**Circular claims.** Hold the sentence structure fixed and swap only the nouns. `A company is
shaped by the values the company rewards` is flagged; `The checklist is shaped by the steps
the checklist rewards` is not. Nothing changed except how concrete the nouns are. The model
scores whether specific nouns are present, which it uses as a stand-in for whether the
paragraph carries information, and a circular claim is full of specific nouns that nothing is
predicated of. `circ-04` and `circ-05` are caught because their nouns are abstract, not
because the loop was spotted.

**Em dashes.** Removing every em dash from `dash-01` and `dash-02` does not change the
verdict, and adding four more to `dash-real-01` does not change it either. The punctuation is
not reaching the decision at all, with or without a rule about it. Feeding a measured count
in as a signal did reach it, and what it produced was a false positive on a human paragraph.

Both look like capacity limits rather than wording problems, so the next thing to try is a
larger model on the 63-item set before spending more on the prompt. Precision is the priority
here, and every version that moved recall moved precision the wrong way.
