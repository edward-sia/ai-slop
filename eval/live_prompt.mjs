// Reads the prompt the extension actually sends, straight out of background.js,
// so the eval, the triage guard and the worker test can never drift from it.

import fs from 'node:fs';
import path from 'node:path';

const BACKGROUND = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'background.js');

// Plain string slicing rather than a regex, so backticks inside the prompt
// cannot break the extraction.
function grab(source, label) {
  const marker = 'const ' + label + ' = ' + String.fromCharCode(96);
  const from = source.indexOf(marker);
  if (from === -1) throw new Error('could not find ' + label + ' in background.js');
  const bodyStart = from + marker.length;
  const to = source.indexOf(String.fromCharCode(96) + ';', bodyStart);
  if (to === -1) throw new Error('unterminated ' + label + ' in background.js');
  return source.slice(bodyStart, to);
}

export function readLivePrompt(file = BACKGROUND) {
  const source = fs.readFileSync(file, 'utf8');
  return { system: grab(source, 'SYSTEM_PROMPT'), fewshot: grab(source, 'FEW_SHOT') };
}
