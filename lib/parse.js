// Turning what the database clients print into columns and rows, and the bits
// of SQL the plugin writes itself. Pure functions, so they are what the tests cover.
const path = require('node:path');

// The mysql client in batch mode prints tab-separated rows under a header, with
// tabs, newlines and backslashes escaped. It prints NULL for a null and for the
// string 'NULL' alike, so both read as null.
function parseMysql(out) {
  const lines = out.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return { columns: [], rows: [] };
  const split = (line) => line.split('\t');
  const columns = split(lines[0]).map(unescapeMysql);
  const rows = lines.slice(1).map((l) => split(l).map((v) => (v === 'NULL' ? null : unescapeMysql(v))));
  return { columns, rows };
}

const MYSQL_ESCAPES = { n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\' };
function unescapeMysql(v) {
  return v.replace(/\\(.)/g, (m, c) => MYSQL_ESCAPES[c] ?? m);
}

// psql's csv format: RFC 4180 quoting, a header line, and the null string the
// caller set with \pset null, which is a random marker no real value matches.
function parseCsv(out, nullMarker) {
  const records = [];
  let rec = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  const endField = () => {
    rec.push(!wasQuoted && field === nullMarker ? null : field);
    field = '';
    wasQuoted = false;
  };
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (quoted) {
      if (ch === '"' && out[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') { quoted = true; wasQuoted = true; }
    else if (ch === ',') endField();
    else if (ch === '\n') { endField(); records.push(rec); rec = []; }
    else field += ch;
  }
  if (field !== '' || rec.length) { endField(); records.push(rec); }
  if (!records.length) return { columns: [], rows: [] };
  return { columns: records[0], rows: records.slice(1) };
}

function quoteIdent(engine, name) {
  switch (engine) {
    case 'mysql': return '`' + name.replaceAll('`', '``') + '`';
    case 'postgres':
    case 'sqlite': return '"' + name.replaceAll('"', '""') + '"';
  }
  throw new Error(`unknown engine ${engine}`);
}

// A string literal for a name the plugin already validated against the table
// list; MySQL also treats a backslash as an escape.
function quoteLiteral(engine, v) {
  if (engine === 'mysql') v = v.replaceAll('\\', '\\\\');
  return "'" + v.replaceAll("'", "''") + "'";
}

// The SQLite file a site's .env points at, relative paths taken from the site's
// folder. DATABASE_URL may carry Symfony's %kernel.project_dir%.
function sqliteFile(sitePath, env) {
  let file = env.DB_DATABASE || '';
  const url = env.DATABASE_URL || '';
  if (!file && /^sqlite3?:/i.test(url)) {
    file = url.replace(/^sqlite3?:\/\//i, '').replace('%kernel.project_dir%', sitePath);
  }
  if (!file) file = 'database/database.sqlite';
  return path.resolve(sitePath, file);
}

// A dotenv file: KEY=value lines, quotes around a value dropped, and a # that
// starts an unquoted value's comment cut off with it.
function parseEnv(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const quoted = m[2].match(/^(['"])(.*)\1$/);
    env[m[1]] = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, '');
  }
  return env;
}

// psql ends a write with its command tag, like UPDATE 2 or INSERT 0 2, after
// any rows a RETURNING printed; the last number in it is the rows affected.
function splitCommandTag(out) {
  const lines = out.replace(/\n$/, '').split('\n');
  const tag = lines.pop() ?? '';
  const count = tag.match(/ (\d+)$/);
  return { body: lines.length ? lines.join('\n') + '\n' : '', affected: count ? Number(count[1]) : null };
}

// The plugin follows a MySQL write with SELECT ROW_COUNT(), whose header and
// value end the output; -1 means the statement does not count rows.
function splitRowCount(out) {
  const lines = out.replace(/\n$/, '').split('\n');
  const value = Number(lines.pop());
  lines.pop();
  return { body: lines.length ? lines.join('\n') + '\n' : '', affected: value >= 0 ? value : null };
}

module.exports = { parseMysql, parseCsv, quoteIdent, quoteLiteral, sqliteFile, parseEnv, splitCommandTag, splitRowCount };
