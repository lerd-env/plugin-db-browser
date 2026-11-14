const test = require('node:test');
const assert = require('node:assert');
const { structureSql, mapColumns, mapIndexes, mapForeignKeys } = require('../lib/structure');

test('columns read the same from every engine', () => {
  assert.deepStrictEqual(mapColumns('mysql', [['id', 'bigint unsigned', 'NO', null, 'PRI'], ['email', 'varchar(255)', 'YES', 'x', '']]), [
    { name: 'id', type: 'bigint unsigned', nullable: false, default: null, key: true },
    { name: 'email', type: 'varchar(255)', nullable: true, default: 'x', key: false },
  ]);
  assert.deepStrictEqual(mapColumns('postgres', [['id', 'integer', 'NO', "nextval('s')", 't'], ['title', 'text', 'YES', null, 'f']]), [
    { name: 'id', type: 'integer', nullable: false, default: "nextval('s')", key: true },
    { name: 'title', type: 'text', nullable: true, default: null, key: false },
  ]);
  assert.deepStrictEqual(mapColumns('sqlite', [['id', 'INTEGER', '1', null, '1'], ['body', 'TEXT', '0', "''", '0']]), [
    { name: 'id', type: 'INTEGER', nullable: false, default: null, key: true },
    { name: 'body', type: 'TEXT', nullable: true, default: "''", key: false },
  ]);
});

test('indexes say which columns they cover and whether they are unique', () => {
  assert.deepStrictEqual(mapIndexes('mysql', [['PRIMARY', '0', 'id'], ['users_name_index', '1', 'last, first']]), [
    { name: 'PRIMARY', definition: 'UNIQUE (id)' },
    { name: 'users_name_index', definition: '(last, first)' },
  ]);
  assert.deepStrictEqual(mapIndexes('postgres', [['posts_pkey', 'CREATE UNIQUE INDEX posts_pkey ON public.posts USING btree (id)']]), [
    { name: 'posts_pkey', definition: 'CREATE UNIQUE INDEX posts_pkey ON public.posts USING btree (id)' },
  ]);
  assert.deepStrictEqual(mapIndexes('sqlite', [['users_email_unique', '1', 'email']]), [{ name: 'users_email_unique', definition: 'UNIQUE (email)' }]);
});

test('foreign keys name the column and what it points at, one entry per key', () => {
  assert.deepStrictEqual(mapForeignKeys('mysql', [['orders_user_fk', 'user_id', 'users', 'id'], ['orders_pair_fk', 'a', 'pairs', 'x'], ['orders_pair_fk', 'b', 'pairs', 'y']]), [
    { name: 'orders_user_fk', definition: 'user_id → users(id)' },
    { name: 'orders_pair_fk', definition: 'a, b → pairs(x, y)' },
  ]);
  assert.deepStrictEqual(mapForeignKeys('postgres', [['posts_user_fk', 'FOREIGN KEY (user_id) REFERENCES users(id)']]), [
    { name: 'posts_user_fk', definition: 'FOREIGN KEY (user_id) REFERENCES users(id)' },
  ]);
  assert.deepStrictEqual(mapForeignKeys('sqlite', [['0', 'user_id', 'users', 'id']]), [{ name: 'fk_0', definition: 'user_id → users(id)' }]);
});

test('the table name reaches the structure SQL only as an escaped literal', () => {
  const sql = structureSql('mysql', { schema: '', name: "o'brien\\" });
  assert.match(sql.columns, /TABLE_NAME = 'o''brien\\\\'/);
  const pg = structureSql('postgres', { schema: 'public', name: 'we"ird' });
  assert.match(pg.foreignKeys, /conrelid = '"public"."we""ird"'::regclass/);
  assert.throws(() => structureSql('oracle', { name: 'x' }), /unknown engine oracle/);
});
