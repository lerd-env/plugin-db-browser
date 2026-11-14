// A table's structure: its columns, indexes and foreign keys, asked of each
// engine in its own catalog and read into one shape.
const { quoteIdent, quoteLiteral } = require('./parse');

function structureSql(engine, table) {
  const t = (v) => quoteLiteral(engine, v);
  switch (engine) {
    case 'mysql':
      return {
        columns: `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t(table.name)} ORDER BY ORDINAL_POSITION;`,
        indexes: `SELECT INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', ') FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t(table.name)} GROUP BY INDEX_NAME, NON_UNIQUE ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME;`,
        foreignKeys: `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t(table.name)} AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION;`,
      };
    case 'postgres': {
      const on = (alias) => `${alias}.table_schema = ${t(table.schema)} AND ${alias}.table_name = ${t(table.name)}`;
      const regclass = t(quoteIdent('postgres', table.schema) + '.' + quoteIdent('postgres', table.name));
      return {
        columns: `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, k.column_name IS NOT NULL FROM information_schema.columns c LEFT JOIN (SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name WHERE tc.constraint_type = 'PRIMARY KEY' AND ${on('tc')}) k ON k.column_name = c.column_name WHERE ${on('c')} ORDER BY c.ordinal_position;`,
        indexes: `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = ${t(table.schema)} AND tablename = ${t(table.name)} ORDER BY indexname;`,
        foreignKeys: `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE contype = 'f' AND conrelid = ${regclass}::regclass ORDER BY conname;`,
      };
    }
    case 'sqlite':
      return {
        columns: `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(${t(table.name)});`,
        indexes: `SELECT il.name, il."unique", (SELECT group_concat(ii.name, ', ') FROM pragma_index_info(il.name) ii) FROM pragma_index_list(${t(table.name)}) il ORDER BY il.name;`,
        foreignKeys: `SELECT "id", "from", "table", "to" FROM pragma_foreign_key_list(${t(table.name)}) ORDER BY "id", "seq";`,
      };
  }
  throw new Error(`unknown engine ${engine}`);
}

function mapColumns(engine, rows) {
  return rows.map(([name, type, nullable, def, key]) => ({
    name,
    type,
    nullable: engine === 'sqlite' ? nullable === '0' : nullable === 'YES',
    default: def,
    key: { mysql: key === 'PRI', postgres: key === 't', sqlite: Number(key) > 0 }[engine],
  }));
}

function mapIndexes(engine, rows) {
  if (engine === 'postgres') return rows.map(([name, definition]) => ({ name, definition }));
  // MySQL says NON_UNIQUE, SQLite says unique.
  const unique = (flag) => (engine === 'mysql' ? flag === '0' : flag === '1');
  return rows.map(([name, flag, cols]) => ({ name, definition: `${unique(flag) ? 'UNIQUE ' : ''}(${cols})` }));
}

// MySQL and SQLite list a key once per column, so the columns of one key are
// gathered into a single entry.
function mapForeignKeys(engine, rows) {
  if (engine === 'postgres') return rows.map(([name, definition]) => ({ name, definition }));
  const keys = new Map();
  for (const [id, from, table, to] of rows) {
    const name = engine === 'sqlite' ? `fk_${id}` : id;
    const k = keys.get(name) ?? { table, from: [], to: [] };
    k.from.push(from);
    k.to.push(to);
    keys.set(name, k);
  }
  return [...keys].map(([name, k]) => ({ name, definition: `${k.from.join(', ')} → ${k.table}(${k.to.join(', ')})` }));
}

module.exports = { structureSql, mapColumns, mapIndexes, mapForeignKeys };
