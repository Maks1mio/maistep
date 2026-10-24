// Релиз maistep: установщики Windows/Linux + один файл обновления для всех систем + публикация в GitHub Releases.
//
//   node scripts/release.mjs version 0.2.0   номер версии во всех файлах (потом — коммит и push)
//   node scripts/release.mjs build           сборка под текущую ОС (--dirty — из рабочей копии, для проверки):
//       Windows → dist/bin/windows-x86_64/maistep.exe и dist/maistep-<v>-setup-win.exe
//       Linux   → dist/bin/linux-x86_64/maistep.AppImage и dist/maistep-<v>-setup-linux.AppImage
//   node scripts/release.mjs pack            dist/maistep-<v>-update.mai из файлов приложения и всех dist/bin/*
//   node scripts/release.mjs publish         gh release create v<версия>: установщики + .mai (коммит должен быть в origin)
//   установщик: maistep-…-setup-win.exe --silent --dir <папка> [--desktop] [--start-menu] [--python] — без окна
//
// В релизе только установщики и maistep-<v>-update.mai. Файл обновления: "MAIUPD01", u32 длина оглавления,
// оглавление (JSON-манифест: файлы приложения и бинари по платформам, у каждой записи off/csize в данных),
// затем данные (deflate; AppImage — как есть, он уже сжат). Обновлятор (server/maistep/updater.py) читает оглавление
// и только нужные куски через HTTP Range.
//
// Что входит в приложение — PAYLOAD ниже: ровно эти пути из git (git archive HEAD), без личного и локального
// (.gitignore — белый список). Файлы берутся из коммита, а не с диска: в рабочей копии Windows могут быть CRLF.
// source — отпечаток исходников Rust без номера версии: если он не изменился, обновление не качает бинарь
// (сборки Rust не побайтно воспроизводимы).
// Установщик — тот же бинарь с архивом приложения в конце (формат — app/src-tauri/src/setup.rs): запустившись,
// он видит архив и показывает окно установки (setup.html), а в папку кладёт бинарь без архива.
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
const TAURI_CLI = '@tauri-apps/cli@2.12.2';
// платформа → бинарь в папке установки и суффикс установщика
const PLATFORMS = {
  'windows-x86_64': { bin: 'maistep.exe', setup: 'setup-win.exe', z: true },
  'linux-x86_64': { bin: 'maistep.AppImage', setup: 'setup-linux.AppImage', z: false },
};
// 0.1.1 и старше обновляются по manifest.json + maistep.exe в релизе — кладём их, пока такие копии могут остаться.
// Убрать (false) после релиза, до которого обновились все.
const LEGACY = true;

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
const gitBuf = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 28 });
const run = (cmd, args, env = {}, cwd = ROOT) => execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' && cmd === 'npx' });
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
const mb = n => (n / 1048576).toFixed(1);
// версия релиза — "version" в package.json (её смена на main запускает сборку в GitHub Actions); в бинарь — через MAISTEP_VERSION
const version = () => readJson(path.join(ROOT, 'package.json')).version;
const die = msg => { console.error(`release: ${msg}`); process.exit(1); };
const hostPlatform = () => {
  const p = process.platform === 'win32' ? 'windows-x86_64' : process.platform === 'linux' ? 'linux-x86_64' : null;
  if (!p || process.arch !== 'x64') die(`сборка поддерживается на Windows и Linux x64, а это ${process.platform}-${process.arch}`);
  return p;
};
const binPath = plat => path.join(DIST, 'bin', plat, PLATFORMS[plat].bin);

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

// Манифест версии: файлы приложения (sha256, размер) и отпечаток Rust
function baseManifest(files, source) {
  const v = version(), comp = readJson(path.join(ROOT, 'components.json'));
  const m = { name: 'maistep', version: v, tag: `v${v}`, repo: comp.app.repo, files: {}, exe: { source }, bin: {} };
  for (const [f, buf] of [...files].sort(([a], [b]) => a.localeCompare(b))) m.files[f] = { sha256: sha(buf), size: buf.length };
  return m;
}

