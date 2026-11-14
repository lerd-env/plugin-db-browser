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

// The statements behind a set of staged edits, in order. Every column is one
// the table has, and a row is only ever named by its whole primary key, so an
// edit can never reach more than the row it was made on.
function buildChanges({ engine, table, columns, changes }) {
  if (!Array.isArray(changes) || !changes.length) throw new Error('no changes to apply');
  const keys = columns.filter((c) => c.key).map((c) => c.name);
  if (!keys.length) throw new Error(`${table.name} has no primary key, so its rows cannot be edited here`);
  const from = (table.schema ? quoteIdent(engine, table.schema) + '.' : '') + quoteIdent(engine, table.name);
  const ident = (name) => quoteIdent(engine, column(columns, table, name).name);
  const value = (name, v) => {
    if (v !== null && typeof v !== 'string') throw new Error(`value for ${name} must be text or null`);
    return v === null ? 'NULL' : quoteLiteral(engine, v);
  };
  const where = (key) => {
    const names = Object.keys(key ?? {});
    if (names.length !== keys.length || !keys.every((k) => names.includes(k) && typeof key[k] === 'string')) {
      throw new Error(`a row is named by its primary key ${keys.join(', ')}`);
    }
    return keys.map((k) => `${ident(k)} = ${value(k, key[k])}`).join(' AND ');
  };
  return changes.map((c) => {
    switch (c.type) {
      case 'update': {
        const set = Object.entries(c.set ?? {});
        if (!set.length) throw new Error('an update needs at least one column');
        return `UPDATE ${from} SET ${set.map(([n, v]) => `${ident(n)} = ${value(n, v)}`).join(', ')} WHERE ${where(c.key)};`;
      }
      case 'insert': {
        const values = Object.entries(c.values ?? {});
        if (!values.length) return engine === 'mysql' ? `INSERT INTO ${from} () VALUES ();` : `INSERT INTO ${from} DEFAULT VALUES;`;
        return `INSERT INTO ${from} (${values.map(([n]) => ident(n)).join(', ')}) VALUES (${values.map(([n, v]) => value(n, v)).join(', ')});`;
      }
      case 'delete':
        return `DELETE FROM ${from} WHERE ${where(c.key)};`;
    }
    throw new Error(`change type ${c.type} is not insert, update or delete`);
  });
}

module.exports = { buildPage, buildChanges, OPERATORS };
