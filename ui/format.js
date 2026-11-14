// A query result, columns and rows of strings or null, as JSON, CSV or a text
// table. Loaded by the tab as window.dbFormat, and by the tests through require.
(function (exports) {
  function toJson(columns, rows) {
    return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), null, 2);
  }

  const csvField = (v) => (v === null ? '' : /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  function toCsv(columns, rows) {
    return [columns, ...rows].map((r) => r.map(csvField).join(',') + '\r\n').join('');
  }

  // One line per row, so a newline or tab in a value is written as \n or \t.
  const textCell = (v) => (v === null ? 'NULL' : v.replaceAll('\n', '\\n').replaceAll('\t', '\\t'));
  function toText(columns, rows) {
    const cells = rows.map((r) => r.map(textCell));
    const widths = columns.map((c, i) => Math.max([...c].length, ...cells.map((r) => [...r[i]].length)));
    const rule = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
    const line = (r) => '| ' + r.map((v, i) => v + ' '.repeat(widths[i] - [...v].length)).join(' | ') + ' |';
    return [rule, line(columns), rule, ...cells.map(line), rule].join('\n');
  }

  Object.assign(exports, { toJson, toCsv, toText });
})(typeof module === 'object' ? module.exports : (window.dbFormat = {}));
