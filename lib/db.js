// Running SQL against a site's database. MySQL, MariaDB and PostgreSQL go
// through `lerd db:shell`, which knows the site's service and credentials;
// SQLite is a file db:shell refuses, so PHP's PDO in the site's container opens it.
//
// A connection is {sitePath, service, database, engine}. An empty service is
// the site's default, which db:shell resolves itself and withEngine probes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { parseMysql, parseCsv, sqliteFile, parseEnv, splitCommandTag, splitRowCount } = require('./parse');
const { buildPage } = require('./sql');
const { structureSql, mapColumns, mapIndexes, mapForeignKeys } = require('./structure');

const LERD = process.env.LERD_BIN || 'lerd';
const MAX_OUTPUT = 64 * 1024 * 1024;

function run(conn, args, input) {
  const r = spawnSync(LERD, args, { cwd: conn.sitePath, input, encoding: 'utf8', maxBuffer: MAX_OUTPUT });
  if (r.error) throw r.error;
  return r;
}

// The = form keeps a name that starts with a dash from reading as a flag.
const shellArgs = (conn) => ['db:shell', ...(conn.service ? [`--service=${conn.service}`, `--database=${conn.database}`] : [])];

// The client's own message, without lerd's progress lines, the password
// warning mysql always prints and lerd's closing exit status line.
function clientError(stderr) {
  const lines = stderr.split('\n').map((l) => l.replace(/^\s*✗\s*/, '').trim())
    .filter((l) => l && !/Using a password on the command line/.test(l) && !/^exit status \d+$/.test(l) && !/^Starting .*\.\.\.$/.test(l));
  return lines.join('\n') || 'the database client failed';
}

function withEngine(conn) {
  if (conn.engine) return conn;
  const r = run(conn, shellArgs(conn), 'SELECT version();\n');
  if (r.status === 0) return { ...conn, engine: /PostgreSQL/.test(r.stdout) ? 'postgres' : 'mysql' };
  if (/uses SQLite/.test(r.stderr)) return { ...conn, engine: 'sqlite' };
  throw new Error(clientError(r.stderr));
}

// A write also reports how many rows it touched: MySQL through a ROW_COUNT()
// sent after it, psql through the command tag it prints once QUIET is off.
// The statement goes on its own line, so a closing -- comment ends there.
function shell(conn, sql, { write = false } = {}) {
  if (conn.engine === 'mysql') {
    const r = run(conn, shellArgs(conn), write ? `${sql}\n;\nSELECT ROW_COUNT();\n` : `${sql}\n;\n`);
    if (r.status !== 0) throw new Error(clientError(r.stderr));
    if (!write) return parseMysql(r.stdout);
    const { body, affected } = splitRowCount(r.stdout);
    return { ...parseMysql(body), affected };
  }
  const marker = 'NULL-' + crypto.randomBytes(8).toString('hex');
  const setup = ['\\set QUIET on', '\\set ON_ERROR_STOP on', '\\pset format csv', `\\pset null ${marker}`];
  const script = [...setup, ...(write ? ['\\set QUIET off'] : []), sql, ';', ''].join('\n');
  const r = run(conn, shellArgs(conn), script);
  if (r.status !== 0) throw new Error(clientError(r.stderr));
  if (!write) return parseCsv(r.stdout, marker);
  const { body, affected } = splitCommandTag(r.stdout);
  return { ...parseCsv(body, marker), affected };
}

// One PDO call inside the site's PHP container, answering columns and rows as
// JSON. Values that are not valid UTF-8, such as blobs, come back substituted.
const SQLITE_PHP = `
$pdo = new PDO('sqlite:' . $argv[1], null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$st = $pdo->query($argv[2]);
$cols = [];
for ($i = 0; $i < $st->columnCount(); $i++) $cols[] = $st->getColumnMeta($i)['name'];
$rows = $st->fetchAll(PDO::FETCH_NUM);
echo json_encode(['columns' => $cols, 'rows' => $rows, 'affected' => $st->rowCount()], JSON_INVALID_UTF8_SUBSTITUTE);
`;

function sqlitePath(conn) {
  let env = {};
  try {
    env = parseEnv(fs.readFileSync(path.join(conn.sitePath, '.env'), 'utf8'));
  } catch {}
  return sqliteFile(conn.sitePath, env);
}

function sqlite(conn, sql, { write = false } = {}) {
  const file = sqlitePath(conn);
  if (!fs.existsSync(file)) throw new Error(`the SQLite file ${file} does not exist`);
  const r = run(conn, ['php', '-r', SQLITE_PHP, file, sql]);
  if (r.status !== 0) throw new Error((r.stdout + r.stderr).replace(/^PHP /gm, '').trim() || 'php failed');
  const out = JSON.parse(r.stdout);
  const rows = out.rows.map((row) => row.map((v) => (v === null ? null : String(v))));
  return write ? { columns: out.columns, rows, affected: out.affected } : { columns: out.columns, rows };
}

function query(conn, sql, opts) {
  return conn.engine === 'sqlite' ? sqlite(conn, sql, opts) : shell(conn, sql, opts);
}

// The name to show for the connection: the picked database, or for the site's
// default the one db:shell opened, or the SQLite file.
function databaseName(conn) {
  if (conn.database) return conn.database;
  if (conn.engine === 'sqlite') return path.basename(sqlitePath(conn));
  const sql = conn.engine === 'postgres' ? 'SELECT current_database();' : 'SELECT DATABASE();';
  return query(conn, sql).rows[0]?.[0] ?? null;
}

const TABLES_SQL = {
  mysql: "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME;",
  postgres: "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema <> 'public', table_schema, table_name;",
  sqlite: "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
};

function tables(conn) {
  const { rows } = query(conn, TABLES_SQL[conn.engine]);
  // db:shell still connects when the .env names no database, and MySQL then
  // lists nothing, which would read as an empty database.
  if (conn.engine === 'mysql' && !rows.length && databaseName(conn) == null) {
    throw new Error("this site's .env names no database, so there is nothing to browse");
  }
  if (conn.engine === 'postgres') return rows.map(([schema, name, type]) => ({ schema, name, view: /VIEW/i.test(type) }));
  return rows.map(([name, type]) => ({ schema: '', name, view: /VIEW/i.test(type) }));
}

function columns(conn, table) {
  return mapColumns(conn.engine, query(conn, structureSql(conn.engine, table).columns).rows);
}

function structure(conn, table) {
  const sql = structureSql(conn.engine, table);
  return {
    columns: mapColumns(conn.engine, query(conn, sql.columns).rows),
    indexes: mapIndexes(conn.engine, query(conn, sql.indexes).rows),
    foreignKeys: mapForeignKeys(conn.engine, query(conn, sql.foreignKeys).rows),
  };
}

// One page of a table, sorted and filtered. The table must come from tables(),
// never from the request as typed, so only names that exist reach the SQL.
function page(conn, table, { limit, offset, sort, filter }) {
  const cols = columns(conn, table);
  const { sql, countSql } = buildPage({ engine: conn.engine, table, columns: cols, sort, filter, limit, offset });
  const result = query(conn, sql);
  // mysql prints nothing at all for an empty result, header included.
  if (!result.columns.length) result.columns = cols.map((c) => c.name);
  const total = Number(query(conn, countSql).rows[0][0]);
  return { ...result, total, keys: cols.filter((c) => c.key).map((c) => c.name) };
}

module.exports = { withEngine, databaseName, query, tables, page, structure };
