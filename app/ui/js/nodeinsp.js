// Inspector графа: нода (значения виджетов, входы/выходы, последний результат), связь, воркфлоу.
import { h, field, text, num, check, select as sel } from './util.js';
import { S, doc, edit, select, emit } from './store.js';
import { registerInspector } from './inspector.js';
import { icon } from './icons.js';
import { defs, deleteSel, issuesOf, TYPE_COLOR, llmModel } from './graph.js';
import { fileUrl, queuePrompt, upload } from './backend.js';
import { modelPicker, badges } from './modelpick.js';
import { libraryPicker } from './library.js';
import { loraTriggers, copyTriggers } from './lora.js';
import { imagePicker } from './images.js';
import { MAGIC, MAGIC_KEYS, magicState, fetchRec, resetMagic, refreshMagic } from './magic.js';

const chip = t => h('span.tchip', { style: { borderColor: TYPE_COLOR[t] || '#b5b8c0', color: TYPE_COLOR[t] || '#b5b8c0' } }, t);

function widget(d, n, k, inp) {
  const v = n.props?.[k] ?? inp.default;
  const set = val => {
    edit('workflow', d.id, wf => { const nn = wf.nodes.find(z => z.id === n.id); nn.props ||= {}; nn.props[k] = val; }, { label: `${n.id}.${k}`, merge: `${n.id}.${k}` });
  };
  if (inp.type === 'COMBO') return sel(v, inp.options || [], set);
  if (inp.picker === 'library_model') {
    const i = text(v, set, { placeholder: 'имя модели' });
    const cat = () => inp.cat || (n.props?.[inp.cat_input] ?? defs()[n.type].inputs[inp.cat_input]?.default);
    const btn = h('button.ui-ib', { 'data-tip': 'Галерея моделей', onclick: () => libraryPicker(btn, { cat: cat(), value: i.value, onPick: name => { i.value = name; set(name); } }) }, icon('image', { size: 16 }));
    return h('div.row', { style: { flex: 1 } }, i, btn);
  }
  if (inp.picker === 'llm_model') {
    const i = text(v, set, { placeholder: 'id модели' });
    const pid = () => n.props?.[inp.provider_input] ?? defs()[n.type].inputs[inp.provider_input]?.default;
    const btn = h('button.ui-ib', { 'data-tip': 'Выбрать из каталога', onclick: () => modelPicker(btn, { provider: pid(), value: i.value, onPick: id => { i.value = id; set(id); } }) }, icon('search', { size: 16 }));
    i.addEventListener('focus', () => modelPicker(i, { provider: pid(), value: i.value, onPick: id => { i.value = id; set(id); } }));
    return h('div.row', { style: { flex: 1 } }, i, btn);
  }
  if (inp.type === 'BOOLEAN') return check(v, set);
  if (inp.type === 'INT' || inp.type === 'FLOAT') return num(v, set, { int: inp.type === 'INT', min: inp.min, max: inp.max, step: inp.step });
  if (inp.multiline) {
    const t = h('textarea', { rows: 6, spellcheck: false, placeholder: inp.hint || '' });
    t.value = v ?? '';
    // Ctrl+↑/↓ меняет вес тега под курсором/выделения: (girl:1.2)
    if ((n.type === 'sd.text_encode' && k === 'text') || (n.type === 'image.generate_openai' && k === 'prompt')) {
      t.dataset.promptWeight = '';
      t.title = 'Ctrl+↑ / Ctrl+↓ — вес тега: (girl:1.2)';
    }
    t.addEventListener('input', () => set(t.value));
    return t;
  }
  const i = text(v, set, { placeholder: inp.hint || '' });
  if (inp.upload) {
    const f = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    const put = rel => { i.value = rel; set(rel); emit('change', { kind: 'workflow', id: d.id }); };
    f.onchange = async () => {
      try { put(await upload(f.files[0])); }
      catch (e) { emit('log', { src: 'editor', level: 'error', text: `загрузка: ${e.message}` }); }
    };
    const lib = h('button.ui-ib', { 'data-tip': 'Выбрать из библиотеки приложения (input/, output/)', onclick: () => imagePicker(lib, { value: i.value, onPick: put }) }, icon('image', { size: 16 }));
    return h('div.row', { style: { flex: 1 } }, i, f, lib, h('button.ui-ib', { 'data-tip': 'Загрузить с диска (проводник) в input/…', onclick: () => f.click() }, icon('upload', { size: 16 })));
  }
  return i;
}

