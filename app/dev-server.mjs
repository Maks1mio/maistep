// Веб-режим maistep без Tauri: `node app/dev-server.mjs` → http://localhost:3210.
// Отдаёт app/ui и те же команды, что Rust-ядро (POST /api/<команда>, события — SSE /events),
// запускает Python-сервер server/main.py. Нужен для отладки интерфейса в браузере.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'app', 'ui');
const PORT = Number(process.env.MAISTEP_WEB_PORT || 3210);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.gif': 'image/gif', '.py': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const WRITABLE = ['workflows/', 'user/'];
const FS_SKIP = ['.git', 'node_modules', 'target', '.claude', '__pycache__', '.venv', 'venv'];

const clients = new Set();
const emit = (evt, data) => { for (const c of clients) c.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`); };
const log = (src, level, text) => emit('console', { src, level, text });

function projPath(rel) {
  if (String(rel || '').split(/[\\/]/).some(s => s === '..' || s.includes(':'))) throw new Error(`недопустимый путь: ${rel}`);
  return path.join(ROOT, rel || '');
}
function docPath(rel) {
  rel = String(rel).replace(/\\/g, '/');
  if (!WRITABLE.some(w => rel.startsWith(w))) throw new Error(`недопустимый путь ${rel}`);
  return projPath(rel);
}

function python() {
  if (process.env.MAISTEP_PYTHON) return [process.env.MAISTEP_PYTHON, []];
  for (const v of ['.venv', 'venv']) {
    const p = process.platform === 'win32' ? path.join(ROOT, v, 'Scripts', 'python.exe') : path.join(ROOT, v, 'bin', 'python');
    if (fs.existsSync(p)) return [p, []];
  }
  if (spawnSync('python', ['--version']).status === 0) return ['python', []];
  if (process.platform === 'win32' && spawnSync('py', ['-3', '--version']).status === 0) return ['py', ['-3']];
  return ['python3', []];
}

// Порт занят — только сообщаем: его может держать сервер открытого окна maistep (тот же порт 3300), убивать нельзя.
// Для веб-режима выберите другой порт в попапе сервера (хранится отдельно, в localStorage браузера).
function freePort(port) {
  if (process.platform !== 'win32') return;
  const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout || '';
  const pids = new Set(out.split(/\r?\n/).map(l => l.trim().split(/\s+/)).filter(f => f[3] === 'LISTENING' && f[1]?.endsWith(`:${port}`)).map(f => f[4]));
  for (const pid of pids) {
    const name = (spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' }).stdout || '').split('"')[1] || '';
    log('editor', 'error', `порт ${port} занят: ${name || '?'} (PID ${pid}) — выберите другой порт в попапе сервера`);
  }
}

let server = null, serverPort = 3300;
const status = () => ({ running: !!server, port: serverPort, pid: server?.pid ?? null });
function startServer(port) {
  stopServer();
  serverPort = port || 3300;
  freePort(serverPort);
  const [py, pre] = python();
  const child = spawn(py, [...pre, '-u', 'server/main.py', '--port', String(serverPort)], { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', MAISTEP_APP: '1' } });
  server = child;
  for (const [s, level] of [[child.stdout, 'info'], [child.stderr, 'error']]) {
    let buf = '';
    s.on('data', d => { buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop(); for (const l of lines) log('server', level === 'error' && !/error|traceback/i.test(l) ? 'info' : level, l); });
  }
  child.on('exit', () => { if (server === child) { server = null; emit('server', status()); } });
  child.on('error', e => log('editor', 'error', `не удалось запустить ${py}: ${e.message}`));
  log('editor', 'info', `сервер запущен: ${py} server/main.py → http://localhost:${serverPort}`);
  emit('server', status());
  return status();
}
function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(s.pid), '/T', '/F']); else s.kill();
  log('editor', 'info', 'сервер остановлен');
  emit('server', status());
}

// Первый запуск: пока в workflows/ нет ни одного графа, туда копируются стартовые из defaults/workflows/
function seed(dir) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.json'))) return;
  const src = path.join(ROOT, 'defaults', 'workflows');
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(src).filter(f => f.endsWith('.json'))) fs.copyFileSync(path.join(src, f), path.join(dir, f));
}

