// Настройки → Провайдеры: список провайдеров LLM (CheapVibeCode, Anthropic, OpenAI-совместимые, Ollama, свои),
// адрес, ключ, тип, провайдер по умолчанию. Ключи хранит сервер в user/settings.json; UI видит их только замаскированными.
// «Проверить» сохраняет и запрашивает каталог моделей.
import { h, field, text, check, select as sel } from './util.js';
import { S, emit } from './store.js';
import { icon } from './icons.js';
import { getSettings, saveSettings, getModels } from './backend.js';
import { dropdown } from './kit.js';
import { modelPicker } from './modelpick.js';

const KINDS = [['proxy', 'агрегатор (Claude + OpenAI-совместимые)'], ['openai', 'OpenAI-совместимый'], ['anthropic', 'Anthropic API'], ['ollama', 'Ollama (локально)']];
const log = (level, text) => emit('log', { src: 'editor', level, text });

export async function providersDialog() {
  if (!S.server.running) return log('warn', 'настройки хранит сервер — запустите его');
  let st;
  try { st = await getSettings(); } catch (e) { return log('error', `настройки: ${e.message}`); }
  const edits = {};               // pid → изменённые поля (null — удалить)
  let cur = st.default_provider, def = st.default_provider;
  let tr = { enabled: true, provider: st.default_provider, model: '', ...(st.translate || {}) };
  const listEl = h('div.plist'), form = h('div.pform'), trEl = h('div.pform.ptrans');
  const prov = pid => ({ ...st.providers[pid], ...edits[pid] });

  function drawList() {
    listEl.replaceChildren(...Object.keys(st.providers).filter(pid => edits[pid] !== null).map(pid => {
      const p = prov(pid);
      return h(`div.it${pid === cur ? '.on' : ''}`, { onclick: () => { cur = pid; drawList(); drawForm(); } },
        h('span', {}, p.name || pid), pid === def ? h('span.mbadge', {}, 'по умолчанию') : null, h('span.grow'),
        h('span.dim', {}, p.has_key || p.api_key ? '🔑' : p.kind === 'ollama' ? '' : 'нет ключа'));
    }), h('button', { style: { marginTop: '8px' }, onclick: addProvider }, icon('add', { size: 14 }), 'Провайдер'));
  }

  function drawForm() {
    const p = prov(cur);
    const set = (k, v) => { (edits[cur] ||= {})[k] = v; if (k === 'name') drawList(); };
    const key = h('input', { type: 'password', value: p.api_key || '', placeholder: p.env ? `пусто — из ${p.env}` : 'API key', spellcheck: false, autocomplete: 'off' });
    key.addEventListener('focus', () => { if (key.value.startsWith('••••')) key.select(); });
    key.addEventListener('input', () => set('api_key', key.value));
    const status = h('div.hint');
    const m = S.models[cur];
    if (m?.models?.length) status.textContent = `в каталоге: ${m.models.length} моделей`;
    form.replaceChildren(
      h('h3', {}, icon('ai', { size: 16 }), p.name || cur, h('span.dim', {}, ` · ${cur}`)),
      field('Название', text(p.name, v => set('name', v))),
      field('Тип', sel(p.kind || 'openai', KINDS, v => set('kind', v))),
      field('Base URL', text(p.base_url, v => set('base_url', v), { placeholder: 'https://…/v1' })),
      p.kind === 'ollama' ? null : field('Ключ', h('div.row', { style: { flex: 1 } }, key,
        h('button.icon', { 'data-tip': 'Показать / скрыть', onclick: () => { key.type = key.type === 'password' ? 'text' : 'password'; } }, icon('show', { size: 14 })))),
      h('div.hint', {}, p.kind === 'proxy' ? 'Claude — через <base>/messages (SDK anthropic), остальные — через <base>/chat/completions, каталог — <base>/models'
        : p.kind === 'anthropic' ? 'Официальный API Anthropic; пустой ключ — ANTHROPIC_API_KEY или `ant auth login`'
          : p.kind === 'ollama' ? 'Локальные модели: <base>/api/chat, список — <base>/api/tags' : 'Любой OpenAI-совместимый API: <base>/chat/completions, каталог — <base>/models'),
      h('div.row', { style: { marginTop: '10px', flexWrap: 'wrap' } },
        h('button', { onclick: async () => { await apply(); status.textContent = 'проверка…'; const r = await getModels(cur, true); status.textContent = r?.error ? `ошибка: ${r.error}` : `ок — моделей: ${r?.models?.length ?? 0}`; } }, icon('check', { size: 14 }), 'Сохранить и проверить'),
        h('button', { disabled: cur === def, onclick: () => { def = cur; drawList(); drawForm(); } }, 'По умолчанию'),
        p.builtin ? null : h('button', { onclick: () => { edits[cur] = null; cur = def === cur ? 'anthropic' : def; drawList(); drawForm(); drawTr(); } }, icon('delete', { size: 14 }), 'Удалить')),
      status);
  }

  function drawTr() {
    const provs = Object.entries(st.providers).filter(([pid]) => edits[pid] !== null).map(([pid, p]) => [pid, p.name || pid]);
    const mIn = h('input', { type: 'text', value: tr.model || '', readOnly: true, placeholder: 'авто (flash/mini/…)' });
    const pick = h('button.icon', { 'data-tip': 'Выбрать модель перевода из каталога', onclick: () => modelPicker(pick, {
      provider: tr.provider || def, value: tr.model || '', onPick: id => { tr.model = id; drawTr(); },
    }) }, icon('search', { size: 14 }));
    const auto = h('button', { disabled: !tr.model, 'data-tip': 'Подбирать автоматически', onclick: () => { tr.model = ''; drawTr(); } }, 'авто');
    trEl.replaceChildren(
      h('h3', { style: { marginTop: '12px' } }, icon('ai', { size: 16 }), 'Перевод промптов'),
      h('div.hint', {}, 'Русский и смешанный русско-английский текст переводится на английский перед CLIP Text Encode и Generate Image. Теги, веса и <lora:…> сохраняются.'),
      h('div.f', {}, h('label', {}, 'включён'), h('div.v', {}, check(tr.enabled !== false, v => { tr.enabled = v; drawTr(); }))),
      h('div.f', {}, h('label', {}, 'провайдер'), h('div.v', {}, dropdown(tr.provider || def, provs, v => {
        tr.provider = v; tr.model = ''; drawTr();
      }, { width: 170 }))),
      h('div.f', {}, h('label', {}, 'модель'), h('div.v', {}, mIn, pick, auto)),
      h('div.hint', {}, 'Пустая модель — подобрать автоматически (flash / mini / haiku); ключ и адрес — у провайдера выше.'));
  }


  async function addProvider() {
    const id = (prompt('id провайдера (латиница, цифры, - _):', 'my-provider') || '').trim();
    if (!/^[\w-]+$/.test(id) || st.providers[id]) return;
    st.providers[id] = { name: id, kind: 'openai', base_url: '', has_key: false };
    edits[id] = { name: id, kind: 'openai', base_url: '' };
    cur = id; drawList(); drawForm(); drawTr();
  }

  async function apply() {
    const body = { default_provider: def, providers: edits,
      translate: { enabled: tr.enabled !== false, provider: tr.provider || '', model: tr.model || '' } };
    try {
      st = await saveSettings(body);
      for (const k of Object.keys(edits)) delete edits[k];
      tr = { enabled: true, provider: st.default_provider, model: '', ...(st.translate || {}) };
      drawTr();
      log('ok', 'провайдеры сохранены: user/settings.json');
      drawList();
      return true;
    } catch (e) { log('error', `провайдеры: ${e.message}`); return false; }
  }

  const close = () => bg.remove();
  const bg = h('div.modal-bg', { onmousedown: e => { if (e.target === bg) close(); } },
    h('div.modal.pdialog', { onkeydown: e => { if (e.key === 'Escape') close(); e.stopPropagation(); } },
      h('h3', {}, 'Провайдеры LLM'),
      h('div.pbody', {}, listEl, h('div', {}, form, trEl)),
      h('div.btns', {}, h('button', { onclick: close }, 'Закрыть'), h('button.primary', { onclick: async () => { if (await apply()) close(); } }, 'Сохранить'))));
  document.body.append(bg);
  drawList();
  drawForm();
  drawTr();
}
