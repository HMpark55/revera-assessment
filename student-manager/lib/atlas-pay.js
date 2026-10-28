'use strict';
/**
 * 결제 내역 글 → 결제 기록 (REVERA A)
 *   "2026년:\n6/17 ICBC KCY 9,720元 결제완료\n(여름방학 특강 Junior …)"
 *   → [{ date: '2026-06-17', amount: 9720, currency: 'CNY', method: 'ICBC KCY', memo: '여름방학 특강 Junior …', raw }]
 * 읽지 못한 글은 원문 칸에 그대로 남아 있으므로 여기서는 확실한 것만 꺼냄.
 */
const YEAR_LINE = /^\s*(20\d{2})\s*년\s*:?\s*$/;
const PAY = /(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\([월화수목금토일]\))?\s*([^\d\n&=]{0,30}?)\s*(\d{1,3}(?:,\d{3})+|\d+)\s*(元|위안|원)/g;

function cleanMethod(s) {
  let m = String(s || '').replace(/[()（）:]/g, ' ').replace(/\s+/g, ' ').trim();
  m = m.replace(/\s*(특강\s*)?선등록금?\s*/g, ' ').trim().replace(/^법인(\s*통장)?$/, '법인통장');
  return /^(결제|입금|총|=>)?$/.test(m) ? '' : m.slice(0, 40);
}
/** 연도가 안 적힌 날짜: 오늘(기준일) 이전의 가장 가까운 해 */
function guessYear(mo, dy, today) {
  const t = today || new Date();
  const y = t.getFullYear(), md = (t.getMonth() + 1) * 100 + t.getDate();
  return mo * 100 + dy <= md ? y : y - 1;
}

function parsePayments(text, opts) {
  opts = opts || {};
  const out = [];
  let year = opts.year || null;
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  lines.forEach((line, i) => {
    const y = line.match(YEAR_LINE);
    if (y) { year = Number(y[1]); return; }
    const inline = line.match(/^\s*(20\d{2})\s*년\s*:?\s*(.+)$/);
    if (inline) { year = Number(inline[1]); line = inline[2]; }
    if (!/결제|입금|완료/.test(line)) return;
    PAY.lastIndex = 0;
    let m;
    while ((m = PAY.exec(line))) {
      const before = line.slice(Math.max(0, m.index - 4), m.index);
      if (/총\s*$/.test(before)) continue; // "=> 총 10,200元" 은 합계
      const mo = Number(m[1]), dy = Number(m[2]);
      if (mo < 1 || mo > 12 || dy < 1 || dy > 31) continue;
      const next = (lines[i + 1] || '').trim();
      const tail = line.slice(PAY.lastIndex).replace(/^[\s,]*(결제\s*완료|결제완료|입금\s*완료|결제|입금)?/, '').replace(/^[\s&=>]+/, '').split(/\s*(?:&|=>)\s*/)[0].trim();
      const yy = year || guessYear(mo, dy, opts.today);
      out.push({
        date: `${yy}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}`,
        guessed: !year,
        pre: /선등록/.test(m[3] + line.slice(PAY.lastIndex, PAY.lastIndex + 12)),
        amount: Number(m[4].replace(/,/g, '')),
        currency: m[5] === '원' ? 'KRW' : 'CNY',
        method: cleanMethod(m[3]),
        memo: (/^[(（]/.test(next) ? next.replace(/^[(（]|[)）]$/g, '') : tail.replace(/^\(|\)$/g, '')).slice(0, 500),
        raw: line.trim().slice(0, 500),
      });
    }
  });
  return out;
}

/** 수강 메모의 회차권: "(10회 6,000위안)", "10회권 8,500위안" → { sessions: 10, price: 6000 } */
function parsePackage(text) {
  const m = String(text || '').match(/(\d{1,3})\s*회(?:권)?\s*([\d,]+)\s*(元|위안)/);
  return m ? { sessions: Number(m[1]), price: Number(m[2].replace(/,/g, '')) } : null;
}

module.exports = { parsePayments, parsePackage };
