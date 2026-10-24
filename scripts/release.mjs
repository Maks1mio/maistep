// Релиз maistep: установщик + манифест для обновлятора + публикация в GitHub Releases.
//
//   node scripts/release.mjs version 0.2.0   номер версии во всех файлах (потом — коммит и push)
//   node scripts/release.mjs build           dist/: установщик, maistep.exe, manifest.json  (--dirty — из рабочей копии, для проверки)
//   установщик: maistep-setup.exe --silent --dir <папка> [--desktop] [--start-menu] [--python] — без окна
//   node scripts/release.mjs publish         gh release create v<версия> с файлами из dist/ (коммит должен быть в origin)
//
// Что входит в приложение — PAYLOAD ниже: ровно эти пути из git (git archive HEAD), без личного и локального
// (.gitignore — белый список). Файлы берутся из коммита, а не с диска: обновлятор сверяет sha256 с raw.githubusercontent.com
// по тегу, а в рабочей копии Windows могут быть CRLF. exe.source — отпечаток исходников Rust без номера версии:
// если он не изменился, обновление не качает maistep.exe (сборки Rust не побайтно воспроизводимы).
// Установщик — тот же maistep.exe с архивом приложения в конце (формат — app/src-tauri/src/setup.rs): запустившись,
// он видит архив и показывает окно установки (setup.html), а в папку кладёт exe без архива.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PAYLOAD = ['app/ui', 'server', 'mcp', 'custom_nodes/example.py', 'defaults', 'requirements.txt', 'components.json'];
const RUST = 'app/src-tauri';
const TAURI = path.join(ROOT, RUST, 'tauri.conf.json');

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
const gitBuf = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 28 });
const run = (cmd, args, env = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
// версия релиза — "version" в package.json (её смена на main запускает сборку в GitHub Actions); в exe — через MAISTEP_VERSION
const version = () => readJson(path.join(ROOT, 'package.json')).version;
const die = msg => { console.error(`release: ${msg}`); process.exit(1); };

function setVersion(v) {
  if (!/^\d+\.\d+\.\d+$/.test(v || '')) die('нужна версия вида 1.2.3');
  const conf = readJson(TAURI); conf.version = v; writeJson(TAURI, conf);
  const pkg = readJson(path.join(ROOT, 'package.json')); pkg.version = v; writeJson(path.join(ROOT, 'package.json'), pkg);
  const comp = readJson(path.join(ROOT, 'components.json')); comp.app.stable = v; writeJson(path.join(ROOT, 'components.json'), comp);
  for (const [file, re] of [['Cargo.toml', /^(version\s*=\s*")[^"]*(")/m], ['Cargo.lock', /(name = "maistep"\r?\nversion = ")[^"]*(")/]]) {
    const p = path.join(ROOT, RUST, file);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(re, `$1${v}$2`));
  }
  console.log(`версия ${v}: tauri.conf.json, Cargo.toml, Cargo.lock, package.json, components.json — закоммитьте и запушьте`);
}

// Файлы приложения: путь → содержимое (из HEAD или, с --dirty, с диска)
function payloadFiles(dirty) {
  const out = new Map();
  if (dirty) {
    for (const f of git('ls-files', '-co', '--exclude-standard', '--', ...PAYLOAD).split('\n').filter(Boolean)) {
      if (fs.existsSync(path.join(ROOT, f))) out.set(f, fs.readFileSync(path.join(ROOT, f)));
    }
  } else {
    const st = git('status', '--porcelain', '--', ...PAYLOAD, RUST);
    if (st.trim()) die(`есть незакоммиченные изменения:\n${st}(закоммитьте или --dirty для локальной проверки)`);
    for (const f of git('ls-files', '--', ...PAYLOAD).split('\n').filter(Boolean)) out.set(f, gitBuf('show', `HEAD:${f}`));
  }
  return out;
}

