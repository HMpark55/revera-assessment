'use strict';
/**
 * 원장님 상담 스케줄(구글 시트) 읽기 — 읽기만, 시트는 절대 수정하지 않음.
 *
 * 시트 모양 (월별 탭, 예: "10 Oct 2026")
 *   - 주 단위 블록: 날짜 줄(B~H 열에 9/28/2026 … 월~일) 다음에 30분 단위 시간 줄(A열 "08:00 - 08:30" …)
 *     08:00 부터 밤 12:00 까지 순서대로 (12시간 표기라 순서로 시각을 계산)
 *   - 일정 하나 = 위아래로 이어진 칸 묶음: 첫 칸이 누구(예: "홍서우 학생", "김예린 부모님 미팅"), 다음 칸들이 종류·메모
 *   - 그날 첫 시간 칸(08:00)에 "미국"/"한국"/"상해" 만 적혀 있으면 출장 표시 → 그날 시간은 그 나라 현지 시간
 *   - "=>5:20시작" 같은 칸은 바로 왼쪽 열(전날 열) 같은 높이 일정의 실제 시작 시각
 * Compass 에는 상해 시간으로 바꿔서 저장. Compass 학생 이름이 들어간 일정만 가져옴.
 */

const ZONES = { 미국: 'America/Los_Angeles', 한국: 'Asia/Seoul', 상해: 'Asia/Shanghai', 중국: 'Asia/Shanghai' };
const HOME_TZ = 'Asia/Shanghai';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "10 Oct 2026" 형식 탭 이름 */
function tabName(y, m) { return m + ' ' + MONTHS[m - 1] + ' ' + y; }

/** 그 시간대의 UTC 와의 차이(분) — 서머타임 반영 */
function tzOffset(tz, utcMs) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(utcMs)).forEach((x) => { p[x.type] = x.value; });
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - utcMs) / 60000;
}
/** tz 의 현지 날짜·분 → 상해 'YYYY-MM-DDTHH:MM' */
function toHome(ymd, minutes, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const local = Date.UTC(y, m - 1, d) + minutes * 60000;
  let utc = local - tzOffset(tz, local) * 60000;
  utc = local - tzOffset(tz, utc) * 60000; // 서머타임 경계 보정
  const home = new Date(utc + tzOffset(HOME_TZ, utc) * 60000);
  return home.toISOString().slice(0, 16);
}
const pad = (n) => (n < 10 ? '0' : '') + n;
const hm = (min) => pad(Math.floor(min / 60) % 24) + ':' + pad(min % 60);

/** 종류·메모 줄인지 (예: "미팅", "ZOOM 미팅", "1:1 유료 상담 Paid ok", "(HKU, NUS 전공 상의)") — 누구 줄(학생·부모님)이 아니면서 이런 말이 있으면 */
function isDetail(v) {
  return !/(학생|부모님|어머님|아버님|어머니|아버지)/.test(v) && /(미팅|상담|zoom|paid|유료|할인|대면|전화|통화|^\()/i.test(v);
}

/** 회색 배경 칸 = 취소된 일정 (시트에서 취소하면 회색으로 칠함). 아주 연한 회색·흰색은 제외 */
function isGray(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) return false;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16));
  return Math.max(r, g, b) - Math.min(r, g, b) <= 12 && Math.max(r, g, b) <= 0xda && Math.min(r, g, b) >= 0x40;
}

/** 시트 값(2차원 배열) → 일정 목록 [{ key, date, start(현지 분), end, zone, title, detail, startAt, endAt, sheetLabel }]
 *  colors(같은 모양의 배경색 배열)를 주면 회색 칸은 취소로 보고 빼며, 뺀 일정 수는 out.cancelled */
