import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLivePrompt } from './live_prompt.mjs';

test('readLivePrompt returns the two prompt halves from background.js', () => {
  const { system, fewshot } = readLivePrompt();
  assert.match(system, /SLOP or REAL/);
  assert.match(system, /When unsure, answer REAL/);
  assert.match(fewshot, /<paragraph>/);
  assert.match(fewshot, /"verdict":"SLOP"/);
  assert.ok(!system.includes('const FEW_SHOT'), 'system must stop at its closing backtick');
});