// карточка выбранной модели LLM: название, значки, контекст, вывод
function modelCard(n, def) {
  if (!Object.values(def.inputs).some(i => i.picker === 'llm_model')) return [];
  const m = llmModel(n, def);
  if (!m) return [h('div.hint', { style: { color: 'var(--ui-warn)' } }, 'модели нет в каталоге провайдера (или каталог ещё не загружен)')];
  return [h('div.mcard', {}, h('div.row', {}, h('b', {}, m.name), h('span.grow'), ...badges(m)),
    h('div.hint', {}, [m.company, m.series, m.max_output ? `вывод до ${m.max_output.toLocaleString('ru')} ток.` : '', m.tools ? 'инструменты' : ''].filter(Boolean).join(' · ')),
    !m.vision ? h('div.hint', {}, 'картинки не принимает — вход image скрыт') : null)];
}

// Magic KSampler: профиль модели, рекомендованные значения и откуда они, LoRA, подсказки к промпту
function magicCard(d, n) {
  if (n.type !== MAGIC) return [];
  const m = magicState(d, n);
  if (!m.src.ckpt) return [h('div.mcard', {}, h('b', {}, '✦ Magic'), h('div.hint', {}, 'Подключите вход model к Load Checkpoint (можно через Load LoRA) — параметры подберутся под модель.'))];
  if (!m.full && !m.loading && !m.error) fetchRec(m.src);
  const r = m.full;
  const copy = t => h('button.ui-ib', { 'data-tip': 'Копировать', onclick: () => navigator.clipboard?.writeText(t) }, icon('copy', { size: 16 }));
  const rows = MAGIC_KEYS.map(k => {
    const ch = m.changed.includes(k);
    return h('div.f', {}, h('label', {}, k), h('div.v', {}, h('span.mono', {}, String(m.rec?.[k] ?? '—')),
      h('span.dim', { style: { marginLeft: '8px', fontSize: '11px' } }, r?.source?.[k] || ''),
      ch ? h('span.mbadge', { style: { marginLeft: 'auto' }, 'data-tip': `сейчас: ${n.props?.[k]}` }, 'изменено') : null));
  });
  return [h('div.mcard.magic', {},
    h('div.row', {}, h('b', {}, `✦ Magic · ${m.profile || r?.profile || '…'}`), h('span.grow'), m.loading ? h('span.dim', {}, 'подбор…') : null),
    m.error ? h('div.hint', { style: { color: 'var(--err)' } }, m.error) : null,
    h('div.hint', {}, [r?.ckpt, r?.base].filter(Boolean).join(' · ')),
    ...rows,
    r?.clip_skip ? h('div.hint', {}, `clip skip: ${r.clip_skip} (CLIP Set Last Layer) · размер: ${r.size?.join('×')}`) : null,
    ...(r?.loras || []).map(l => h('div.hint', { style: { color: l.ok ? '' : 'var(--err)' } },
      `LoRA ${l.name} · ${l.strength}${l.base ? ` · ${l.base}` : ''}${l.note ? ` — ${l.note}` : ''}${l.trained?.length ? ` · триггеры: ${l.trained.slice(0, 6).join(', ')}` : ''}`)),
    ...(r?.notes || []).map(t => h('div.hint', {}, `• ${t}`)),
    r?.prompt ? h('div.row', { style: { marginTop: '4px' } }, h('span.dim', { style: { fontSize: '11px', flex: 1 } }, `+ ${r.prompt.positive}`), copy(r.prompt.positive)) : null,
    r?.prompt ? h('div.row', {}, h('span.dim', { style: { fontSize: '11px', flex: 1 } }, `− ${r.prompt.negative}`), copy(r.prompt.negative)) : null,
    h('div.row', { style: { marginTop: '6px', flexWrap: 'wrap', gap: '6px' } },
      h('button.ui-btn.primary.slim', { disabled: !m.changed.length, onclick: () => resetMagic(d.id, n.id) }, icon('undo', { size: 14 }), 'Сбросить к рекомендованным'),
      h('button.ui-btn.secondary.slim', { 'data-tip': 'Подобрать заново (свежие примеры с Civitai); заменит все четыре значения', onclick: () => refreshMagic(d.id, n.id) }, icon('refresh', { size: 14 }), 'Подобрать заново')))];
}

