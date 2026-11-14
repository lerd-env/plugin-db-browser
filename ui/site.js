// The Database tab: the site's tables on the left; on the right one page of
// the picked table, sorted and filtered, or its structure. Every value from the
// database goes in through textContent.
const $ = (id) => document.getElementById(id);
const ENGINES = { mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL', sqlite: 'SQLite' };
const state = {
  tables: [], table: null, offset: 0, pageSize: 100, connection: null, connections: [],
  view: 'data', sort: null, filter: null, operators: [], format: 'table', result: null,
  page: null, edits: dbEdits.createEdits(), cellAt: null,
};

// A refusal answers {error}; a crash comes back rejected, its message ending
// with the process's exit status, which says nothing to the person reading it.
function call(body) {
  const site = encodeURIComponent(lerd.context.site);
  return lerd.api('db?site=' + site, { method: 'POST', body: JSON.stringify(body) }).then(
    (text) => {
      const res = JSON.parse(text);
      if (res.error) throw new Error(res.error);
      return res;
    },
    (e) => {
      throw new Error(e.message.replace(/\s*exit status \d+\s*$/, ''));
    },
  );
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// The dashboard's frame blocks the Clipboard API, so the copy falls back to
// selecting the text in a hidden field, which a click is still allowed to copy.
// Asking the policy first keeps the blocked call out of the console.
async function copyText(text) {
  const policy = document.permissionsPolicy ?? document.featurePolicy;
  try {
    if (policy && !policy.allowsFeature('clipboard-write')) throw new Error('blocked');
    await navigator.clipboard.writeText(text);
  } catch {
    const field = el('textarea', { value: text, readOnly: true });
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    document.execCommand('copy');
    field.remove();
  }
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

const valueCell = (v) => (v === null
  ? el('td', { className: 'null lerd-muted', textContent: 'NULL' })
  : el('td', { textContent: v, title: v.length > 40 ? v : '' }));

// Rows as a table whose cells open in the side panel; head draws each header.
function resultTable(columns, rows, head = (c) => el('th', { textContent: c })) {
  const body = rows.map((r) => el('tr', {}, ...r.map((v, i) => {
    const td = valueCell(v);
    td.onclick = () => showCell(columns[i], v);
    return td;
  })));
  return el('table', {}, el('thead', {}, el('tr', {}, ...columns.map(head))), el('tbody', {}, ...body));
}

// A table with a primary key, and not a view, can be edited.
const editable = () => !!state.page?.keys?.length && !state.table?.view;

// One cell of the data grid: its staged value, opening in the side panel on a
// click and as an input on a double click. at is {row} or {insert}.
function gridCell(column, at) {
  const { value, changed } = 'insert' in at
    ? { value: state.edits.inserts[at.insert][column] ?? null, changed: column in state.edits.inserts[at.insert] }
    : dbEdits.shown(state.edits, state.page, at.row, column);
  const td = 'insert' in at && !changed ? el('td', { className: 'lerd-muted', textContent: 'default' }) : valueCell(value);
  if (changed) td.classList.add('changed');
  td.onclick = () => showCell(column, value, at);
  td.ondblclick = () => editInline(td, column, value, at);
  return td;
}

function stage(column, value, at) {
  if ('insert' in at) dbEdits.stageInsert(state.edits, at.insert, column, value);
  else dbEdits.stageUpdate(state.edits, state.page, at.row, column, value);
  drawGrid();
}

// Enter or leaving the field stages the value, Escape drops it.
function editInline(td, column, value, at) {
  if (!editable() || state.edits.deletes.has(at.row)) return;
  let done = false;
  const input = el('input', { type: 'text', value: value ?? '' });
  const finish = (keep) => {
    if (done) return;
    done = true;
    if (keep) stage(column, input.value, at);
    else drawGrid();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  td.replaceChildren(input);
  input.focus();
  input.select();
}

function drawChanges() {
  const n = dbEdits.count(state.edits);
  $('changes').hidden = n === 0;
  $('changes-count').textContent = plural(n, 'change');
}

function drawGrid() {
  const { columns, rows } = state.page;
  const grid = $('grid');
  grid.replaceChildren();
  drawChanges();
  if (!columns.length) return grid.append(note('No columns.'));
  const head = (c) => {
    const sorted = state.sort?.column === c ? state.sort.dir : '';
    const th = el('th', { textContent: c + (sorted ? (sorted === 'asc' ? ' ▲' : ' ▼') : ''), title: 'Sort by ' + c });
    if (sorted) th.setAttribute('aria-sort', sorted === 'asc' ? 'ascending' : 'descending');
    th.onclick = guarded(() => {
      state.sort = nextSort(c);
      loadRows(0);
    });
    return th;
  };
  const inserted = state.edits.inserts.map((_, i) => el('tr', { className: 'inserted' }, ...columns.map((c) => gridCell(c, { insert: i }))));
  const existing = rows.map((_, r) => el('tr', { className: state.edits.deletes.has(r) ? 'deleted' : '' }, ...columns.map((c) => gridCell(c, { row: r }))));
  grid.append(el('table', {}, el('thead', {}, el('tr', {}, ...columns.map(head))), el('tbody', {}, ...inserted, ...existing)));
  if (!rows.length && !inserted.length) grid.append(note(state.filter ? 'No rows match the filter.' : 'No rows.'));
}

// A value in full, laid out when it is a JSON object or array. A cell of an
// editable grid (at set) can also be changed, nulled or have its row deleted.
function showCell(column, value, at) {
  state.cellAt = at ? { column, ...at } : null;
  const canEdit = !!at && editable() && !state.edits.deletes.has(at.row);
  $('cell-edit').hidden = !(at && editable());
  $('cell-input').value = value ?? '';
  $('cell-input').disabled = $('cell-set').disabled = !canEdit;
  $('cell-null').checked = value === null;
  $('cell-null').disabled = !canEdit;
  $('cell-copyrow').hidden = !at || 'insert' in at;
  $('cell-delete').textContent = at && 'insert' in at ? 'Remove row' : state.edits.deletes.has(at?.row) ? 'Keep row' : 'Delete row';
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
$('cell-null').onchange = () => ($('cell-input').disabled = $('cell-null').checked);
$('cell-set').onclick = () => {
  const { column, ...at } = state.cellAt;
  stage(column, $('cell-null').checked ? null : $('cell-input').value, at);
  $('cell').hidden = true;
};
$('cell-delete').onclick = () => {
  const { insert, row } = state.cellAt;
  if (insert !== undefined) dbEdits.removeInsert(state.edits, insert);
  else dbEdits.toggleDelete(state.edits, row);
  $('cell').hidden = true;
  drawGrid();
};
$('addrow').onclick = () => {
  dbEdits.addInsert(state.edits);
  drawGrid();
};
$('discard').onclick = () => {
  state.edits = dbEdits.createEdits();
  $('changes-error').textContent = '';
  drawGrid();
};

// Staged edits are lost when the page reloads, so moving away asks first.
async function canLeave() {
  const n = dbEdits.count(state.edits);
  if (!n || await ask(`Discard ${plural(n, 'unsaved change')}?`, '', 'Discard')) {
    state.edits = dbEdits.createEdits();
    return true;
  }
  return false;
}
// fn runs only once any staged edits are discarded.
const guarded = (fn) => async (...args) => (await canLeave()) && fn(...args);

$('commit').onclick = async () => {
  const changes = dbEdits.toChanges(state.edits, state.page);
  $('changes-error').textContent = '';
  try {
    const preview = await call({ action: 'apply', ...tableRef(), changes });
    if (!(await ask(preview.confirm, preview.statements.join('\n'), 'Commit'))) return;
    await call({ action: 'apply', ...tableRef(), changes, confirm: true });
    state.edits = dbEdits.createEdits();
    loadRows(state.offset);
  } catch (e) {
    $('changes-error').textContent = e.message;
  }
};
$('cell-copy').onclick = () => copyText($('cell-value').textContent);
$('cell-copyrow').onclick = () => {
  const { columns, rows } = state.page;
  copyText(JSON.stringify(Object.fromEntries(columns.map((c, i) => [c, rows[state.cellAt.row][i]])), null, 2));
};
// The page as the database holds it, without edits staged on it.
$('copyas').onchange = () => {
  const { columns, rows } = state.page;
  const as = $('copyas').value;
  $('copyas').value = '';
  if (as === 'sql') copyText(dbFormat.toInserts(state.connection.engine, state.table, columns, rows));
  else if (as) copyText({ csv: dbFormat.toCsv, json: dbFormat.toJson }[as](columns, rows));
};

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
    state.page = page;
    state.edits = dbEdits.createEdits();
    $('changes-error').textContent = '';
    drawGrid();
    $('addrow').hidden = !editable();
    $('readonly').hidden = editable();
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
  $('grid').hidden = $('filterbar').hidden = $('footer').hidden = !data;
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
for (const b of $('views').querySelectorAll('[role="tab"]')) b.onclick = guarded(() => showView(b.dataset.view));

// A table opens unsorted and unfiltered, in whichever of its views was last
// open, or its data when coming from the SQL editor.
const openTable = guarded((t) => {
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
});

$('fop').onchange = () => ($('fval').disabled = $('fop').value.startsWith('is '));
$('filterbar').onsubmit = (e) => {
  e.preventDefault();
  guarded(() => {
    state.filter = { column: $('fcol').value, op: $('fop').value, value: $('fval').value };
    loadRows(0);
  })();
};
$('fclear').onclick = guarded(() => {
  $('fval').value = '';
  state.filter = null;
  loadRows(0);
});

const goToPage = guarded((n) => loadRows((n - 1) * state.pageSize));
$('prev').onclick = () => goToPage(Number($('page').value) - 1);
$('next').onclick = () => goToPage(Number($('page').value) + 1);
$('page').onchange = () => {
  const n = Math.min(Math.max(1, Math.round(Number($('page').value)) || 1), Number($('page').max) || 1);
  goToPage(n);
};
$('size').onchange = async () => {
  const size = Number($('size').value);
  if (!(await canLeave())) {
    $('size').value = state.pageSize;
    return;
  }
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

function ask(text, sql, ok = 'Run') {
  return new Promise((resolve) => {
    const d = $('confirm');
    $('confirm-text').textContent = text;
    $('confirm-sql').textContent = sql;
    $('confirm-run').textContent = ok;
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

$('sqlbtn').onclick = guarded(() => showView('query'));
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
$('qcopy').onclick = () => state.result && copyText(formatted());

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

$('conn').onchange = async () => {
  const c = state.connections[Number($('conn').value)];
  if (await canLeave()) return start({ service: c.service, database: c.database });
  $('conn').value = String(state.connections.indexOf(state.connections.find((x) => x.service === state.connection.service && x.database === state.connection.database)));
};
$('filter').oninput = drawTables;
start();