function compileBin(plat, v) {
  if (plat === 'windows-x86_64') {
    run('cargo', ['build', '--release', '--locked', '--manifest-path', `${RUST}/Cargo.toml`], { MAISTEP_VERSION: v });
    return path.join(ROOT, RUST, 'target', 'release', 'maistep.exe');
  }
  // AppImage несёт WebKitGTK и прочие библиотеки — запускается на любом современном дистрибутиве
  const out = path.join(ROOT, RUST, 'target', 'release', 'bundle', 'appimage');
  fs.rmSync(out, { recursive: true, force: true });
  run('npx', ['--yes', TAURI_CLI, 'build', '--bundles', 'appimage', '--config', JSON.stringify({ bundle: { active: true } }), '--', '--locked'],
    { MAISTEP_VERSION: v }, path.join(ROOT, 'app'));
  const img = fs.readdirSync(out).find(f => f.endsWith('.AppImage'));
  if (!img) die(`AppImage не найден в ${out}`);
  return path.join(out, img);
}

function build(dirty) {
  const v = version(), plat = hostPlatform(), files = payloadFiles(dirty);
  if (!/^\d+\.\d+\.\d+$/.test(v || '')) die(`package.json version = ${v} — нужна версия вида 1.2.3`);
  const source = rustSource(dirty), manifest = baseManifest(files, source);
  manifest.bin[plat] = { name: PLATFORMS[plat].bin, source };
  const bytes = Object.values(manifest.files).reduce((s, f) => s + f.size, 0);
  console.log(`приложение: ${files.size} файлов, ${mb(bytes)} МБ`);

  const bin = fs.readFileSync(compileBin(plat, v));
  fs.mkdirSync(path.dirname(binPath(plat)), { recursive: true });
  fs.writeFileSync(binPath(plat), bin);
  writeJson(path.join(DIST, 'bin', plat, 'source.json'), { version: v, source, dirty });

  // архив установщика: u16 длина пути, путь, u32 размер, u32 сжатый размер, deflate; в конце u64 длина и метка
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b));
  entries.push(['manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)]);
  const parts = [];
  for (const [f, buf] of entries) {
    const name = Buffer.from(f, 'utf8'), z = zlib.deflateRawSync(buf, { level: 9 });
    const hd = Buffer.alloc(2 + name.length + 8);
    hd.writeUInt16LE(name.length, 0); name.copy(hd, 2);
    hd.writeUInt32LE(buf.length, 2 + name.length); hd.writeUInt32LE(z.length, 6 + name.length);
    parts.push(hd, z);
  }
  const blob = Buffer.concat(parts), tail = Buffer.alloc(24);
  tail.writeBigUInt64LE(BigInt(blob.length), 0); tail.write('MAISTEP-PAYLOAD1', 8, 'latin1');
  const setupName = `maistep-${v}-${PLATFORMS[plat].setup}`;
  const setup = Buffer.concat([bin, blob, tail]);
  fs.writeFileSync(path.join(DIST, setupName), setup, { mode: 0o755 });
  console.log(`dist/: ${setupName} (${mb(setup.length)} МБ), bin/${plat}/${PLATFORMS[plat].bin} (${mb(bin.length)} МБ)${dirty ? '  [--dirty: не публиковать]' : ''}`);
}

function pack(dirty) {
  const v = version(), files = payloadFiles(dirty), source = rustSource(dirty);
  const manifest = baseManifest(files, source);
  const data = [];
  let off = 0;
  const add = (meta, buf, z) => {
    const body = z ? zlib.deflateRawSync(buf, { level: 9 }) : buf;
    Object.assign(meta, { off, csize: body.length, ...(z ? {} : { z: false }) });
    data.push(body);
    off += body.length;
  };
  for (const [f, buf] of [...files].sort(([a], [b]) => a.localeCompare(b))) add(manifest.files[f], buf, true);
  for (const plat of Object.keys(PLATFORMS)) {
    if (!fs.existsSync(binPath(plat))) continue;
    const info = readJson(path.join(DIST, 'bin', plat, 'source.json'));
    if (info.version !== v || info.source !== source) die(`dist/bin/${plat} собран из другой версии исходников — пересоберите`);
    const buf = fs.readFileSync(binPath(plat));
    manifest.bin[plat] = { name: PLATFORMS[plat].bin, source, sha256: sha(buf), size: buf.length };
    add(manifest.bin[plat], buf, PLATFORMS[plat].z);
  }
  if (!Object.keys(manifest.bin).length) die('нет ни одного бинаря в dist/bin — сначала build');
  const head = Buffer.from(JSON.stringify(manifest), 'utf8'), pre = Buffer.alloc(12);
  pre.write('MAIUPD01', 0, 'latin1'); pre.writeUInt32LE(head.length, 8);
  const name = `maistep-${v}-update.mai`, out = Buffer.concat([pre, head, ...data]);
  fs.writeFileSync(path.join(DIST, name), out);
  console.log(`dist/${name}: ${Object.keys(manifest.files).length} файлов, бинари: ${Object.keys(manifest.bin).join(', ')} — ${mb(out.length)} МБ`);

  if (LEGACY && manifest.bin['windows-x86_64']) {
    const w = manifest.bin['windows-x86_64'];
    const legacy = { ...manifest, files: {}, exe: { source, sha256: w.sha256, size: w.size } };
    delete legacy.bin;
    for (const [f, m] of Object.entries(manifest.files)) legacy.files[f] = { sha256: m.sha256, size: m.size };
    writeJson(path.join(DIST, 'manifest.json'), legacy);
    fs.copyFileSync(binPath('windows-x86_64'), path.join(DIST, 'maistep.exe'));
    console.log('dist/: manifest.json + maistep.exe — для обновления копий 0.1.1');
  }
}

function publish() {
  const v = version(), tag = `v${v}`, mai = path.join(DIST, `maistep-${v}-update.mai`);
  if (!fs.existsSync(mai)) die('сначала node scripts/release.mjs pack');
  const buf = fs.readFileSync(mai), n = buf.readUInt32LE(8), m = JSON.parse(buf.subarray(12, 12 + n).toString('utf8'));
  if (m.version !== v) die(`${path.basename(mai)} собран для ${m.version}`);
  const assets = [mai];
  for (const [plat, p] of Object.entries(PLATFORMS)) {
    const setup = path.join(DIST, `maistep-${v}-${p.setup}`);
    if (!m.bin[plat] || !fs.existsSync(setup)) die(`нет сборки ${plat} (установщик и бинарь в .mai) — соберите на этой ОС`);
    assets.push(setup);
  }
  if (LEGACY) assets.push(path.join(DIST, 'manifest.json'), path.join(DIST, 'maistep.exe'));
  payloadFiles(false); // проверка: рабочая копия чистая
  const head = git('rev-parse', 'HEAD').trim();
  if (git('branch', '-r', '--contains', head).trim() === '') die('коммит не отправлен в origin — сначала git push');
  for (const [f, meta] of Object.entries(m.files)) {
    if (sha(gitBuf('show', `HEAD:${f}`)) !== meta.sha256) die(`dist/ собран не из HEAD (${f}) — пересоберите`);
  }
  // без --notes — список изменений GitHub собирает сам (коммиты с прошлого релиза)
  const i = process.argv.indexOf('--notes'), notes = i > 0 ? ['--notes', process.argv[i + 1]] : ['--generate-notes'];
  run('gh', ['release', 'create', tag, '--target', head, '--title', `maistep ${v}`, ...notes, ...assets.map(a => path.relative(ROOT, a))]);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'version') setVersion(arg);
else if (cmd === 'build') build(process.argv.includes('--dirty'));
else if (cmd === 'pack') pack(process.argv.includes('--dirty'));
else if (cmd === 'publish') publish();
else die('команды: version <x.y.z> | build [--dirty] | pack [--dirty] | publish [--notes "текст"]');
