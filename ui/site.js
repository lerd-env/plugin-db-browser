// The Database tab: the site's tables on the left, one page of the picked
// table on the right. Every value from the database goes in through textContent.
const $ = (id) => document.getElementById(id);
const ENGINES = { mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL', sqlite: 'SQLite' };
const state = { tables: [], table: null, offset: 0, pageSize: 100 };

function call(body) {
  const site = encodeURIComponent(lerd.context.site);
  return lerd.api('db?site=' + site, { method: 'POST', body: JSON.stringify(body) }).then(JSON.parse);
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const note = (text, cls = 'lerd-muted') => el('div', { className: 'lerd-empty ' + cls, textContent: text });
const loading = (text) => el('div', { className: 'loading lerd-muted' }, el('span', { className: 'spinner' }), text);
const label = (t) => (t.schema && t.schema !== 'public' ? t.schema + '.' : '') + t.name;

function drawTables() {
  const q = $('filter').value.trim().toLowerCase();
  const shown = state.tables.filter((t) => label(t).toLowerCase().includes(q));
  const list = $('tables');
  list.replaceChildren();
  if (!shown.length) list.append(note(state.tables.length ? 'No match.' : 'This database has no tables.'));
  for (const t of shown) {
    const b = el('button', { type: 'button', title: label(t) }, el('span', { className: 'n lerd-mono', textContent: label(t) }));
    if (t.view) b.append(el('span', { className: 'lerd-pill', textContent: 'view' }));
    if (t === state.table) b.setAttribute('aria-current', 'true');
    b.onclick = () => openTable(t, 0);
    list.append(b);
  }
}

function drawGrid({ columns, rows }) {
  const grid = $('grid');
  grid.replaceChildren();
  if (!columns.length) return grid.append(note('No columns.'));
  const head = el('tr', {}, ...columns.map((c) => el('th', { textContent: c })));
  const body = rows.map((r) => el('tr', {}, ...r.map((v) => (v === null
    ? el('td', { className: 'null lerd-muted', textContent: 'NULL' })
    : el('td', { textContent: v, title: v.length > 40 ? v : '' })))));
  grid.append(el('table', {}, el('thead', {}, head), el('tbody', {}, ...body)));
  if (!rows.length) grid.append(note('No rows.'));
}

// The old page stays dimmed under the spinner, so paging does not jump.
function showLoading(text) {
  const grid = $('grid');
  grid.querySelector('.loading')?.remove();
  if (!grid.querySelector('table')) grid.replaceChildren();
  grid.setAttribute('aria-busy', 'true');
  grid.append(loading(text));
}

function setPaging(on) {
  $('prev').disabled = $('next').disabled = $('page').disabled = !on;
}

async function openTable(t, offset) {
  if (t !== state.table) $('grid').replaceChildren();
  state.table = t;
  state.offset = offset;
  drawTables();
  $('title').textContent = label(t);
  $('range').textContent = '';
  setPaging(false);
  showLoading(`Loading ${label(t)}...`);
  try {
    const page = await call({ action: 'rows', table: t.name, schema: t.schema, offset });
    if (state.table !== t || state.offset !== offset) return; // a newer click won
    drawGrid(page);
    const pages = Math.max(1, Math.ceil(page.total / page.limit));
    const fmt = (n) => n.toLocaleString();
    $('range').textContent = page.rows.length ? `${fmt(offset + 1)}-${fmt(offset + page.rows.length)} of ${fmt(page.total)}` : '';
    $('pages').textContent = fmt(pages);
    $('page').max = pages;
    $('page').value = Math.floor(offset / page.limit) + 1;
    setPaging(true);
    $('prev').disabled = offset === 0;
    $('next').disabled = offset + page.limit >= page.total;
  } catch (e) {
    if (state.table !== t || state.offset !== offset) return;
    $('grid').replaceChildren(note(e.message, ''));
  } finally {
    if (state.table === t && state.offset === offset) $('grid').removeAttribute('aria-busy');
  }
}

const goToPage = (n) => openTable(state.table, (n - 1) * state.pageSize);
$('prev').onclick = () => goToPage(Number($('page').value) - 1);
$('next').onclick = () => goToPage(Number($('page').value) + 1);
$('page').onchange = () => {
  const n = Math.min(Math.max(1, Math.round(Number($('page').value)) || 1), Number($('page').max) || 1);
  goToPage(n);
};
$('size').onchange = async () => {
  const size = Number($('size').value);
  try {
    await call({ action: 'page_size', size });
    state.pageSize = size;
    if (state.table) openTable(state.table, 0);
  } catch (e) {
    $('grid').replaceChildren(note(e.message, ''));
  }
};

async function start() {
  $('tables').replaceChildren(loading('Loading tables...'));
  try {
    const { engine, tables, pageSize, pageSizes } = await call({ action: 'tables' });
    state.tables = tables;
    state.pageSize = pageSize;
    $('size').replaceChildren(...pageSizes.map((n) => el('option', { value: n, textContent: n, selected: n === pageSize })));
    $('engine').textContent = ENGINES[engine] || engine;
    $('engine').hidden = false;
    $('filter').disabled = false;
    $('grid').replaceChildren(note('Pick a table.'));
    drawTables();
  } catch (e) {
    $('tables').replaceChildren();
    $('grid').replaceChildren(note(e.message, ''));
  }
}

$('filter').oninput = drawTables;
start();
