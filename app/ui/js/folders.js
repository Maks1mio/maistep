// Выбор папки на ПК (сервер: /api/fs/*) — диалог UI Kit как маленький проводник: слева места, недавние проекты и диски,
// сверху назад / вперёд / вверх, путь крошками (щелчок по пустому месту — ввод пути), фильтр; справа папки.
// Щелчок — выделить, двойной щелчок / Enter — открыть. Создать (Ctrl+Shift+N), переименовать (F2), в корзину (Del),
// показать в проводнике, копировать путь — тулбар, ПКМ и клавиши. «Выбрать папку» берёт выделенную или текущую.
// Нужен AI Chat (папка проекта Code, доп. папки доступа) и настройкам. pickFolder() → Promise<путь | null>.
import { h, fill, confirmBox } from './util.js';
import { emit } from './store.js';
import { icon } from './icons.js';
import { api } from './backend.js';
import { search } from './kit.js';
import { popup } from './ctxmenu.js';

const log = (level, text) => emit('log', { src: 'editor', level, text });

export function pickFolder({ title = 'Выбор папки', value = '', ok = 'Выбрать папку' } = {}) {
  return new Promise(resolve => {
    let cur = null, q = '', sel = null, editing = null, recent = [];
    const back = [], fwd = [];
    const side = h('div.fb-side'), list = h('div.fb-list', { tabindex: 0 }), crumbs = h('div.fb-crumbs'), foot = h('span.fb-sel');
    const err = h('span.fb-err');
    const done = v => { bg.remove(); resolve(v); };
    const say = t => { err.textContent = t || ''; };

    async function go(path, { hist = true, select = null } = {}) {
      let d;
      try { d = await api(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`); }
      catch (e) { say(e.message); return; }
      if (d.error) { say(d.error); return; }
      if (hist && cur && cur.path !== d.path) { back.push(cur.path); fwd.length = 0; }
      cur = d; say(''); editing = null;
      sel = select ? cur.dirs.find(x => x.path === select) || null : null;
      if (!select) { q = ''; sr.input.value = ''; sr.classList.remove('has-text'); }
      draw();
      list.focus();
    }
    const reload = select => go(cur.path, { hist: false, select });
    const shown = () => (cur?.dirs || []).filter(d => !q || d.name.toLowerCase().includes(q));

    // ---------- действия ----------
    async function mkdir() {
      const names = new Set(cur.dirs.map(d => d.name.toLowerCase()));
      let name = 'Новая папка';
      for (let i = 2; names.has(name.toLowerCase()); i++) name = `Новая папка (${i})`;
      try { const r = await api('/api/fs/mkdir', { parent: cur.path, name }); await reload(r.path); startRename(); }
      catch (e) { say(e.message); }
    }
    function startRename(d = sel) {
      if (!d) return;
      sel = d; editing = d.path; draw();
      const inp = list.querySelector('.fb-ren');
      inp?.focus(); inp?.select();
    }
    async function commitRename(d, name) {
      editing = null;
      if (!name.trim() || name === d.name) { draw(); list.focus(); return; }
      try { const r = await api('/api/fs/rename', { path: d.path, name }); await reload(r.path); }
      catch (e) { say(e.message); draw(); }
    }
    async function trash(d = sel) {
      if (!d || !(await confirmBox(`Переместить папку «${d.name}» в корзину?\n${d.path}`, { title: 'Удалить папку', ok: 'В корзину' }))) return;
      try { await api('/api/fs/trash', { path: d.path }); log('info', `в корзине: ${d.path}`); await reload(); }
      catch (e) { say(e.message); }
    }
    const reveal = p => api('/api/fs/reveal', { path: p }).catch(e => say(e.message));
    const copyPath = p => navigator.clipboard?.writeText(p).then(() => say(`скопировано: ${p}`));
    const up = () => cur?.parent && go(cur.parent, { select: cur.path });
    const goBack = () => back.length && (fwd.push(cur.path), go(back.pop(), { hist: false }));
    const goFwd = () => fwd.length && (back.push(cur.path), go(fwd.pop(), { hist: false }));

    // ---------- отрисовка ----------
    function draw() {
      const opt = (ic, name, path, tip) => h(`div.opt${cur && path === cur.path ? '.sel' : ''}`, { onclick: () => go(path), 'data-tip': tip || path }, icon(ic, { size: 16 }), h('span', {}, name));
      fill(side,
        h('div.fb-cap', {}, 'Места'), ...(cur?.places || []).map(p => opt('nodes/homeFolder', p.name, p.path)),
        recent.length ? h('div.fb-cap', {}, 'Недавние проекты') : null,
        ...recent.map(p => opt(p.app ? 'ai' : 'general/vcs', p.name, p.path)),
        h('div.fb-cap', {}, 'Диски'), ...(cur?.drives || []).map(d => opt('nodes/desktop', d.name, d.path)));
      drawCrumbs();
      const dirs = shown();
      fill(list,
        cur?.parent ? h('div.fb-row.up', { ondblclick: up, onclick: () => { sel = null; draw(); } }, icon('nodes/upFolder', { size: 16 }), h('span.n', {}, '..')) : null,
        ...dirs.map(d => {
          const on = sel?.path === d.path;
          const name = editing === d.path ? renameInput(d) : h('span.n', {}, d.name);
          return h(`div.fb-row${on ? '.sel' : ''}`, {
            onclick: () => { if (editing) return; sel = d; draw(); },
            ondblclick: () => editing !== d.path && go(d.path),
            oncontextmenu: e => { sel = d; draw(); popup(e, rowMenu(d)); },
          }, icon(d.git ? 'general/vcs' : 'folder', { size: 16 }), name, d.git ? h('span.fb-tag', {}, 'git') : null,
          editing === d.path ? null : h('span.ui-tb.fb-acts', {},
            h('button.b', { 'data-tip': 'Переименовать (F2)', onclick: e => { e.stopPropagation(); startRename(d); } }, icon('edit', { size: 16 })),
            h('button.b', { 'data-tip': 'В корзину (Del)', onclick: e => { e.stopPropagation(); trash(d); } }, icon('delete', { size: 16 }))));
        }),
        !dirs.length ? h('div.fb-none', {}, q ? 'ничего не найдено' : 'пустая папка — создайте новую (Ctrl+Shift+N)') : null);
      foot.textContent = sel?.path || cur?.path || '';
      tb.querySelector('[data-k=back]').disabled = !back.length;
      tb.querySelector('[data-k=fwd]').disabled = !fwd.length;
      tb.querySelector('[data-k=up]').disabled = !cur?.parent;
      okBtn.textContent = sel ? `${ok}: ${sel.name}` : ok;
    }
    function drawCrumbs(edit = false) {
      if (edit) {
        const inp = h('input.fb-path', { type: 'text', spellcheck: false, value: cur?.path || '' });
        inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') go(inp.value); if (e.key === 'Escape') drawCrumbs(); });
        inp.addEventListener('blur', () => setTimeout(() => crumbs.contains(inp) && drawCrumbs(), 100));
        fill(crumbs, inp);
        inp.focus(); inp.select();
        return;
      }
      const p = cur?.path || '';
      const win = p.includes('\\');
      const parts = p.split(/[\\/]/).filter(Boolean);
      const segs = parts.map((name, i) => [name, win ? (i ? parts.slice(0, i + 1).join('\\') : `${name}\\`) : `/${parts.slice(0, i + 1).join('/')}`]);
      if (!win && !segs.length) segs.push(['/', '/']);
      fill(crumbs, ...segs.flatMap(([name, path], i) => [
        i ? h('span.fb-csep', {}, icon('right', { size: 16 })) : null,
        h(`span.fb-crumb${i === segs.length - 1 ? '.last' : ''}`, { onclick: e => { e.stopPropagation(); go(path); } }, name)]),
      h('span.fb-cfill', { 'data-tip': 'Ввести путь (Ctrl+L)', onclick: () => drawCrumbs(true) }));
    }
    function renameInput(d) {
      const inp = h('input.fb-ren', { type: 'text', spellcheck: false, value: d.name });
      inp.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') commitRename(d, inp.value);
        if (e.key === 'Escape') { editing = null; draw(); list.focus(); }
      });
      inp.addEventListener('blur', () => { if (editing === d.path) commitRename(d, inp.value); });
      inp.addEventListener('click', e => e.stopPropagation());
      return inp;
    }
    const rowMenu = d => [
      { ic: 'open', label: 'Открыть', sc: 'Enter', fn: () => go(d.path) },
      { ic: 'check', label: 'Выбрать эту папку', fn: () => done(d.path) },
      '-',
      { ic: 'nodes/newFolder', label: 'Новая папка', sc: 'Ctrl+Shift+N', fn: mkdir },
      { ic: 'edit', label: 'Переименовать', sc: 'F2', fn: () => startRename(d) },
      { ic: 'externalLink', label: 'Показать в проводнике', fn: () => reveal(d.path) },
      { ic: 'copy', label: 'Копировать путь', fn: () => copyPath(d.path) },
      '-',
      { ic: 'delete', label: 'Удалить в корзину', sc: 'Del', fn: () => trash(d) },
    ];
    const listMenu = () => [
      { ic: 'nodes/newFolder', label: 'Новая папка', sc: 'Ctrl+Shift+N', fn: mkdir },
      { ic: 'refresh', label: 'Обновить', sc: 'F5', fn: () => reload() },
      { ic: 'externalLink', label: 'Показать в проводнике', fn: () => reveal(cur.path) },
      { ic: 'copy', label: 'Копировать путь', fn: () => copyPath(cur.path) },
    ];
    list.addEventListener('contextmenu', e => { if (e.target === list || e.target.classList.contains('fb-none')) { sel = null; draw(); popup(e, listMenu()); } });
    list.addEventListener('click', e => { if (e.target === list && !editing) { sel = null; draw(); } });

    // ---------- клавиши ----------
    function keys(e) {
      if (editing || e.target.matches('input')) return;
      const dirs = shown(), i = sel ? dirs.findIndex(d => d.path === sel.path) : -1;
      const k = e.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault();
        sel = dirs[Math.max(0, Math.min(dirs.length - 1, i + (k === 'ArrowDown' ? 1 : -1)))] || null;
        draw(); list.querySelector('.fb-row.sel')?.scrollIntoView({ block: 'nearest' });
      } else if (k === 'Enter') { e.preventDefault(); if (sel) go(sel.path); }
      else if (k === 'Backspace' || (e.altKey && k === 'ArrowUp')) { e.preventDefault(); up(); }
      else if (e.altKey && k === 'ArrowLeft') { e.preventDefault(); goBack(); }
      else if (e.altKey && k === 'ArrowRight') { e.preventDefault(); goFwd(); }
      else if (k === 'F2') { e.preventDefault(); startRename(); }
      else if (k === 'Delete') { e.preventDefault(); trash(); }
      else if (k === 'F5') { e.preventDefault(); reload(sel?.path); }
      else if (e.ctrlKey && e.shiftKey && k.toLowerCase() === 'n') { e.preventDefault(); mkdir(); }
      else if (e.ctrlKey && k.toLowerCase() === 'l') { e.preventDefault(); drawCrumbs(true); }
    }

    const tbtn = (k, ic, tip, fn) => h('button.b', { 'data-k': k, 'data-tip': tip, onclick: fn }, icon(ic, { size: 16 }));
    const tb = h('div.ui-tb', {},
      tbtn('back', 'left', 'Назад (Alt+←)', goBack), tbtn('fwd', 'right', 'Вперёд (Alt+→)', goFwd), tbtn('up', 'up', 'Вверх (Backspace)', up),
      tbtn('refresh', 'refresh', 'Обновить (F5)', () => reload(sel?.path)), h('span.sep'),
      tbtn('new', 'nodes/newFolder', 'Новая папка (Ctrl+Shift+N)', mkdir));
    const sr = search({ placeholder: 'Фильтр папок', onInput: v => { q = v.toLowerCase(); sel = null; draw(); } });
    const okBtn = h('button.ui-btn.primary.fb-ok', { onclick: () => cur && done(sel?.path || cur.path) }, ok);
    const dlg = h('div.ui-dialog.fb-dlg', { onkeydown: e => { e.stopPropagation(); if (e.key === 'Escape' && !editing) done(null); else keys(e); } },
      h('div.ttl', {}, title, h('span.x', { onclick: () => done(null) }, icon('close', { size: 16 }))),
      h('div.fb-top', {}, tb, crumbs, sr),
      h('div.fb-body', {}, side, list),
      h('div.ft', {}, h('div.fb-foot', {}, foot, err), h('span.grow'),
        h('button.ui-btn.secondary', { onclick: () => done(null) }, 'Отмена'), okBtn));
    const bg = h('div.modal-bg', { onmousedown: e => { if (e.target === bg) done(null); } }, dlg);
    document.body.append(bg);
    api('/api/agent/projects').then(r => { recent = (r || []).filter(p => p.exists); if (cur) draw(); }).catch(() => {});
    go(value);
  });
}
