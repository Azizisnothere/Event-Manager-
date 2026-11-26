'use strict';
/**
 * CSV helpers.
 * - parseCsv: RFC 4180 parser (quotes, escaped quotes, CRLF/LF, UTF-8 BOM) used by the import processor.
 * - toCsv / escapeCsvCell: writer used for the attendance report. Cells that a spreadsheet would
 *   treat as a formula (= + - @, tab, CR) are prefixed with a single quote (Threat 5: formula injection).
 */

class CsvParseError extends Error {
  constructor(message, line) {
    super(message);
    this.name = 'CsvParseError';
    this.line = line;
  }
}

/**
 * @param {string} text
 * @param {{ maxRows?: number, maxFieldLength?: number }} [opts] maxRows counts the header row too
 *   (pass CSV_IMPORT_MAX_ROWS + 1 to allow CSV_IMPORT_MAX_ROWS data rows)
 * @returns {{ rows: Array<{ line: number, cells: string[] }> }} data rows include the header row as rows[0]
 */
function parseCsv(text, opts = {}) {
  const maxRows = opts.maxRows || Infinity;
  const maxField = opts.maxFieldLength || 2000;
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

  const rows = [];
  let cells = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;
  let line = 1;
  let rowStartLine = 1;

  const pushField = () => {
    if (field.length > maxField) throw new CsvParseError(`Field longer than ${maxField} characters`, rowStartLine);
    cells.push(fieldWasQuoted ? field : field.trim());
    field = '';
    fieldWasQuoted = false;
  };
  const pushRow = () => {
    pushField();
    const blank = cells.length === 1 && cells[0] === '';
    if (!blank) {
      if (rows.length >= maxRows) throw new CsvParseError(`More than ${maxRows - 1} data rows`, rowStartLine);
      rows.push({ line: rowStartLine, cells });
    }
    cells = [];
  };

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field.trim() !== '') throw new CsvParseError('Unexpected quote inside an unquoted field', line);
      field = '';
      inQuotes = true;
      fieldWasQuoted = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\r') {
      if (s[i + 1] === '\n') i += 1;
      pushRow();
      line += 1;
      rowStartLine = line;
    } else if (ch === '\n') {
      pushRow();
      line += 1;
      rowStartLine = line;
    } else if (fieldWasQuoted) {
      if (ch !== ' ' && ch !== '\t') throw new CsvParseError('Unexpected characters after a closing quote', line);
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new CsvParseError('Unterminated quoted field', rowStartLine);
  if (field !== '' || cells.length > 0) pushRow();
  return { rows };
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** Escapes one cell for safe opening in Excel / Sheets (Threat 5). */
function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** @param {Array<Array<any>>} rows first row is the header */
function toCsv(rows) {
  return `${rows.map((r) => r.map(escapeCsvCell).join(',')).join('\r\n')}\r\n`;
}

module.exports = { parseCsv, toCsv, escapeCsvCell, CsvParseError };
