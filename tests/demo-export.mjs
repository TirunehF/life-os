#!/usr/bin/env node
/* Print the demo dataset for a given day as JSON, exactly as the app builds it:

     node tests/demo-export.mjs 2026-03-10 > demo.json

   Used by the round-trip test in tests/test_server.py. The defaults are read
   from app/index.html so that nothing is duplicated here. */
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
const pick = name => {
  const m = html.match(new RegExp('const ' + name + '=(\\[.*?\\]);\\n'));
  if (!m) throw new Error(name + ' not found in app/index.html');
  return vm.runInNewContext('(' + m[1] + ')');
};
const preset = pick('PRESETS')[0];
const defaults = {
  sportTypes: pick('DEFAULT_TYPES'),
  areas: pick('DEFAULT_AREAS'),
  theme: {bg: preset.bg, surface: preset.surface, ink: preset.ink, accent: preset.accent, font: pick('FONTS')[0].name},
};
const sandbox = vm.createContext({});
vm.runInContext(readFileSync(path.join(ROOT, 'app', 'demo.js'), 'utf8'), sandbox);
const today = process.argv[2];
if (!/^\d{4}-\d\d-\d\d$/.test(today || '')) throw new Error('usage: demo-export.mjs YYYY-MM-DD');
process.stdout.write(JSON.stringify(sandbox.LifeOSDemo.build(today, defaults)));