function parseSheet(values, tab, colors) {
  const rows = (values || []).map((r) => (r || []).map((c) => String(c == null ? '' : c).trim()));
  const gray = (ri, c) => !!(colors && colors[ri] && isGray(colors[ri][c]));
  const out = [];
  let cancelled = 0;
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    const dates = [];
    for (let c = 1; c <= 7; c++) { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(r[c] || ''); dates[c] = m ? m[3] + '-' + pad(+m[1]) + '-' + pad(+m[2]) : ''; }
    if (dates.filter(Boolean).length < 3) { i++; continue; }
    // 날짜 줄 다음의 시간 줄들 (A열이 "HH:MM - HH:MM")
    const slots = [];
    let j = i + 1;
    while (j < rows.length && !/^\d{1,2}:\d{2}\s*-/.test(rows[j][0] || '')) { if (j - i > 3) break; j++; }
    while (j < rows.length && /^\d{1,2}:\d{2}\s*-/.test(rows[j][0] || '')) { slots.push(j); j++; }
    for (let c = 1; c <= 7; c++) {
      if (!dates[c]) continue;
      let zoneWord = '';
      const cells = slots.map((ri, k) => {
        let v = rows[ri][c] || '';
        if (v && gray(ri, c)) { if (!isDetail(v) && !ZONES[v] && !/^=>/.test(v)) cancelled++; v = ''; } // 취소된 일정
        if (k === 0 && ZONES[v]) { zoneWord = v; v = ''; }
        if (/^=>/.test(v)) v = ''; // 시작 시각 메모 (왼쪽 열 일정에 붙임)
        return v;
      });
      const tz = ZONES[zoneWord] || HOME_TZ;
      // 이어진 칸 묶음을 일정으로 나눔: 누구 줄(제목) → 종류·메모 줄. 같은 제목이 이어지면 같은 일정(길게), 다른 누구 줄이 나오면 새 일정
      const evs = [];
      let cur = null;
      cells.forEach((v, k) => {
        if (!v) { cur = null; return; }
        if (cur && v === cur.title) { cur.last = k; return; }
        if (cur && isDetail(v)) { cur.details.push(v); cur.last = k; return; }
        cur = { title: v, details: [], first: k, last: k };
        evs.push(cur);
      });
      for (const e of evs) {
        let start = 8 * 60 + e.first * 30, end = 8 * 60 + (e.last + 1) * 30;
        // 오른쪽 열 같은 높이의 "=>5:20시작" 메모 → 실제 시작 시각 (가장 가까운 오전/오후)
        for (let q = e.first; q <= e.last; q++) {
          const note = (rows[slots[q]][c + 1] || '').match(/^=>\s*(\d{1,2}):(\d{2})/);
          if (!note) continue;
          let best = null;
          for (const hh of [+note[1] % 12, +note[1] % 12 + 12]) { const mm = hh * 60 + +note[2]; if (best == null || Math.abs(mm - start) < Math.abs(best - start)) best = mm; }
          start = best;
          if (end <= start) end = start + 30;
        }
        out.push({
          key: dates[c] + '|' + hm(8 * 60 + e.first * 30) + '|' + e.title, tab, date: dates[c], start, end, zone: zoneWord, title: e.title, detail: e.details.join(' / '),
          startAt: toHome(dates[c], start, tz), endAt: toHome(dates[c], end, tz),
          sheetLabel: zoneWord ? dates[c].slice(5).replace('-', '/') + ' ' + hm(start) + ' ' + zoneWord + ' 시간' : '',
        });
      }
    }
    i = j;
  }
  out.cancelled = cancelled;
  return out;
}

/** 일정에 들어간 Compass 학생 찾기 (제목 우선, 긴 이름 우선). 같은 이름 학생이 여럿이면 연결하지 않음 */
function matchStudent(ev, students) {
  const byName = {};
  students.forEach((s) => { const n = String(s.name || '').trim(); if (n.length >= 2) (byName[n] = byName[n] || []).push(s); });
  const names = Object.keys(byName).sort((a, b) => b.length - a.length);
  for (const text of [ev.title, ev.detail]) {
    const n = names.find((x) => text.indexOf(x) >= 0);
    if (n) return byName[n].length === 1 ? byName[n][0] : null;
  }
  return null;
}

module.exports = { parseSheet, matchStudent, tabName, toHome, isGray, ZONES };
