// Шаблоны новых воркфлоу (Файл → Новый воркфлоу).
const L = (from, out, to, inp) => ({ from, out, to, in: inp });

export const TEMPLATES = {
  empty: { title: 'Пустой', data: { title: '', nodes: [], links: [] } },
  chat: {
    title: 'Текст → LLM → вывод',
    data: {
      title: 'Чат с моделью',
      nodes: [
        { id: 'n1', type: 'value.text', x: 40, y: 60, props: { text: 'Придумай три названия для кофейни у моря.' } },
        { id: 'n2', type: 'llm.chat', x: 380, y: 40, props: { system: 'Отвечай кратко, по-русски.' } },
        { id: 'n3', type: 'output.show', x: 740, y: 60, props: {} },
      ],
      links: [L('n1', 'text', 'n2', 'prompt'), L('n2', 'text', 'n3', 'value')],
    },
  },
  vision: {
    title: 'Картинка → LLM (описание)',
    data: {
      title: 'Описание картинки',
      nodes: [
        { id: 'n1', type: 'image.load', x: 40, y: 60, props: { file: '' } },
        { id: 'n2', type: 'llm.chat', x: 380, y: 40, props: { prompt: 'Опиши, что на картинке, в 3 предложениях.' } },
        { id: 'n3', type: 'output.show', x: 740, y: 60, props: {} },
        { id: 'n4', type: 'image.preview', x: 380, y: 420, props: {} },
      ],
      links: [L('n1', 'image', 'n2', 'image'), L('n2', 'text', 'n3', 'value'), L('n1', 'image', 'n4', 'image')],
    },
  },
  comfy: {
    title: 'Идея → LLM-промпт → генерация (ComfyUI)',
    data: {
      title: 'Генерация по идее',
      nodes: [
        { id: 'n1', type: 'value.text', x: 40, y: 60, props: { text: 'уютное кафе у моря ночью, фонарики' } },
        { id: 'n2', type: 'llm.chat', x: 360, y: 40, props: { system: 'Преврати идею в промпт для SDXL/Illustrious: только английские теги через запятую, начни с masterpiece, best quality. Без пояснений.', max_tokens: 400, effort: 'low' } },
        { id: 'n3', type: 'comfy.generate', x: 720, y: 40, props: {} },
        { id: 'n4', type: 'image.save', x: 1080, y: 60, props: { prefix: 'idea' } },
      ],
      links: [L('n1', 'text', 'n2', 'prompt'), L('n2', 'text', 'n3', 'positive'), L('n3', 'image', 'n4', 'image')],
    },
  },
  batch: {
    title: 'Список → LLM по каждому → файл',
    data: {
      title: 'Пакетная обработка',
      nodes: [
        { id: 'n1', type: 'value.text', x: 40, y: 60, props: { text: 'яблоко\nгруша\nслива' } },
        { id: 'n2', type: 'text.split', x: 340, y: 60, props: {} },
        { id: 'n3', type: 'llm.map', x: 640, y: 40, props: { template: 'Один факт про {item}, одним предложением.' } },
        { id: 'n4', type: 'output.save_text', x: 980, y: 60, props: { name: 'facts.md' } },
      ],
      links: [L('n1', 'text', 'n2', 'text'), L('n2', 'list', 'n3', 'items'), L('n3', 'text', 'n4', 'text')],
    },
  },
};
