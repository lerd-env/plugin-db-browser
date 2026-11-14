// Reading a typed SQL statement just enough to run it safely: one statement at
// a time, whether it changes the database, and a row cap on a SELECT. The
// scanner knows quotes and comments, so a ; or a keyword inside them is text.

// Splits sql into code, string and comment pieces. A backslash escapes the
// next character inside quotes, as MySQL reads it.
function scan(sql) {
  const parts = [];
  let i = 0;
  const push = (type, end) => {
    parts.push({ type, text: sql.slice(i, end) });
    i = end;
  };
  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--' || ch === '#') {
      const nl = sql.indexOf('\n', i);
      push('comment', nl === -1 ? sql.length : nl);
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      push('comment', end === -1 ? sql.length : end + 2);
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\') j += 2;
        else if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j++;
      }
      push('string', Math.min(j + 1, sql.length));
    } else {
      let j = i;
      while (j < sql.length && !/['"`#]/.test(sql[j]) && sql.slice(j, j + 2) !== '--' && sql.slice(j, j + 2) !== '/*') j++;
      push('code', j);
    }
  }
  return parts;
}

const blank = (parts) => parts.every((p) => p.type === 'comment' || !p.text.trim());

// The statement without its trailing ; and whitespace. More than one
// statement, or only whitespace and comments, is refused.
function singleStatement(sql) {
  const parts = scan(sql);
  for (let n = 0; n < parts.length; n++) {
    const p = parts[n];
    if (p.type !== 'code') continue;
    const semi = p.text.indexOf(';');
    if (semi === -1) continue;
    const rest = [{ type: 'code', text: p.text.slice(semi + 1) }, ...parts.slice(n + 1)];
    if (!blank(rest)) throw new Error('run one statement at a time');
    const head = parts.slice(0, n).map((q) => q.text).join('') + p.text.slice(0, semi);
    if (blank(scan(head))) throw new Error('nothing to run');
    return head.trim();
  }
  if (blank(parts)) throw new Error('nothing to run');
  return sql.trim();
}

// The statement's code with strings emptied and comments dropped, upper-cased.
const code = (sql) => scan(sql).map((p) => (p.type === 'code' ? p.text : p.type === 'string' ? "''" : ' ')).join('').toUpperCase();

const READS = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'VALUES', 'TABLE', 'PRAGMA'];
// Words that make a statement write even when it starts like a read, such as
// a data-modifying CTE, SELECT ... INTO or EXPLAIN ANALYZE of a DELETE.
// REPLACE( is MySQL's string function, not the statement.
const WRITES = /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|INTO|CALL|SET|REPLACE(?!\s*\())\b/;

function isRead(sql) {
  const c = code(sql).trim().replace(/^\(+\s*/, '');
  const first = c.match(/^[A-Z]+/)?.[0];
  if (!READS.includes(first)) return false;
  if (first === 'PRAGMA') return !c.includes('=');
  return !WRITES.test(c) && !/\bFOR\s+(UPDATE|SHARE)\b/.test(c);
}

// The code outside any parentheses, where a statement's own LIMIT sits.
function topLevel(sql) {
  let depth = 0;
  let out = '';
  for (const ch of code(sql)) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

// A SELECT or WITH with no LIMIT of its own at the top level gets one a row
// past the cap. A line comment at the end would swallow it, hence the newline.
function capRows(sql, cap) {
  const first = code(sql).trim().match(/^[A-Z]+/)?.[0];
  if (first !== 'SELECT' && first !== 'WITH') return sql;
  if (/\bLIMIT\b/.test(topLevel(sql))) return sql;
  const parts = scan(sql);
  const last = parts[parts.length - 1];
  const lineComment = last?.type === 'comment' && !last.text.startsWith('/*');
  return `${sql}${lineComment ? '\n' : ''} LIMIT ${cap + 1}`;
}

module.exports = { singleStatement, isRead, capRows };
