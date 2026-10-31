'use strict';
/**
 * 외부 라이브러리 없이 간단한 엑셀(.xlsx) 만들기 — 원서용 학생 정보처럼 "보기 좋게 정리된 한 장" 용도.
 *   sheets: [{ name, cols: [너비…], rows: [{ h: 높이(선택), cells: [{ v: 글, s: 스타일 이름, span: 가로로 합칠 칸 수 }] }], print: { landscape } }]
 *   글자는 모두 문자열로 넣음(날짜·숫자도 보이는 그대로), 줄바꿈은 \n
 */
const { writeZip } = require('./zip');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''); // XML에 못 넣는 제어 문자

/* 스타일: 이름 → cellXfs 번호 (아래 STYLES_XML 순서와 같아야 함) */
const STYLE = { def: 0, title: 1, sub: 2, sec: 3, label: 4, value: 5, th: 6, td: 7, tdc: 8, total: 9, note: 10, blank: 11 };
const NAVY = 'FF0B1B45', LINE = 'FFC9D1DF';
const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="6">' +
    '<font><sz val="10"/><name val="Malgun Gothic"/><family val="2"/></font>' +
    '<font><b/><sz val="10"/><name val="Malgun Gothic"/><family val="2"/></font>' +
    `<font><b/><sz val="16"/><color rgb="${NAVY}"/><name val="Malgun Gothic"/><family val="2"/></font>` +
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Malgun Gothic"/><family val="2"/></font>' +
    '<font><sz val="9"/><color rgb="FF6B7280"/><name val="Malgun Gothic"/><family val="2"/></font>' +
    `<font><b/><sz val="10"/><color rgb="${NAVY}"/><name val="Malgun Gothic"/><family val="2"/></font>` +
  '</fonts>' +
  '<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    `<fill><patternFill patternType="solid"><fgColor rgb="${NAVY}"/><bgColor indexed="64"/></patternFill></fill>` +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF1F3F7"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE3E8F2"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF6F2E3"/><bgColor indexed="64"/></patternFill></fill>' +
  '</fills>' +
  `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="${LINE}"/></left><right style="thin"><color rgb="${LINE}"/></right><top style="thin"><color rgb="${LINE}"/></top><bottom style="thin"><color rgb="${LINE}"/></bottom><diagonal/></border></borders>` +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="12">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // def
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>' + // title
    '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>' + // sub
    '<xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" indent="1"/></xf>' + // sec
    '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1" indent="1"/></xf>' + // label
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1" indent="1"/></xf>' + // value
    '<xf numFmtId="0" fontId="5" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' + // th
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' + // td
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' + // tdc
    '<xf numFmtId="0" fontId="1" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' + // total
    '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' + // note
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // blank
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
/** 글 폭(엑셀 글자 단위): 한글·한자 등 넓은 글자는 2 */
function textWidth(t) { let w = 0; for (const ch of String(t)) w += /[ᄀ-ᇿ⺀-꓏가-힣豈-﫿︰-﹏＀-｠]/.test(ch) ? 2 : 1; return w; }
/** 줄바꿈된 칸의 줄 수 (엑셀은 합친 칸 높이를 스스로 맞추지 않으므로 미리 계산) */
function lineCount(v, width) {
  const w = Math.max(4, width - 2);
  return String(v).split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(textWidth(line) / w)), 0);
}

function sheetXml(sh) {
  const cols = sh.cols || [];
  const merges = [];
  const rowsXml = sh.rows.map((row, ri) => {
    const r = ri + 1;
    let c = 0, lines = 1;
    const cells = (row.cells || []).map((cell) => {
      const span = Math.max(1, cell.span || 1), st = STYLE[cell.s || 'value'] || 0, start = c;
      let width = 0; for (let k = 0; k < span; k++) width += cols[c + k] || 10;
      const v = cell.v == null ? '' : String(cell.v);
      if (v && cell.s !== 'title' && cell.s !== 'sec') lines = Math.max(lines, lineCount(v, width));
      let x = '<c r="' + colName(c) + r + '" s="' + st + '"' + (v ? ' t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>' : '/>');
      for (let k = 1; k < span; k++) x += '<c r="' + colName(c + k) + r + '" s="' + st + '"/>'; // 합친 칸도 테두리가 그려지게
      if (span > 1) merges.push(colName(start) + r + ':' + colName(start + span - 1) + r);
      c += span;
      return x;
    }).join('');
    const ht = row.h || (lines > 1 ? Math.min(400, lines * 14 + 4) : 0);
    return '<row r="' + r + '"' + (ht ? ' ht="' + ht + '" customHeight="1"' : '') + '>' + cells + '</row>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    '<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews><sheetFormatPr defaultRowHeight="18"/>' +
    (cols.length ? '<cols>' + cols.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>' : '') +
    '<sheetData>' + rowsXml + '</sheetData>' +
    (merges.length ? '<mergeCells count="' + merges.length + '">' + merges.map((m) => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>' : '') +
    '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>' +
    '<pageSetup paperSize="9" orientation="' + (sh.print && sh.print.landscape ? 'landscape' : 'portrait') + '" fitToWidth="1" fitToHeight="0"/>' +
    '</worksheet>';
}

/** 시트 이름: 엑셀 규칙(31자, 금지 문자, 중복) */
function sheetNames(list) {
  const seen = {};
  return list.map((n) => {
    let b = String(n || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || 'Sheet', x = b, i = 1;
    while (seen[x.toLowerCase()]) x = b + ' (' + (++i) + ')';
    seen[x.toLowerCase()] = 1;
    return x;
  });
}

function writeXlsx(destPath, sheets) {
  const names = sheetNames(sheets.map((s) => s.name));
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map((n, i) => '<sheet name="' + esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: STYLES_XML },
  ].concat(sheets.map((s, i) => ({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(s) })));
  writeZip(destPath, files.map((f) => ({ name: f.name, data: Buffer.from(f.data, 'utf8') })));
}

module.exports = { writeXlsx, textWidth };
