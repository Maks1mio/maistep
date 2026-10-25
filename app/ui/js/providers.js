// Настройки → Провайдеры LLM: список провайдеров (CheapVibeCode, Anthropic, OpenAI-совместимые, Ollama, llama.cpp, свои),
// адрес, ключ, тип, провайдер по умолчанию; ниже — перевод промптов. Ключи хранит сервер в user/settings.json, UI видит их
// только замаскированными. Раздел окна настроек (settings.js): providersPanel() → { el, apply }.
import { h, fill } from './util.js';
import { S, emit } from './store.js';
import { icon } from './icons.js';
import { getSettings, saveSettings, getModels } from './backend.js';
import { dropdown, onOff } from './kit.js';
import { modelPicker } from './modelpick.js';
import { row, input, hint } from './settings.js';

const KINDS = [['proxy', 'Агрегатор (Claude + OpenAI-совместимые)'], ['openai', 'OpenAI-совместимый'], ['anthropic', 'Anthropic API'],
  ['ollama', 'Ollama (локально)'], ['llamacpp', 'llama.cpp (локально)']];
const LOCAL = new Set(['ollama', 'llamacpp']);
const log = (level, text) => emit('log', { src: 'editor', level, text });

export async function providersPanel() {
  const st0 = await getSettings();
  let st = st0;
  const edits = {};               // pid → изменённые поля (null — удалить)
  let cur = st.default_provider, def = st.default_provider, dirty = false;
  let tr = { enabled: true, provider: st.default_provider, model: '', ...(st.translate || {}) };
  const listEl = h('div.st-plist'), form = h('div.st-pform'), trEl = h('div.st-sub');
  const prov = pid => ({ ...st.providers[pid], ...edits[pid] });
  const touch = () => { dirty = true; };

  function drawList() {
    listEl.replaceChildren(...Object.keys(st.providers).filter(pid => edits[pid] !== null).map(pid => {
      const p = prov(pid);
      return h(`div.st-pit${pid === cur ? '.on' : ''}`, { onclick: () => { cur = pid; drawList(); drawForm(); } },
        icon(LOCAL.has(p.kind) ? 'nodes/desktop' : 'ai', { size: 16 }), h('span.t', {}, p.name || pid),
        pid === def ? h('span.st-badge', {}, 'по умолч.') : null,
        !p.has_key && !p.api_key && !LOCAL.has(p.kind) ? h('span.st-dim', { 'data-tip': 'Нет ключа' }, icon('general/locked', { size: 14 })) : null);
    }), h('div.ui-tb', {}, h('button.b.txt', { onclick: addProvider }, icon('add', { size: 16 }), 'Провайдер')));
  }

  function drawForm() {
    const p = prov(cur);
    const set = (k, v) => { (edits[cur] ||= {})[k] = v; touch(); if (k === 'name' || k === 'kind') { drawList(); if (k === 'kind') drawForm(); } };
    const key = input(p.api_key || '', v => set('api_key', v), { type: 'password', placeholder: p.env ? `пусто — из ${p.env}` : 'API key' });
    key.addEventListener('focus', () => { if (key.value.startsWith('••••')) key.select(); });
    const status = h('div.st-hint');
    const m = S.models[cur];
    if (m?.models?.length) status.textContent = `в каталоге: ${m.models.length} моделей`;
    fill(form,
      h('div.st-h', {}, p.name || cur, h('span.st-dim', {}, ` · ${cur}`)),
      row('Название', input(p.name, v => set('name', v))),
      row('Тип', dropdown(p.kind || 'openai', KINDS, v => set('kind', v), { width: 300 })),
      row('Base URL', input(p.base_url, v => set('base_url', v), { placeholder: 'https://…/v1' })),
      LOCAL.has(p.kind) ? null : row('Ключ', h('div.st-line', {}, key,
        h('div.ui-tb', {}, h('button.b', { 'data-tip': 'Показать / скрыть', onclick: () => { key.type = key.type === 'password' ? 'text' : 'password'; } }, icon('show', { size: 16 }))))),
      hint(p.kind === 'proxy' ? 'Claude — через <base>/messages (SDK anthropic), остальные — через <base>/chat/completions, каталог — <base>/models.'
        : p.kind === 'anthropic' ? 'Официальный API Anthropic; пустой ключ — ANTHROPIC_API_KEY.'
          : p.kind === 'ollama' ? 'Локальные модели: <base>/api/chat, список — <base>/api/tags. Без инструментов — простой чат.'
            : p.kind === 'llamacpp' ? 'llama-server с OpenAI-совместимым API и инструментами. Запуск и модель — раздел «llama.cpp».'
              : 'Любой OpenAI-совместимый API: <base>/chat/completions, каталог — <base>/models.'),
      h('div.st-btns', {},
        h('button.ui-btn.secondary', { onclick: async () => { await apply(); status.textContent = 'проверка…'; const r = await getModels(cur, true); status.textContent = r?.error ? `ошибка: ${r.error}` : `ок — моделей: ${r?.models?.length ?? 0}`; } }, 'Сохранить и проверить'),
        h('button.ui-btn.secondary', { disabled: cur === def, onclick: () => { def = cur; touch(); drawList(); drawForm(); } }, 'По умолчанию'),
        p.builtin ? null : h('button.ui-btn.secondary', { onclick: () => { edits[cur] = null; touch(); cur = def === cur ? 'anthropic' : def; drawList(); drawForm(); drawTr(); } }, 'Удалить')),
      status);
  }

  function drawTr() {
    const provs = Object.entries(st.providers).filter(([pid]) => edits[pid] !== null).map(([pid, p]) => [pid, p.name || pid]);
    const pick = h('button.ui-dd.link', { type: 'button', onclick: () => modelPicker(pick, {
      provider: tr.provider || def, value: tr.model || '', onPick: id => { tr.model = id; touch(); drawTr(); },
    }) }, h(`span.t${tr.model ? '' : '.ph'}`, {}, tr.model || 'авто (flash / mini / haiku)'), h('span.chev', {}, icon('down', { size: 16 })));
    fill(trEl,
      h('div.st-h', {}, 'Перевод промптов'),
      hint('Русский и смешанный текст переводится на английский перед CLIP Text Encode и Generate Image. Теги, веса и <lora:…> сохраняются.'),
      row('Включён', onOff(tr.enabled !== false, v => { tr.enabled = v; touch(); })),
      row('Провайдер', dropdown(tr.provider || def, provs, v => { tr.provider = v; tr.model = ''; touch(); drawTr(); }, { width: 220 })),
      row('Модель', h('div.st-line', {}, pick, tr.model ? h('button.ui-btn.secondary.slim', { onclick: () => { tr.model = ''; touch(); drawTr(); } }, 'авто') : null)));
  }

  function addProvider() {
    const id = (window.prompt('id провайдера (латиница, цифры, - _):', 'my-provider') || '').trim();
    if (!/^[\w-]+$/.test(id) || st.providers[id]) return;
    st.providers[id] = { name: id, kind: 'openai', base_url: '', has_key: false };
    edits[id] = { name: id, kind: 'openai', base_url: '' };
    cur = id; touch(); drawList(); drawForm(); drawTr();
  }

  async function apply() {
    if (!dirty) return true;
    const body = { default_provider: def, providers: edits,
      translate: { enabled: tr.enabled !== false, provider: tr.provider || '', model: tr.model || '' } };
    try {
      st = await saveSettings(body);
      for (const k of Object.keys(edits)) delete edits[k];
      tr = { enabled: true, provider: st.default_provider, model: '', ...(st.translate || {}) };
      dirty = false;
      drawList(); drawTr();
      emit('providers-changed', st);
      log('ok', 'провайдеры сохранены: user/settings.json');
      return true;
    } catch (e) { log('error', `провайдеры: ${e.message}`); return false; }
  }

  drawList(); drawForm(); drawTr();
  return { el: h('div', {}, h('div.st-pbody', {}, listEl, form), trEl), apply };
}
