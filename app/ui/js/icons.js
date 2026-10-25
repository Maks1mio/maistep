// Иконки интерфейса maistep: экспорт набора в editor/ui/icons (категории general, run, toolwindow, nodes,
// fileTypes, status, …). Тёмная тема берёт *_dark.svg (светлые штрихи), при отсутствии — обычный вариант.
import { h } from './util.js';

export function ic(path, { size = 16, dark = true, cls = '' } = {}) {
  const stem = String(path).replace(/\.svg$/, '');
  const img = h(`img.ui-ic${cls ? '.' + cls : ''}`, { src: `icons/${stem}${dark ? '_dark' : ''}.svg`, width: size, height: size, alt: '' });
  img.addEventListener('error', () => { if (img.dataset.fb) return; img.dataset.fb = '1'; img.src = `icons/${stem}.svg`; });
  return img;
}

// короткие имена для кнопок/панелей (путь — без .svg, относительно editor/ui/icons/)
export const ICONS = {
  save: 'general/save', undo: 'general/undo', redo: 'general/redo', refresh: 'general/refresh',
  check: 'general/checkmark', close: 'general/close', add: 'general/add', delete: 'general/delete',
  edit: 'general/edit', copy: 'general/copy', cut: 'general/cut', paste: 'general/paste',
  search: 'general/search', filter: 'general/filter', settings: 'general/settings', locate: 'general/locate',
  hide: 'general/hide', more: 'general/moreVertical', history: 'general/history', pin: 'pin',
  up: 'general/chevronUp', down: 'general/chevronDown', left: 'general/chevronLeft', right: 'general/chevronRight',
  expandAll: 'general/expandAll', collapseAll: 'general/collapseAll', projectStructure: 'general/projectStructure',
  play: 'run/run', stop: 'run/stop', pause: 'run/pause', restart: 'run/restart', debug: 'run/debug',
  rewind: 'playFirst',
  build: 'toolwindow/build', terminal: 'toolwindow/terminal', hierarchy: 'toolwindow/hierarchy',
  folder: 'nodes/folder', image: 'fileTypes/image', text: 'fileTypes/text', properties: 'fileTypes/properties',
  grid: 'image/grid', bulb: 'editor/intentionBulb', diff: 'diffWithClipboard', git: 'gitLabToolWindow',
  diagram: 'dataSchema', lightning: 'lightning', eye: 'inspectionsEye', split: 'swapPanels',
  error: 'status/error', warning: 'status/warning', info: 'status/info', success: 'status/success',
  closeSmall: 'general/closeSmall', remove: 'general/remove', moveUp: 'general/moveUp', moveDown: 'general/moveDown',
  externalLink: 'general/externalLink', help: 'general/help', open: 'general/open', moreH: 'general/moreHorizontal',
  show: 'general/show', sortBy: 'general/sortBy', layout: 'general/layout', download: 'general/download', upload: 'general/upload',
  zoomIn: 'image/zoomIn', zoomOut: 'image/zoomOut', fit: 'image/fitContent', actualZoom: 'image/actualZoom', rec: 'rec',
  key: 'oj/keyframe', curve: 'oj/curve', loop: 'rerunAutomatically', keyboard: 'keyboard', code: 'fileTypes/javaScript', json: 'fileTypes/json', link: 'link', target: 'general/locate',
  // объекты редактора (дерево Hierarchy, вкладки)
  blueprint: 'graphLayout', event: 'lightning', flow: 'conditionalStatement', node: 'nodes/plugin', python: 'fileTypes/python',
  ai: 'aiAssistant', settings2: 'general/settings', spark: 'toolwindow/spark', profile: 'cwmUsers',
};

// Полный список путей (icons/index.json, пересобирается: node -e "…" — см. editor/README.md)
let all = null;
export const allIcons = () => (all ??= fetch('icons/index.json').then(r => r.json()).catch(() => []));

export const icon = (key, opts) => ic(ICONS[key] || key, opts);
