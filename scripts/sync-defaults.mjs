// Стартовые воркфлоу defaults/workflows/*.json из шаблонов app/ui/js/templates.js (графы одинаковые).
// При первом запуске, пока в workflows/ нет ни одного графа, редактор копирует их туда (project.rs, dev-server.mjs).
// Файлы в defaults/workflows без шаблона (demo_words.json) не трогаются.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { TEMPLATES } = await import(pathToFileURL(path.join(ROOT, 'app/ui/js/templates.js')));
const dir = path.join(ROOT, 'defaults/workflows');
fs.mkdirSync(dir, { recursive: true });
for (const [id, t] of Object.entries(TEMPLATES)) {
  if (id === 'empty') continue;
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(t.data, null, 2)}\n`);
  console.log(`defaults/workflows/${id}.json`);
}
