// The Database tab: the site's tables on the left; on the right one page of
// the picked table, sorted and filtered, or its structure. Every value from the
// database goes in through textContent.
const $ = (id) => document.getElementById(id);
const ENGINES = { mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL', sqlite: 'SQLite' };
const state = {
  tables: [], table: null, offset: 0, pageSize: 100, connection: null, connections: [],
  view: 'data', sort: null, filter: null, operators: [], format: 'table', result: null,
};

// lerd ends a failed endpoint's message with the process's exit status, which
// says nothing to the person reading it.
function call(body) {
  const site = encodeURIComponent(lerd.context.site);
  return lerd.api('db?site=' + site, { method: 'POST', body: JSON.stringify(body) }).then(JSON.parse, (e) => {
    throw new Error(e.message.replace(/\s*exit status \d+\s*$/, ''));
  });
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
    if (t === state.table && state.view !== 'query') b.setAttribute('aria-current', 'true');
    b.onclick = () => openTable(t);
    list.append(b);
  }
}

// ▲ and ▼ mark the sorted column; a third click drops the sort.
function nextSort(column) {
  if (state.sort?.column !== column) return { column, dir: 'asc' };
  return state.sort.dir === 'asc' ? { column, dir: 'desc' } : null;
}

// Rows as a table whose cells open in the side panel; head draws each header.
function resultTable(columns, rows, head = (c) => el('th', { textContent: c })) {
  const body = rows.map((r) => el('tr', {}, ...r.map((v, i) => {
    const td = v === null
      ? el('td', { className: 'null lerd-muted', textContent: 'NULL' })
      : el('td', { textContent: v, title: v.length > 40 ? v : '' });
    td.onclick = () => showCell(columns[i], v);
    return td;
  })));
  return el('table', {}, el('thead', {}, el('tr', {}, ...columns.map(head))), el('tbody', {}, ...body));
}

function drawGrid({ columns, rows }) {
  const grid = $('grid');
  grid.replaceChildren();
  if (!columns.length) return grid.append(note('No columns.'));
  const head = (c) => {
    const sorted = state.sort?.column === c ? state.sort.dir : '';
    const th = el('th', { textContent: c + (sorted ? (sorted === 'asc' ? ' ▲' : ' ▼') : ''), title: 'Sort by ' + c });
    if (sorted) th.setAttribute('aria-sort', sorted === 'asc' ? 'ascending' : 'descending');
    th.onclick = () => {
      state.sort = nextSort(c);
      loadRows(0);
    };
    return th;
  };
  grid.append(resultTable(columns, rows, head));
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

// data and structure show the open table; query shows the SQL editor.
function showView(view) {
  state.view = view;
  for (const b of $('views').querySelectorAll('[role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  const data = view === 'data';
  const query = view === 'query';
  $('grid').hidden = $('filterbar').hidden = $('pager').hidden = $('range').hidden = !data;
  $('structure').hidden = view !== 'structure';
  $('query').hidden = !query;
  $('views').hidden = query || !state.table;
  $('cell').hidden = true;
  drawTables();
  if (data) loadRows(state.offset);
  else if (view === 'structure') loadStructure();
  else {
    $('title').textContent = 'SQL query';
    loadHistory();
    $('sql').focus();
  }
}
for (const b of $('views').querySelectorAll('[role="tab"]')) b.onclick = () => showView(b.dataset.view);

// A table opens unsorted and unfiltered, in whichever of its views was last
// open, or its data when coming from the SQL editor.
function openTable(t) {
  if (state.view === 'query') state.view = 'data';
  if (t !== state.table) {
    state.sort = state.filter = null;
    $('fval').value = '';
    $('fval').disabled = false;
    $('fcol').replaceChildren();
    $('grid').replaceChildren();
  }
  state.table = t;
  state.offset = 0;
  $('title').textContent = label(t);
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

// The SQL editor. The server says whether a statement writes; a write comes
// back as a question, asked here in a dialog, and is sent again confirmed.
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function ask(text, sql) {
  return new Promise((resolve) => {
    const d = $('confirm');
    $('confirm-text').textContent = text;
    $('confirm-sql').textContent = sql;
    const done = (yes) => {
      if (d.open) d.close();
      resolve(yes);
    };
    $('confirm-run').onclick = () => done(true);
    $('confirm-cancel').onclick = () => done(false);
    d.oncancel = () => done(false);
    d.showModal();
  });
}

function formatted() {
  const { columns, rows } = state.result;
  return { json: dbFormat.toJson, text: dbFormat.toText, csv: dbFormat.toCsv, table: dbFormat.toCsv }[state.format](columns, rows);
}

function drawResult() {
  const box = $('qresult');
  const r = state.result;
  if (!r) return;
  if (!r.columns.length) return box.replaceChildren(note(r.read ? 'No rows.' : 'Done.'));
  box.replaceChildren(state.format === 'table' ? resultTable(r.columns, r.rows) : el('pre', { className: 'lerd-mono', textContent: formatted() }));
}

function queryMeta(r) {
  const time = ` · ${r.ms} ms`;
  if (!r.read) return (r.affected == null ? 'Done' : `${plural(r.affected, 'row')} changed`) + time;
  if (r.truncated) return `First ${r.cap} rows shown, add a LIMIT to choose` + time;
  return plural(r.rows.length, 'row') + time;
}

async function runQuery(confirm = false) {
  const sql = $('sql').value;
  const { service, database } = state.connection;
  $('qmeta').textContent = '';
  $('run').disabled = true;
  $('qresult').replaceChildren(loading('Running...'));
  try {
    const r = await call({ action: 'query', sql, service, database, ...confirm && { confirm: true } });
    if (r.confirm) {
      $('run').disabled = false;
      if (await ask(r.confirm, r.sql)) return runQuery(true);
      $('qresult').replaceChildren();
      $('qmeta').textContent = 'Not run.';
      return;
    }
    state.result = r;
    drawResult();
    $('qmeta').textContent = queryMeta(r);
    loadHistory();
  } catch (e) {
    state.result = null;
    $('qresult').replaceChildren(note(e.message, ''));
  } finally {
    $('run').disabled = false;
  }
}

async function loadHistory() {
  try {
    const { history } = await call({ action: 'history' });
    $('history').replaceChildren(el('option', { value: '', textContent: 'History' }),
      ...history.map((q) => el('option', { value: q, textContent: q.length > 80 ? q.slice(0, 80) + '…' : q })));
  } catch {}
}

$('sqlbtn').onclick = () => showView('query');
$('run').onclick = () => runQuery();
$('sql').onkeydown = (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    runQuery();
  }
};
$('history').onchange = () => {
  if ($('history').value) $('sql').value = $('history').value;
  $('history').value = '';
};
for (const b of $('formats').querySelectorAll('[role="tab"]')) {
  b.onclick = () => {
    state.format = b.dataset.format;
    for (const o of $('formats').querySelectorAll('[role="tab"]')) o.setAttribute('aria-selected', String(o === b));
    drawResult();
  };
}
$('qcopy').onclick = () => state.result && navigator.clipboard?.writeText(formatted()).catch(() => {});

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
  $('views').hidden = $('filterbar').hidden = $('structure').hidden = $('cell').hidden = $('query').hidden = true;
  state.view = state.view === 'query' ? 'data' : state.view;
  state.result = null;
  $('qresult').replaceChildren();
  $('qmeta').textContent = '';
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
    $('filter').disabled = $('sqlbtn').disabled = false;
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
