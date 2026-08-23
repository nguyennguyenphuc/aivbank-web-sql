/* SQL editor (CodeMirror 5, vendored) + autocomplete.
 *
 * AUTOCOMPLETE SOURCE RULE (API_CONTRACT.md §9.1 and §9.3):
 * The only source of table and column names in this file is `schemaRef.value`,
 * which is set exclusively from GET /schema at runtime. There is no fallback
 * list, no bundled schema file, no name taken from the parameter book or ERD,
 * and the query history is deliberately NOT used as a completion source (a
 * student who typed a name that does not exist must not see it suggested back).
 * If GET /schema has not returned yet, autocomplete offers keywords only.
 */

/* SQL language keywords. These are grammar, not schema — safe to hardcode. */
const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON', 'USING',
  'WITH', 'AS', 'DISTINCT', 'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT',
  'AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'BETWEEN', 'LIKE', 'ILIKE',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST', 'COALESCE', 'NULLIF',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ROUND', 'ABS',
  'OVER', 'PARTITION BY', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD',
  'DATE_TRUNC', 'EXTRACT', 'STRFTIME', 'CURRENT_DATE',
  'ASC', 'DESC', 'QUALIFY',
];

const WORD_RE = /[\w$]/;

export function createEditor(textarea, { schemaRef, onRun }) {
  const cm = CodeMirror.fromTextArea(textarea, {
    mode: 'text/x-sql',
    lineNumbers: true,
    lineWrapping: true,
    indentUnit: 2,
    smartIndent: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: true,
    placeholder: 'Gõ câu SELECT rồi nhấn Ctrl/Cmd + Enter để chạy.',
    extraKeys: {
      'Ctrl-Enter': () => onRun(),
      'Cmd-Enter': () => onRun(),
      'Ctrl-Space': (c) => showHints(c, schemaRef, true),
      'Shift-Tab': 'indentLess',
      Tab: (c) => {
        if (c.somethingSelected()) c.indentSelection('add');
        else c.replaceSelection('  ', 'end');
      },
    },
  });

  // CodeMirror hides the original labelled textarea and creates its own input.
  // Carry the accessible name onto the actual focus target.
  const input = cm.getInputField();
  input.setAttribute('aria-label', 'Trình soạn thảo truy vấn SQL');
  input.setAttribute('aria-multiline', 'true');

  // Auto-suggest while typing, but never steal Enter: completeSingle is false.
  cm.on('inputRead', (c, change) => {
    if (change.origin !== '+input') return;
    const typed = change.text[0];
    if (!typed) return;
    if (WORD_RE.test(typed) || typed === '.') {
      const tok = currentWord(c);
      if (typed === '.' || tok.word.length >= 2) showHints(c, schemaRef, false);
    }
  });

  return cm;
}

/** The identifier fragment immediately before the cursor, plus its qualifier. */
function currentWord(cm) {
  const cur = cm.getCursor();
  const line = cm.getLine(cur.line) || '';
  let start = cur.ch;
  while (start > 0 && WORD_RE.test(line.charAt(start - 1))) start--;
  const word = line.slice(start, cur.ch);

  // Look further left for `qualifier.` (an alias or a table name).
  let q = start;
  let qualifier = null;
  if (q > 0 && line.charAt(q - 1) === '.') {
    let qEnd = q - 1;
    let qStart = qEnd;
    while (qStart > 0 && WORD_RE.test(line.charAt(qStart - 1))) qStart--;
    if (qStart < qEnd) qualifier = line.slice(qStart, qEnd);
  }
  return { word, start, end: cur.ch, line: cur.line, qualifier };
}

/**
 * Map alias -> table, using only names that exist in the API-provided schema.
 * A name that the API did not return is ignored, so nothing outside the schema
 * can ever reach the suggestion list through this path.
 */
