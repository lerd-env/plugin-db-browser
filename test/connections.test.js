const test = require('node:test');
const assert = require('node:assert');
const { connectionsFor, pickConnection } = require('../lib/connections');

const services = [{ service: 'mysql', family: 'mysql' }, { service: 'mariadb-app', family: 'mariadb' }, { service: 'postgres', family: 'postgres' }];

test('a site lists its own databases with the engine each service speaks', () => {
  const site = { has_database: true, databases: [{ service: 'mysql', database: 'shop' }, { service: 'mariadb-app', database: 'shop_legacy' }] };
  assert.deepStrictEqual(connectionsFor(site, services), [
    { service: 'mysql', database: 'shop', engine: 'mysql' },
    { service: 'mariadb-app', database: 'shop_legacy', engine: 'mysql' },
  ]);
});

test('a site on SQLite, or a lerd that lists no databases, gets the site default', () => {
  assert.deepStrictEqual(connectionsFor({ has_database: true }, services), [{ service: '', database: '', engine: '' }]);
  assert.deepStrictEqual(connectionsFor({ name: 'old-lerd' }, services), [{ service: '', database: '', engine: '' }]);
});

test('a service lerd does not list, or an engine this plugin cannot read, is refused by name', () => {
  assert.throws(() => connectionsFor({ databases: [{ service: 'gone', database: 'x' }] }, services), /service gone is not one lerd lists/);
  assert.throws(() => connectionsFor({ databases: [{ service: 'mongo', database: 'x' }] }, [{ service: 'mongo', family: 'mongo' }]), /mongo speaks mongo, which this plugin cannot read/);
});

const list = [{ service: 'mysql', database: 'shop', engine: 'mysql' }, { service: 'mariadb-app', database: 'legacy', engine: 'mysql' }];

test('pickConnection takes the requested one, then the remembered one, then the first', () => {
  assert.deepStrictEqual(pickConnection(list, { service: 'mariadb-app', database: 'legacy' }, null), { conn: list[1] });
  assert.deepStrictEqual(pickConnection(list, null, { service: 'mariadb-app', database: 'legacy' }), { conn: list[1] });
  assert.deepStrictEqual(pickConnection(list, null, null), { conn: list[0] });
});

test('a request for a database the site does not point at is refused', () => {
  assert.throws(() => pickConnection(list, { service: 'mysql', database: 'other_site' }, null), /mysql \/ other_site is not one of this site's databases/);
});

test('a remembered pick that is gone falls back to the first, and says so', () => {
  assert.deepStrictEqual(pickConnection(list, null, { service: 'mysql', database: 'dropped' }), {
    conn: list[0],
    notice: 'mysql / dropped is no longer one of this site\'s databases, showing mysql / shop',
  });
});