function loadProject() {
  const dir = path.join(ROOT, 'workflows'), workflows = [], errors = [];
  seed(dir);
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort()) {
      try { workflows.push({ id: f.slice(0, -5), data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }); } catch (e) { errors.push(`workflows/${f}: ${e.message}`); }
    }
  }
  return { root: ROOT, workflows, errors };
}

const CMD = {
  load_project: () => loadProject(),
  data_write: ({ path: rel, value, pretty }) => { const p = docPath(rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `${JSON.stringify(value, null, pretty === false ? 0 : 2)}\n`); return null; },
  data_delete: ({ path: rel }) => { const p = docPath(rel); if (fs.existsSync(p)) fs.unlinkSync(p); return null; },
  data_stamp: () => {
    let latest = 0, count = 0;
    const walk = d => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { count++; latest = Math.max(latest, Math.floor(fs.statSync(p).mtimeMs)); } } };
    walk(path.join(ROOT, 'workflows'));
    return `${latest}:${count}`;
  },
  ui_stamp: () => {
    const css = [0, 0], rest = [0, 0];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!['icons', 'fonts'].includes(e.name)) walk(p); } else { const s = p.endsWith('.css') ? css : rest; s[0] = Math.max(s[0], Math.floor(fs.statSync(p).mtimeMs)); s[1]++; } } };
    walk(UI);
    return `${css.join(':')}/${rest.join(':')}`;
  },
  fs_list: ({ path: rel }) => fs.readdirSync(projPath(rel), { withFileTypes: true })
    .filter(e => !(e.isDirectory() && FS_SKIP.includes(e.name)))
    .map(e => { const s = fs.statSync(path.join(projPath(rel), e.name)); return { name: e.name, dir: e.isDirectory(), size: e.isDirectory() ? 0 : s.size, mtime: Math.floor(s.mtimeMs) }; })
    .sort((a, b) => b.dir - a.dir || a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
  fs_reveal: ({ path: p }) => {
    const abs = path.isAbsolute(p) ? p : projPath(p);
    if (!fs.existsSync(abs)) throw new Error(`нет такого пути: ${abs}`);
    const file = fs.statSync(abs).isFile();
    if (process.platform === 'win32') spawn('explorer', file ? [`/select,${abs}`] : [abs], { detached: true, stdio: 'ignore' }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', process.platform === 'darwin' ? ['-R', abs] : [file ? path.dirname(abs) : abs], { detached: true, stdio: 'ignore' }).unref();
    return null;
  },
  fs_search: ({ path: rel, query, limit = 2000 }) => {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean), out = [];
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (out.length >= limit) return;
        if (e.isDirectory() && FS_SKIP.includes(e.name)) continue;
        const p = path.join(d, e.name), r = path.relative(ROOT, p).replace(/\\/g, '/');
        const tail = r.toLowerCase().slice((rel || '').length);
        if (words.every(w => tail.includes(w))) out.push(e.isDirectory() ? `${r}/` : r);
        if (e.isDirectory()) walk(p);
      }
    };
    walk(projPath(rel));
    return out;
  },
  fs_read: ({ path: rel }) => fs.readFileSync(projPath(rel), 'utf8'),
  fs_write: ({ path: rel, text }) => { const p = projPath(rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return null; },
  server_start: ({ port }) => startServer(port),
  server_stop: () => { stopServer(); return status(); },
  server_status: () => status(),
  open_external: () => null,
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': hi\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (u.pathname.startsWith('/api/') && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const cmd = CMD[u.pathname.slice(5)];
    try {
      if (!cmd) throw new Error(`нет команды ${u.pathname}`);
      const r = await cmd(body ? JSON.parse(body) : {});
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(r ?? null));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  }
  let file;
  try {
    if (u.pathname.startsWith('/mai/p/')) file = projPath(decodeURIComponent(u.pathname.slice(7)));
    else file = path.join(UI, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
    if (!file.startsWith(ROOT) || !fs.statSync(file).isFile()) throw 0;
  } catch { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`maistep (веб-режим): http://localhost:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopServer(); process.exit(0); });
process.on('exit', stopServer);
