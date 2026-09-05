// Scores a prompt-and-model pair against the labelled set in corpus.json.
//
//   node eval/run.mjs --arm=v2 --model=qwen3:4b
//   node eval/run.mjs --arm=v1 --model=tinyllama     # the original prompt
//
// --arm=v1 reproduces the first version exactly: instructions concatenated onto
// the front of the text, free-form reply, decision by .includes("YES").
// --arm=v2 is what background.js ships: instructions in the system field,
// grammar-constrained JSON output, verdict gated on confidence.

import fs from 'node:fs';
import path from 'node:path';
import { SYSTEM_V2, FEWSHOT_V2 } from './prompt_v2_frozen.mjs';
import { readLivePrompt } from './live_prompt.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const corpus = JSON.parse(fs.readFileSync(path.join(DIR, 'corpus.json'), 'utf8'));

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const ARM = arg('arm', 'v2');
const MODEL = arg('model', 'qwen3:4b');
const MIN_CONFIDENCE = arg('min-confidence', 'medium');
// --split=prod scores only items promoted from reader annotations, which carry a
// `source` block. --split=synthetic scores only the hand-written items.
const SPLIT = arg('split', 'all');
const inSplit = item => {
  if (SPLIT === 'all') return true;
  const isProd = 'source' in item;
  return SPLIT === 'prod' ? isProd : !isProd;
};
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

const V1_PROMPT = `You are a forensic linguistic analyzer. Your task is to evaluate the provided text snippet and determine if it was written by an AI language model or a human.

CRITICAL AI MARKERS TO FLAG:
- Vocabulary: Overuse of specific "empty calories" words like 'delve', 'testament', 'beacon', 'paramount', 'tapestry', 'revolutionize', 'foster', 'demystify', 'moreover', 'furthermore'.
- Structure: Rigid, uniform paragraphs, flawless bullet points, or concluding summaries that start with 'In summary', 'In conclusion', or 'Ultimately'.
- Tone: Over-enthusiastic, perfectly polite, synthetic corporate cheer, or empty hype without concrete specifics.

HUMAN MARKERS TO SAVE (Do NOT flag):
- Natural syntax variations, conversational fragments, idioms, slight grammatical quirks, opinionated viewpoints, or direct, blunt storytelling.

OUTPUT INSTRUCTION:
Analyze the text. If it exhibits high confidence of being AI-generated slop, respond with exactly one word: YES. If it feels human, authentic, or plain-spoken, respond with exactly one word: NO. Do not include punctuation or explanations.`;

// v2 reads the live prompt out of background.js so the eval can never drift
// away from what the extension actually sends.
const { system: LIVE_SYSTEM, fewshot: LIVE_FEWSHOT } = readLivePrompt();
// v2 is the prompt before the no-ai-slop taxonomy was folded in; v3 is the live one.
let V2_SYSTEM  = ARM === 'v2' ? SYSTEM_V2  : LIVE_SYSTEM;
let V2_FEWSHOT = ARM === 'v2' ? FEWSHOT_V2 : LIVE_FEWSHOT;
// --system= and --fewshot= let the two halves be mixed independently, so a change
// to one can be attributed without the other moving at the same time.
const sysFile = arg('system', null), fewFile = arg('fewshot', null);
if (sysFile) V2_SYSTEM  = fs.readFileSync(path.join(DIR, 'prompts', sysFile), 'utf8');
if (fewFile) V2_FEWSHOT = fs.readFileSync(path.join(DIR, 'prompts', fewFile), 'utf8');
const tag = arg('tag', ARM);
const V2_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['SLOP', 'REAL'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['verdict', 'confidence'],
};

const call = async body => {
  const r = await fetch('http://localhost:11434/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}`);
  return r.json();
};

async function v1(text) {
  const d = await call({
    model: MODEL,
    prompt: `${V1_PROMPT} \n\nText to analyze: \n"${text}" `,
    stream: false,
    options: { temperature: 0.1 },
  });
  const raw = d.response ?? '';
  return { raw, pred: raw.trim().toUpperCase().includes('YES') ? 'SLOP' : 'HUMAN', conf: null };
}

async function v2(text) {
  const d = await call({
    model: MODEL,
    system: V2_SYSTEM,
    prompt: `${V2_FEWSHOT}\n<paragraph>\n${text.slice(0, 4000)}\n</paragraph>\n`,
    stream: false,
    format: V2_SCHEMA,
    think: false,
    options: { temperature: 0, num_predict: 40, seed: 42 },
  });
  const raw = d.response ?? '';
  try {
    const o = JSON.parse(raw);
    const strong = CONFIDENCE_RANK[o.confidence] >= CONFIDENCE_RANK[MIN_CONFIDENCE];
    return { raw, pred: o.verdict === 'SLOP' && strong ? 'SLOP' : 'HUMAN', conf: o.confidence };
  } catch {
    return { raw, pred: 'HUMAN', conf: null };
  }
}

const judge = ARM === 'v1' ? v1 : v2;  // v2 and v3 share the transport, only the prompt differs
const results = [];
for (const item of corpus.filter(inSplit)) {
  const t0 = Date.now();
  let out;
  try { out = await judge(item.text); }
  catch (e) { out = { raw: 'ERROR: ' + e.message, pred: 'HUMAN', conf: null }; }
  results.push({ ...item, ...out, ms: Date.now() - t0 });
  process.stderr.write(out.pred === item.label ? '.' : 'x');
}
process.stderr.write('\n');

const file = path.join(DIR, `results_${tag}_${MODEL.replace(/[:\/]/g, '_')}.json`);
fs.writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`tag=${tag} model=${MODEL} system=${sysFile ?? ARM} fewshot=${fewFile ?? ARM} split=${SPLIT} -> ${path.basename(file)}`);