function result(n) {
  const o = S.outputs[S.current.workflow]?.[n.id] || null;
  const st = S.run?.wf === S.current.workflow ? S.run.stream[n.id] : null;
  if (st) return [h('h4', {}, 'Генерация…'), h('pre.out', {}, st)];
  if (!o) return [h('h4', {}, 'Результат'), h('div.dim', {}, 'ещё не запускалась')];
  if (o._error) return [h('h4', {}, 'Ошибка'), h('pre.out.err', {}, o._error)];
  const parts = [h('h4', {}, `Результат${o._time != null ? ` · ${o._time} с` : ''}`)];
  const images = [...(o._ui?.images || []), ...Object.values(o).filter(v => v?.image).map(v => v.image)];
  for (const f of [...new Set(images)]) parts.push(h('div.preview', {}, h('img', { src: fileUrl(f), alt: f })), h('div.hint.mono', {}, f));
  const texts = [];
  if (o._ui?.text != null) texts.push(['', o._ui.text]);
  for (const [k, v] of Object.entries(o)) if (!k.startsWith('_') && v?.text != null) texts.push([k, v.text]);
  for (const [k, t] of texts.slice(0, 4)) {
    parts.push(h('div.row', { style: { justifyContent: 'space-between' } }, h('span.dim', {}, k || 'текст'),
      h('button.ui-ib', { 'data-tip': 'Копировать', onclick: () => navigator.clipboard?.writeText(t) }, icon('copy', { size: 16 }))), h('pre.out', {}, t));
  }
  for (const f of o._ui?.files || []) parts.push(h('div.hint.mono', {}, `файл: ${f}`));
  return parts;
}

// триггер-слова Load LoRA: щелчок по слову — в буфер обмена (в промпт сами не попадают)
function triggersCard(n, def) {
  if (n.type !== 'sd.lora') return [];
  const tags = loraTriggers(n.props?.lora_name ?? def.inputs.lora_name?.default);
  if (!tags.length) return [];
  return [h('h4', {}, 'Триггер-слова (щёлкните — копировать)'),
    ...tags.map(w => h('div.ltrig', { onclick: () => copyTriggers(w), 'data-tip': 'Копировать' }, w)),
    h('button.ui-btn.secondary.slim', { style: { marginTop: '4px' }, onclick: () => copyTriggers(tags.join(', ')) }, icon('copy', { size: 14 }), 'Копировать все')];
}

