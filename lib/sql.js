// The SQL behind one page of a table. Column names come from the table's own
// columns and operators from a fixed list, so a request can only pick among
// them; the filter value is the one thing typed, and goes in as a literal.
const { quoteIdent, quoteLiteral } = require('./parse');

const COMPARE = { '=': '=', '!=': '<>', '<': '<', '>': '>', '<=': '<=', '>=': '>=' };
const OPERATORS = [...Object.keys(COMPARE), 'contains', 'starts with', 'is null', 'is not null'];

function column(columns, table, name) {
  const col = columns.find((c) => c.name === name);
  if (!col) throw new Error(`no column ${name} in ${table.name}`);
  return col;
}

function where(engine, columns, table, { column: name, op, value }) {
  if (!OPERATORS.includes(op)) throw new Error(`filter operator ${op} is not one of ${OPERATORS.join(', ')}`);
  const ident = quoteIdent(engine, column(columns, table, name).name);
  if (op === 'is null') return `${ident} IS NULL`;
  if (op === 'is not null') return `${ident} IS NOT NULL`;
  // PostgreSQL will not compare a number or a date with text, so it reads the
  // column as text; MySQL and SQLite convert on their own.
  const lhs = engine === 'postgres' ? `CAST(${ident} AS TEXT)` : ident;
  const v = String(value ?? '');
  if (op === 'contains') return `${lhs} LIKE ${quoteLiteral(engine, `%${v}%`)}`;
  if (op === 'starts with') return `${lhs} LIKE ${quoteLiteral(engine, `${v}%`)}`;
  return `${lhs} ${COMPARE[op]} ${quoteLiteral(engine, v)}`;
}

// The order: the picked column, or else the primary key, so rows do not move
// between pages when the database returns them in another order.
function orderBy(engine, columns, table, sort) {
  if (sort?.column) {
    const dir = String(sort.dir || 'asc').toLowerCase();
    if (dir !== 'asc' && dir !== 'desc') throw new Error(`sort direction ${sort.dir} is not asc or desc`);
    return ` ORDER BY ${quoteIdent(engine, column(columns, table, sort.column).name)} ${dir.toUpperCase()}`;
  }
  const keys = columns.filter((c) => c.key);
  return keys.length ? ' ORDER BY ' + keys.map((c) => `${quoteIdent(engine, c.name)} ASC`).join(', ') : '';
}

function buildPage({ engine, table, columns, sort, filter, limit, offset }) {
  const from = (table.schema ? quoteIdent(engine, table.schema) + '.' : '') + quoteIdent(engine, table.name);
  const cond = filter?.column ? ` WHERE ${where(engine, columns, table, filter)}` : '';
  return {
    sql: `SELECT * FROM ${from}${cond}${orderBy(engine, columns, table, sort)} LIMIT ${limit} OFFSET ${offset};`,
    countSql: `SELECT COUNT(*) FROM ${from}${cond};`,
  };
}

module.exports = { buildPage, OPERATORS };
