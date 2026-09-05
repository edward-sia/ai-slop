import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { readLivePrompt } from '../eval/live_prompt.mjs';

const SOURCE = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
// Objects made inside the vm context carry that realm's prototypes, which strict
// deep equality rejects. Compare plain data instead.
const plain = value => JSON.parse(JSON.stringify(value));

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
  assert.deepEqual(plain(await send({ action: 'saveRecord', record })), { ok: true });
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
  assert.deepEqual(plain(store.records.map(r => r.id).sort()), ['a', 'b']);
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
  assert.deepEqual(plain(await send({ action: 'checkSlop', text: 'x' })), { isSlop: false, error: true });
});