function nodeInspector(s) {
  const d = doc('workflow', s.doc), n = d?.data.nodes.find(x => x.id === s.id);
  if (!n) return [h('div.dim', {}, 'нода не найдена')];
  const def = defs()[n.type];
  if (!def) return [h('h3', {}, n.type), h('div', { style: { color: 'var(--err)' } }, 'Неизвестный тип ноды — нет на сервере (запущен? загружен модуль?)'), h('button.ui-btn.secondary.slim', { onclick: deleteSel }, 'Удалить ноду')];
  const linked = new Set(d.data.links.filter(l => l.to === n.id).map(l => l.in));
  const setTitle = v => edit('workflow', d.id, wf => { const nn = wf.nodes.find(z => z.id === n.id); if (v) nn.title = v; else delete nn.title; }, { label: 'имя ноды', merge: `${n.id}.title` });
  return [
    h('h3', {}, icon('node', { size: 16 }), n.title || def.title, n.mode === 'mute' ? h('span.dim', {}, ' (выкл)') : null),
    h('div.hint.mono', {}, `${n.id} · ${n.type}${def.source && def.source !== 'builtin' ? ` · ${def.source}` : ''}`),
    def.hint ? h('div.hint', {}, def.hint) : null,
    ...issuesOf(n.id).map(m => h('div', { style: { color: 'var(--err)', margin: '4px 0' } }, m)),
    field('Имя', text(n.title || '', setTitle, { placeholder: def.title })),
    ...modelCard(n, def),
    ...magicCard(d, n),
    h('h4', {}, 'Входы'),
    ...Object.entries(def.inputs).map(([k, inp]) => {
      if (!inp.widget || linked.has(k)) {
        const l = d.data.links.find(x => x.to === n.id && x.in === k);
        return field(k, h('div.row', { style: { flex: 1 } }, chip(inp.type), h('span.dim', {}, l ? `← ${l.from}.${l.out}` : inp.optional ? 'не подключён (необязательный)' : 'не подключён')), inp.hint);
      }
      return field(k, widget(d, n, k, inp), inp.hint || inp.type);
    }),
    ...triggersCard(n, def),
    h('h4', {}, 'Выходы'),
    ...(def.outputs.length ? def.outputs.map(o => {
      const to = d.data.links.filter(l => l.from === n.id && l.out === o.name).map(l => `${l.to}.${l.in}`);
      return field(o.name, h('div.row', { style: { flex: 1 } }, chip(o.type), h('span.dim', {}, to.length ? `→ ${to.join(', ')}` : '')));
    }) : [h('div.dim', {}, def.output ? 'конечная нода' : '—')]),
    ...result(n),
    h('div.row', { style: { marginTop: '10px', flexWrap: 'wrap', gap: '6px' } },
      h('button.ui-btn.primary.slim', { onclick: () => queuePrompt(d.id, 1, [n.id]) }, icon('play', { size: 14 }), 'Выполнить до неё'),
      h('button.ui-btn.secondary.slim', { onclick: deleteSel }, icon('delete', { size: 14 }), 'Удалить')),
  ];
}

function linkInspector(s) {
  const d = doc('workflow', s.doc), l = d?.data.links[s.index];
  if (!l) return [];
  return [h('h3', {}, icon('link', { size: 16 }), 'Связь'), h('div.mono', {}, `${l.from}.${l.out} → ${l.to}.${l.in}`),
    h('button.ui-btn.secondary.slim', { style: { marginTop: '8px' }, onclick: deleteSel }, 'Удалить связь')];
}

function workflowInspector(s) {
  const d = doc('workflow', s.doc);
  if (!d) return [];
  const set = (k, v) => edit('workflow', d.id, wf => { if (v === undefined || v === '') delete wf[k]; else wf[k] = v; }, { label: k, merge: `wf.${k}` });
  const counts = {};
  for (const n of d.data.nodes) counts[defs()[n.type]?.cat || '?'] = (counts[defs()[n.type]?.cat || '?'] || 0) + 1;
  const about = h('textarea', { rows: 4, spellcheck: false, placeholder: 'Что делает этот пайплайн' });
  about.value = d.data.about || '';
  about.oninput = () => set('about', about.value);
  return [
    h('h3', {}, icon('blueprint', { size: 16 }), d.data.title || d.id), h('div.hint', {}, `workflows/${d.id}.json${d.dirty ? ' · не сохранён' : ''}`),
    field('Название', text(d.data.title, v => set('title', v))),
    h('h4', {}, 'Описание'), about,
    h('h4', {}, 'Состав'),
    h('div.hint', {}, `нод ${d.data.nodes.length}, связей ${d.data.links.length}`),
    ...Object.entries(counts).map(([c, k]) => h('div.hint', {}, `${c}: ${k}`)),
    h('div.row', { style: { marginTop: '10px', flexWrap: 'wrap', gap: '6px' } },
      h('button.ui-btn.primary.slim', { onclick: () => queuePrompt(d.id) }, icon('play', { size: 14 }), 'Запуск'),
      h('button.ui-btn.secondary.slim', { onclick: () => queuePrompt(d.id, 4) }, '×4'),
      h('button.ui-btn.secondary.slim', { onclick: () => select({ kind: 'workflow', doc: d.id, id: d.id }) || navigator.clipboard?.writeText(JSON.stringify(d.data, null, 2)) }, icon('copy', { size: 14 }), 'JSON')),
  ];
}

export function initNodeInspector() {
  registerInspector('node', nodeInspector);
  registerInspector('link', linkInspector);
  registerInspector('workflow', workflowInspector);
}
