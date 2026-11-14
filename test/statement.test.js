const test = require('node:test');
const assert = require('node:assert');
const { singleStatement, isRead, capRows } = require('../lib/statement');

test('one statement passes, with its trailing semicolon and whitespace dropped', () => {
  assert.equal(singleStatement('  SELECT 1;  \n'), 'SELECT 1');
  assert.equal(singleStatement("SELECT ';' AS semi, `a;b`, \"c;d\" -- trailing; comment\n"), "SELECT ';' AS semi, `a;b`, \"c;d\" -- trailing; comment");
  assert.equal(singleStatement("SELECT 'it''s; fine' /* a; b */"), "SELECT 'it''s; fine' /* a; b */");
});

test('more than one statement, or none, is refused', () => {
  assert.throws(() => singleStatement('SELECT 1; DROP TABLE users'), /one statement at a time/);
  assert.throws(() => singleStatement("SELECT 'x'; SELECT 2;"), /one statement at a time/);
  assert.throws(() => singleStatement('  ;  '), /nothing to run/);
  assert.throws(() => singleStatement('-- only a comment'), /nothing to run/);
});

test('reads are told apart from statements that change the database', () => {
  for (const sql of ['SELECT 1', ' select * from t', 'SHOW TABLES', 'DESCRIBE users', 'DESC users', 'EXPLAIN SELECT 1', 'WITH a AS (SELECT 1) SELECT * FROM a', 'VALUES (1)', 'TABLE users', 'PRAGMA table_info(users)', '-- note\nSELECT 1', '/* x */ SELECT 1', '(SELECT 1)']) {
    assert.equal(isRead(sql), true, sql);
  }
  for (const sql of ['UPDATE t SET a = 1', 'DELETE FROM t', 'INSERT INTO t VALUES (1)', 'DROP TABLE t', 'TRUNCATE t', 'ALTER TABLE t ADD c int', 'CREATE TABLE t (a int)',
    'WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone', 'PRAGMA foreign_keys = ON', 'SELECT * INTO new_t FROM t', 'EXPLAIN ANALYZE DELETE FROM t', 'SET @a = 1', 'CALL p()', 'SELECT 1 FOR UPDATE']) {
    assert.equal(isRead(sql), false, sql);
  }
});

test('a SELECT without its own LIMIT is capped one past the cap, so the tab can tell it was cut', () => {
  assert.equal(capRows('SELECT * FROM t', 1000), 'SELECT * FROM t LIMIT 1001');
  assert.equal(capRows('SELECT * FROM t LIMIT 5', 1000), 'SELECT * FROM t LIMIT 5');
  assert.equal(capRows('SELECT * FROM (SELECT * FROM t LIMIT 5) x', 1000), 'SELECT * FROM (SELECT * FROM t LIMIT 5) x LIMIT 1001');
  assert.equal(capRows('SELECT * FROM (SELECT 1) x LIMIT 5', 1000), 'SELECT * FROM (SELECT 1) x LIMIT 5');
  assert.equal(capRows("SELECT 'limit 3' AS s", 1000), "SELECT 'limit 3' AS s LIMIT 1001");
  assert.equal(capRows('SELECT 1 -- done', 1000), 'SELECT 1 -- done\n LIMIT 1001');
  assert.equal(capRows('SHOW TABLES', 1000), 'SHOW TABLES');
  assert.equal(capRows('WITH a AS (SELECT 1) SELECT * FROM a', 1000), 'WITH a AS (SELECT 1) SELECT * FROM a LIMIT 1001');
});