// Отпечаток исходников Rust (без номера версии и без вшитого UI — он грузится с диска)
function rustSource(dirty) {
  const h = crypto.createHash('sha256');
  const files = git('ls-files', '--', RUST).split('\n').filter(f => f && !f.includes('/target/') && !f.includes('/gen/')).sort();
  for (const f of files) {
    let t = (dirty ? fs.readFileSync(path.join(ROOT, f)) : gitBuf('show', `HEAD:${f}`)).toString('latin1').replace(/\r\n/g, '\n');
    if (f.endsWith('tauri.conf.json')) t = t.replace(/"version"\s*:\s*"[^"]*"/, '"version": ""');
    if (f.endsWith('Cargo.toml')) t = t.replace(/^version\s*=\s*"[^"]*"/m, 'version = ""');
    if (f.endsWith('Cargo.lock')) t = t.replace(/(name = "maistep"\nversion = ")[^"]*"/, '$1"');
    h.update(`${f}\n`).update(t);
  }
  return h.digest('hex');
}

function build(dirty) {
  const v = version(), files = payloadFiles(dirty);
  const comp = readJson(path.join(ROOT, 'components.json'));
  if (!/^\d+\.\d+\.\d+$/.test(v || '')) die(`package.json version = ${v} — нужна версия вида 1.2.3`);
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  const manifest = { name: 'maistep', version: v, tag: `v${v}`, repo: comp.app.repo, files: {}, exe: { source: rustSource(dirty) } };
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b));
  for (const [f, buf] of entries) manifest.files[f] = { sha256: sha(buf), size: buf.length };
  // манифест установленной версии (без sha exe — обновлятору достаточно exe.source)
  entries.push(['manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}
`)]);
  const bytes = Object.values(manifest.files).reduce((s, f) => s + f.size, 0);
  console.log(`приложение: ${files.size} файлов, ${(bytes / 1048576).toFixed(1)} МБ`);

  run('cargo', ['build', '--release', '--locked', '--manifest-path', `${RUST}/Cargo.toml`], { MAISTEP_VERSION: v });
  const exe = fs.readFileSync(path.join(ROOT, RUST, 'target', 'release', 'maistep.exe'));
  manifest.exe = { ...manifest.exe, sha256: sha(exe), size: exe.length };
  fs.writeFileSync(path.join(DIST, 'maistep.exe'), exe);

  // архив: u16 длина пути, путь, u32 размер, u32 сжатый размер, deflate; в конце u64 длина и метка
  const parts = [];
  for (const [f, buf] of entries) {
    const name = Buffer.from(f, 'utf8'), comp = zlib.deflateRawSync(buf, { level: 9 });
    const hd = Buffer.alloc(2 + name.length + 8);
    hd.writeUInt16LE(name.length, 0); name.copy(hd, 2);
    hd.writeUInt32LE(buf.length, 2 + name.length); hd.writeUInt32LE(comp.length, 6 + name.length);
    parts.push(hd, comp);
  }
  const blob = Buffer.concat(parts), tail = Buffer.alloc(24);
  tail.writeBigUInt64LE(BigInt(blob.length), 0); tail.write('MAISTEP-PAYLOAD1', 8, 'latin1');
  const setup = Buffer.concat([exe, blob, tail]);
  fs.writeFileSync(path.join(DIST, `maistep-${v}-setup.exe`), setup);
  writeJson(path.join(DIST, 'manifest.json'), manifest);
  const m = n => (n / 1048576).toFixed(1);
  console.log(`dist/: maistep-${v}-setup.exe (${m(setup.length)} МБ), maistep.exe (${m(exe.length)} МБ), manifest.json${dirty ? '  [--dirty: не публиковать]' : ''}`);
}

function publish() {
  const v = version(), tag = `v${v}`;
  const m = fs.existsSync(path.join(DIST, 'manifest.json')) ? readJson(path.join(DIST, 'manifest.json')) : null;
  if (!m || m.version !== v || !m.exe?.sha256) die('сначала node scripts/release.mjs build');
  payloadFiles(false); // проверка: рабочая копия чистая
  const head = git('rev-parse', 'HEAD').trim();
  if (git('branch', '-r', '--contains', head).trim() === '') die('коммит не отправлен в origin — сначала git push (обновлятор качает файлы по тегу)');
  for (const [f, meta] of Object.entries(m.files)) {
    if (sha(gitBuf('show', `HEAD:${f}`)) !== meta.sha256) die(`dist/ собран не из HEAD (${f}) — пересоберите`);
  }
  // без --notes — список изменений GitHub собирает сам (коммиты с прошлого релиза)
  const i = process.argv.indexOf('--notes'), notes = i > 0 ? ['--notes', process.argv[i + 1]] : ['--generate-notes'];
  run('gh', ['release', 'create', tag, '--target', head, '--title', `maistep ${v}`, ...notes,
    `dist/maistep-${v}-setup.exe`, 'dist/maistep.exe', 'dist/manifest.json']);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'version') setVersion(arg);
else if (cmd === 'build') build(process.argv.includes('--dirty'));
else if (cmd === 'publish') publish();
else die('команды: version <x.y.z> | build [--dirty] | publish [--notes "текст"]');
