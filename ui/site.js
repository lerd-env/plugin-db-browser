// The Database tab: the site's tables on the left; on the right one page of
// the picked table, sorted and filtered, or its structure. Every value from the
// database goes in through textContent.
const $ = (id) => document.getElementById(id);
const ENGINES = { mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL', sqlite: 'SQLite' };
const state = {
  tables: [], table: null, offset: 0, pageSize: 100, connection: null, connections: [],
  view: 'data', sort: null, filter: null, operators: [],
};

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
const tableRef = () => ({ table: state.table.name, schema: state.table.schema, ...state.connection && { service: state.connection.service, database: state.connection.database } });

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
    b.onclick = () => openTable(t);
    list.append(b);
  }
}

// ▲ and ▼ mark the sorted column; a third click drops the sort.
function nextSort(column) {
  if (state.sort?.column !== column) return { column, dir: 'asc' };
  return state.sort.dir === 'asc' ? { column, dir: 'desc' } : null;
}

function drawGrid({ columns, rows }) {
  const grid = $('grid');
  grid.replaceChildren();
  if (!columns.length) return grid.append(note('No columns.'));
  const head = el('tr', {}, ...columns.map((c) => {
    const sorted = state.sort?.column === c ? state.sort.dir : '';
    const th = el('th', { textContent: c + (sorted ? (sorted === 'asc' ? ' ▲' : ' ▼') : ''), title: 'Sort by ' + c });
    if (sorted) th.setAttribute('aria-sort', sorted === 'asc' ? 'ascending' : 'descending');
    th.onclick = () => {
      state.sort = nextSort(c);
      loadRows(0);
    };
    return th;
  }));
  const body = rows.map((r) => el('tr', {}, ...r.map((v, i) => {
    const td = v === null
      ? el('td', { className: 'null lerd-muted', textContent: 'NULL' })
      : el('td', { textContent: v, title: v.length > 40 ? v : '' });
    td.onclick = () => showCell(columns[i], v);
    return td;
  })));
  grid.append(el('table', {}, el('thead', {}, head), el('tbody', {}, ...body)));
  if (!rows.length) grid.append(note(state.filter ? 'No rows match the filter.' : 'No rows.'));
}

// A value in full, laid out when it is a JSON object or array.
function showCell(column, value) {
  let shown = value ?? 'NULL';
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') shown = JSON.stringify(parsed, null, 2);
  } catch {}
  $('cell-name').textContent = column;
  $('cell-value').textContent = shown;
  $('cell-value').classList.toggle('lerd-muted', value === null);
  $('cell').hidden = false;
}
$('cell-close').onclick = () => ($('cell').hidden = true);
$('cell-copy').onclick = () => navigator.clipboard?.writeText($('cell-value').textContent).catch(() => {});

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

function drawFilterColumns(columns) {
  if ([...$('fcol').options].map((o) => o.value).join('\n') === columns.join('\n')) return;
  $('fcol').replaceChildren(...columns.map((c) => el('option', { value: c, textContent: c })));
}

async function loadRows(offset) {
  const t = state.table;
  state.offset = offset;
  $('range').textContent = '';
  setPaging(false);
  showLoading(`Loading ${label(t)}...`);
  const stale = () => state.table !== t || state.offset !== offset || state.view !== 'data';
  try {
    const page = await call({ action: 'rows', ...tableRef(), offset, ...state.sort && { sort: state.sort }, ...state.filter && { filter: state.filter } });
    if (stale()) return; // a newer click won
    drawGrid(page);
    drawFilterColumns(page.columns);
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
    if (stale()) return;
    $('grid').replaceChildren(note(e.message, ''));
  } finally {
    if (!stale()) $('grid').removeAttribute('aria-busy');
  }
}

function section(title, cls, head, rows) {
  const body = rows.length
    ? el('table', {}, el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { textContent: h })))),
      el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((v) => el('td', { textContent: v }))))))
    : note('None.');
  return el('div', { className: cls }, el('span', { className: 'lerd-label', textContent: title }), el('div', { className: 'lerd-card flush' }, body));
}

