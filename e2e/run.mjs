// End-to-end check of the extension in real Chrome against the local Ollama.
//
//   npm run e2e
//
// Loads the unpacked extension from the repo root into a fresh profile of
// Playwright's Chromium (branded Google Chrome 137 and later ignores the
// --load-extension flag), serves the fixture page over http (content scripts do
// not run on file:// by default), waits for the model to flag both slop
// paragraphs, then labels one
// flagged paragraph Real, labels one clean paragraph Slop, dismisses the other
// flag, exports from the options page, and runs triage on the export against a
// scratch copy of the corpus. The real corpus.json is never touched.

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = fs.readFileSync(path.join(ROOT, 'e2e', 'fixtures', 'page.html'));
const step = msg => console.log(`  ${msg}`);

const ollama = await fetch('http://localhost:11434/api/tags').catch(() => null);
if (!ollama?.ok) {
  console.error('Ollama is not reachable at localhost:11434. Start it and pull qwen3:4b first.');
  process.exit(2);
}

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(FIXTURE);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-e2e-'));
const profile = path.join(scratch, 'profile');
const inbox = path.join(scratch, 'inbox');
fs.mkdirSync(inbox);
const corpusCopy = path.join(scratch, 'corpus.json');
const logCopy = path.join(scratch, 'log.json');
fs.copyFileSync(path.join(ROOT, 'eval', 'corpus.json'), corpusCopy);
fs.writeFileSync(logCopy, '{}\n');

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  step(`extension loaded as ${extensionId}`);

  const page = await context.newPage();
  await page.goto(pageUrl);
  await page.locator('#slop-a.ai-slop-flagged').waitFor({ timeout: 90_000 });
  await page.locator('#slop-b.ai-slop-flagged').waitFor({ timeout: 90_000 });
  step('both slop paragraphs flagged');
  assert.equal(await page.locator('p.ai-slop-flagged').count(), 2, 'only the two slop paragraphs are flagged');

  const pill = page.locator('ai-slop-annotator .pill');
  const popover = page.locator('ai-slop-annotator .popover');
  const saved = page.locator('ai-slop-annotator .saved');
  // The popover is an overlay. Nothing below the labelled paragraph may move.
  const layoutBefore = await page.locator('#real-b').boundingBox();

  // The pill only appears once the paragraph has a verdict. Hover, and if it is
  // not there yet, move away and hover again until the verdict has arrived.
  async function revealPill(selector) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await page.mouse.move(5, 5);
      await page.locator(selector).hover();
      try {
        await pill.waitFor({ state: 'visible', timeout: 1500 });
        return;
      } catch { /* not judged yet */ }
    }
    throw new Error(`pill never appeared for ${selector}`);
  }

  async function label(selector, key, why) {
    await revealPill(selector);
    await pill.click();
    await popover.waitFor({ state: 'visible' });
    assert.deepEqual(await page.locator('#real-b').boundingBox(), layoutBefore, 'opening the popover moved page content');
    await page.keyboard.press(key);
    await page.keyboard.type(why);
    await page.keyboard.press('Enter');
    await saved.waitFor({ state: 'visible', timeout: 5000 });
    await popover.waitFor({ state: 'hidden', timeout: 5000 });
  }

  await label('#slop-a', 'r', 'e2e: flagged but real');
  await page.waitForFunction(() => !document.querySelector('#slop-a').classList.contains('ai-slop-flagged'));
  step('labelled a flagged paragraph Real; flag removed');

  await label('#real-a', 's', 'e2e: clean but slop');
  assert.equal(await page.locator('#real-a.ai-slop-flagged').count(), 0, 'labelling Slop draws nothing');
  step('labelled a clean paragraph Slop');

  // Escape inside the popover closes only the popover. The page's flags stay.
  await revealPill('#slop-b');
  await pill.click();
  await popover.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await popover.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#slop-b.ai-slop-flagged').count(), 1, 'Escape in the popover must not clear flags');
  step('Escape closed the popover and left the flag alone');

  await page.locator('#slop-b').click();
  await page.waitForFunction(() => !document.querySelector('#slop-b').classList.contains('ai-slop-flagged'));
  step('dismissed the other flag');

  assert.equal(await page.locator('ai-slop-annotator').count(), 1, 'exactly one host node on the page');

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForFunction(() => document.getElementById('annotations').textContent === '2');
  assert.equal(await options.locator('#dismissals').textContent(), '1');
  assert.equal(await options.locator('#disagreements').textContent(), '2');
  step('options page counts: 2 annotations, 1 dismissal, 2 disagreements');

  const [download] = await Promise.all([options.waitForEvent('download'), options.click('#export')]);
  assert.match(download.suggestedFilename(), /^slop-inbox-\d{8}-\d{4}\.jsonl$/);
  const exported = path.join(inbox, download.suggestedFilename());
  await download.saveAs(exported);
  const lines = fs.readFileSync(exported, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 3);
  for (const r of lines) {
    assert.match(r.text_sha256, /^[0-9a-f]{64}$/);
    assert.match(r.model.prompt_sha256, /^[0-9a-f]{64}$/);
    assert.equal(r.model.name, 'qwen3:4b');
    assert.equal(r.page.url, pageUrl);
    assert.equal(r.page.title, 'Slop fixture');
  }
  const byLabel = label => lines.find(r => r.kind === 'annotation' && r.label_quality === label);
  assert.equal(byLabel('HUMAN').explanation, 'e2e: flagged but real', 'the label key must not leak into the explanation');
  assert.equal(byLabel('SLOP').explanation, 'e2e: clean but slop');
  assert.equal(byLabel('HUMAN').model.flagged, true);
  assert.equal(byLabel('SLOP').model.flagged, false);
  assert.equal(lines.find(r => r.kind === 'dismissal').label_quality, null);
  step(`exported ${lines.length} records with the expected labels and explanations`);

  const triageArgs = [path.join(ROOT, 'eval', 'triage.mjs'), `--inbox=${inbox}`, `--corpus=${corpusCopy}`, `--log=${logCopy}`];
  const summary = spawnSync(process.execPath, [...triageArgs, '--summary'], { encoding: 'utf8' });
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /new paragraphs: 3/);
  assert.match(summary.stdout, /false_positive {5}1/);
  assert.match(summary.stdout, /false_negative {5}1/);
  assert.match(summary.stdout, /dismissal_only {5}1/);
  step('triage summary classifies the three paragraphs');

  const walk = spawnSync(process.execPath, triageArgs, { input: 'p\n\np\nK_circular_claim\ns\n', encoding: 'utf8' });
  assert.equal(walk.status, 0, walk.stderr);
  assert.match(walk.stdout, /-> prod-001 in P_production/);
  assert.match(walk.stdout, /-> prod-002 in K_circular_claim/);
  const corpus = JSON.parse(fs.readFileSync(corpusCopy, 'utf8'));
  assert.equal(corpus.length, 65);
  assert.equal(corpus[63].label_quality, 'HUMAN');
  assert.equal(corpus[64].label_quality, 'SLOP');
  step('triage walk promoted two items into the scratch corpus');

  const untouched = spawnSync('git', ['status', '--short', 'eval/corpus.json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(untouched.stdout.trim(), '', 'the real corpus.json was not modified');

  console.log(`PASS  scratch files in ${scratch}`);
} finally {
  await context.close();
  server.close();
}