function referencedTables(sql, schema) {
  const byName = schema ? schema.byName : null;
  const found = new Map(); // alias (lowercase) -> table object
  const order = [];
  if (!byName) return { found, order };

  const re = /\b(?:FROM|JOIN)\s+"?([A-Za-z_][\w]*)"?(?:\s+(?:AS\s+)?"?([A-Za-z_][\w]*)"?)?/gi;
  const NOT_ALIAS = new Set([
    'on', 'using', 'where', 'group', 'order', 'having', 'limit', 'join', 'inner',
    'left', 'right', 'full', 'cross', 'union', 'except', 'intersect', 'qualify', 'window',
  ]);
  let m;
  while ((m = re.exec(sql)) !== null) {
    const table = byName.get(m[1].toLowerCase());
    if (!table) continue; // not an API-known table -> never suggested
    if (!order.includes(table)) order.push(table);
    found.set(table.name.toLowerCase(), table);
    const alias = m[2];
    if (alias && !NOT_ALIAS.has(alias.toLowerCase())) found.set(alias.toLowerCase(), table);
  }
  return { found, order };
}

function showHints(cm, schemaRef, explicit) {
  cm.showHint({
    completeSingle: false,
    closeOnUnfocus: true,
    hint: () => buildHints(cm, schemaRef.value, explicit),
  });
}

function buildHints(cm, schema, explicit) {
  const ctx = currentWord(cm);
  const prefix = ctx.word.toLowerCase();
  const sql = cm.getValue();
  const { found, order } = referencedTables(sql, schema);

  let list = [];

  if (ctx.qualifier) {
    // `alias.` / `table.` -> only that table's columns. If the qualifier is not
    // an API-known table or alias, we offer nothing rather than guessing.
    const table = found.get(ctx.qualifier.toLowerCase());
    if (!table) return null;
    list = table.columns.map((c) => completion(c.name, 'cột', `${c.type}`, 'hint-col'));
  } else {
    const tableItems = schema
      ? schema.tables.map((t) =>
          completion(t.name, 'bảng', `${t.columns.length} cột`, 'hint-table')
        )
      : [];

    const usedCols = [];
    const seen = new Set();
    for (const t of order) {
      for (const c of t.columns) {
        const key = c.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        usedCols.push(completion(c.name, 'cột', `${t.name} · ${c.type}`, 'hint-col'));
      }
    }

    const kw = KEYWORDS.map((k) => completion(k, 'từ khoá', '', 'hint-kw'));

    // Columns of tables already referenced rank first: that is what the student
    // is most likely typing. Then tables, then keywords.
    list = [...usedCols, ...tableItems, ...kw];
  }

  const filtered = prefix
    ? list.filter((it) => it.text.toLowerCase().includes(prefix))
    : list;

  // Prefix matches before substring matches.
  filtered.sort((a, b) => {
    const ap = a.text.toLowerCase().startsWith(prefix) ? 0 : 1;
    const bp = b.text.toLowerCase().startsWith(prefix) ? 0 : 1;
    return ap - bp;
  });

  if (!filtered.length) return null;
  if (!explicit && filtered.length === 1 && filtered[0].text.toLowerCase() === prefix) return null;

  return {
    list: filtered.slice(0, 60),
    from: CodeMirror.Pos(ctx.line, ctx.start),
    to: CodeMirror.Pos(ctx.line, ctx.end),
  };
}

function completion(text, kind, detail, cls) {
  return {
    text,
    className: cls,
    render(el) {
      const name = document.createElement('span');
      name.className = 'hint-name';
      name.textContent = text;
      const meta = document.createElement('span');
      meta.className = 'hint-meta';
      meta.textContent = detail ? `${kind} · ${detail}` : kind;
      el.appendChild(name);
      el.appendChild(meta);
    },
  };
}

/** Insert text at the cursor (used by the schema sidebar). */
export function insertAtCursor(cm, text) {
  const cur = cm.getCursor();
  const before = cm.getRange({ line: cur.line, ch: Math.max(0, cur.ch - 1) }, cur);
  const pad = before && /[\w"`.]/.test(before) ? ' ' : '';
  cm.replaceSelection(pad + text);
  cm.focus();
}