async function loadStructure() {
  const t = state.table;
  const box = $('structure');
  box.replaceChildren(loading(`Loading ${label(t)}...`));
  try {
    const s = await call({ action: 'structure', ...tableRef() });
    if (state.table !== t || state.view !== 'structure') return;
    box.replaceChildren(
      section('Columns', 'columns', ['Name', 'Type', 'Nullable', 'Default', 'Key'],
        s.columns.map((c) => [c.name, c.type, c.nullable ? 'yes' : 'no', c.default ?? 'NULL', c.key ? 'primary' : ''])),
      section('Indexes', 'indexes', ['Name', 'Definition'], s.indexes.map((i) => [i.name, i.definition])),
      section('Foreign keys', 'fks', ['Name', 'Definition'], s.foreignKeys.map((f) => [f.name, f.definition])),
    );
  } catch (e) {
    if (state.table === t) box.replaceChildren(note(e.message, ''));
  }
}

function showView(view) {
  state.view = view;
  for (const b of $('views').querySelectorAll('[role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  const data = view === 'data';
  $('grid').hidden = $('filterbar').hidden = $('pager').hidden = !data;
  $('range').hidden = !data;
  $('structure').hidden = data;
  $('cell').hidden = true;
  if (data) loadRows(state.offset);
  else loadStructure();
}
for (const b of $('views').querySelectorAll('[role="tab"]')) b.onclick = () => showView(b.dataset.view);

// A table opens unsorted and unfiltered, in whichever view was last open.
function openTable(t) {
  if (t !== state.table) {
    state.sort = state.filter = null;
    $('fval').value = '';
    $('fval').disabled = false;
    $('fcol').replaceChildren();
    $('grid').replaceChildren();
  }
  state.table = t;
  state.offset = 0;
  drawTables();
  $('title').textContent = label(t);
  $('views').hidden = false;
  showView(state.view);
}

$('fop').onchange = () => ($('fval').disabled = $('fop').value.startsWith('is '));
$('filterbar').onsubmit = (e) => {
  e.preventDefault();
  state.filter = { column: $('fcol').value, op: $('fop').value, value: $('fval').value };
  loadRows(0);
};
$('fclear').onclick = () => {
  $('fval').value = '';
  state.filter = null;
  loadRows(0);
};

const goToPage = (n) => loadRows((n - 1) * state.pageSize);
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
    if (state.table) loadRows(0);
  } catch (e) {
    $('grid').replaceChildren(note(e.message, ''));
  }
};

const connLabel = (c, name) => `${c.database || name} · ${c.service || 'site'}`;

// The site's databases: a picker when it has more than one, its name otherwise.
function drawConnections({ connections, connection, database, notice }) {
  const one = connections.length < 2;
  $('conn').hidden = one;
  $('dbname').hidden = !one;
  $('dbname').textContent = database ?? '';
  $('conn').replaceChildren(...connections.map((c, i) => el('option', {
    value: i, textContent: connLabel(c, database),
    selected: c.service === connection.service && c.database === connection.database,
  })));
  $('notice').hidden = !notice;
  $('notice').textContent = notice ?? '';
  state.connections = connections;
}

// Opens the site's remembered database, or the one picked.
async function start(pick) {
  state.table = null;
  state.tables = [];
  state.sort = state.filter = null;
  $('title').textContent = $('range').textContent = '';
  $('views').hidden = $('filterbar').hidden = $('structure').hidden = $('cell').hidden = true;
  $('grid').hidden = false;
  setPaging(false);
  $('grid').replaceChildren();
  $('tables').replaceChildren(loading('Loading tables...'));
  try {
    const res = await call({ action: 'tables', ...pick });
    state.tables = res.tables;
    state.pageSize = res.pageSize;
    state.connection = res.connection;
    state.operators = res.operators ?? [];
    drawConnections(res);
    $('size').replaceChildren(...res.pageSizes.map((n) => el('option', { value: n, textContent: n, selected: n === res.pageSize })));
    $('fop').replaceChildren(...state.operators.map((op) => el('option', { value: op, textContent: op })));
    $('engine').textContent = ENGINES[res.engine] || res.engine;
    $('engine').hidden = false;
    $('filter').disabled = false;
    $('grid').replaceChildren(note('Pick a table.'));
    drawTables();
  } catch (e) {
    $('tables').replaceChildren();
    $('grid').replaceChildren(note(e.message, ''));
  }
}

$('conn').onchange = () => {
  const c = state.connections[Number($('conn').value)];
  start({ service: c.service, database: c.database });
};
$('filter').oninput = drawTables;
start();
