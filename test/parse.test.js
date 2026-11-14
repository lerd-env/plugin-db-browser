const test = require('node:test');
const assert = require('node:assert');
const { parseMysql, parseCsv, quoteIdent, sqliteFile, parseEnv, splitCommandTag, splitRowCount, splitBatch } = require('../lib/parse');

test('parseMysql reads the header and unescapes batch values', () => {
  const out = 'a\tb\tc\n1\tNULL\tx\\ty\\nz\\\\w\n';
  assert.deepStrictEqual(parseMysql(out), { columns: ['a', 'b', 'c'], rows: [['1', null, 'x\ty\nz\\w']] });
});

test('parseMysql answers no columns for an empty result', () => {
  assert.deepStrictEqual(parseMysql(''), { columns: [], rows: [] });
});

test('parseCsv keeps quoted newlines and commas, and maps the null marker to null', () => {
  const out = 'a,b,c\n1,NUL123,"x, y\nz ""q"""\n';
  assert.deepStrictEqual(parseCsv(out, 'NUL123'), { columns: ['a', 'b', 'c'], rows: [['1', null, 'x, y\nz "q"']] });
});

test('parseCsv keeps the header of an empty result', () => {
  assert.deepStrictEqual(parseCsv('a,b\n', 'N'), { columns: ['a', 'b'], rows: [] });
});

test('quoteIdent doubles the quote character of each engine', () => {
  assert.equal(quoteIdent('mysql', 'we`ird'), '`we``ird`');
  assert.equal(quoteIdent('postgres', 'we"ird'), '"we""ird"');
  assert.equal(quoteIdent('sqlite', 'plain'), '"plain"');
  assert.throws(() => quoteIdent('oracle', 'x'), /unknown engine oracle/);
});

test('sqliteFile finds the file from DB_DATABASE, DATABASE_URL, or the default', () => {
  assert.equal(sqliteFile('/s', { DB_DATABASE: 'db/app.sqlite' }), '/s/db/app.sqlite');
  assert.equal(sqliteFile('/s', { DB_DATABASE: '/abs/app.db' }), '/abs/app.db');
  assert.equal(sqliteFile('/s', { DATABASE_URL: 'sqlite:///%kernel.project_dir%/var/data.db' }), '/s/var/data.db');
  assert.equal(sqliteFile('/s', {}), '/s/database/database.sqlite');
});

test('parseEnv reads quoted values, skips comments, and drops inline comments', () => {
  const text = '# a comment\nDB_CONNECTION="sqlite"\nDB_DATABASE=\'db/app.sqlite\'\nAPP_NAME=shop # the name\nEMPTY=\n  SPACED = yes \n';
  assert.deepStrictEqual(parseEnv(text), { DB_CONNECTION: 'sqlite', DB_DATABASE: 'db/app.sqlite', APP_NAME: 'shop', EMPTY: '', SPACED: 'yes' });
});

test('splitCommandTag takes psql\'s closing tag off a write and reads the row count from it', () => {
  assert.deepStrictEqual(splitCommandTag('UPDATE 2\n'), { body: '', affected: 2 });
  assert.deepStrictEqual(splitCommandTag('id,n\n1,x\nINSERT 0 2\n'), { body: 'id,n\n1,x\n', affected: 2 });
  assert.deepStrictEqual(splitCommandTag('CREATE TABLE\n'), { body: '', affected: null });
  assert.deepStrictEqual(splitCommandTag(''), { body: '', affected: null });
});

test('splitRowCount takes the ROW_COUNT() the plugin appended off the end of mysql\'s output', () => {
  assert.deepStrictEqual(splitRowCount('ROW_COUNT()\n3\n'), { body: '', affected: 3 });
  assert.deepStrictEqual(splitRowCount('id\tn\n1\tx\nROW_COUNT()\n1\n'), { body: 'id\tn\n1\tx\n', affected: 1 });
  assert.deepStrictEqual(splitRowCount('ROW_COUNT()\n-1\n'), { body: '', affected: null });
});

test('splitBatch cuts one session\'s output at the marker rows, empty results included', () => {
  const M = 'b0123abcd';
  const out = `a\tb\n1\t2\n${M}\n${M}\n${M}\n${M}\nc\n3\n${M}\n${M}\n`;
  assert.deepStrictEqual(splitBatch(out, M, 3), ['a\tb\n1\t2\n', '', 'c\n3\n']);
  assert.throws(() => splitBatch(`a\n1\n${M}\n${M}\n`, M, 2), /expected 2 results from the database, got 1/);
});
