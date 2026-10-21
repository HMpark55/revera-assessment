'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseSheet, matchStudent, tabName } = require('../lib/schedule');

// 원장님 시트와 같은 모양 (이름은 예시)
const SLOTS = [];
for (let k = 0; k < 32; k++) {
  const m = 8 * 60 + k * 30, h = (x) => { const hh = Math.floor(x / 60) % 12 || 12; return (hh < 10 ? '0' : '') + hh + ':' + (x % 60 ? '30' : '00'); };
  SLOTS.push(h(m) + ' - ' + h(m + 30));
}
function week(dates, cells) {
  const rows = [['', ...dates, 'Weekly Total', '', '', ''], ['Daily Total', 0, 0, 0, 0, 0, 0, 0, 0]];
  SLOTS.forEach((label) => rows.push([label, '', '', '', '', '', '', '', '', '', '', '']));
  Object.keys(cells).forEach((at) => {
    const [col, slot] = at.split('@');
    const idx = SLOTS.findIndex((x) => x.startsWith(slot)) + (/^p/.test(col) ? 0 : 0);
    rows[2 + idx + (col.endsWith('pm') ? 0 : 0)][Number(col.replace(/\D/g, ''))] = cells[at];
  });
  return rows;
}
function at(rows, dayCol, slotIndex, v) { rows[2 + slotIndex][dayCol] = v; }
const slotOf = (h, m) => (h * 60 + m - 8 * 60) / 30;

test('원장님 시트 읽기: 일정 묶음, 오전·오후, 시작 시각 메모, 출장(미국·한국) 시차, 학생 연결', () => {
  const w1 = week(['10/12/2026', '10/13/2026', '10/14/2026', '10/15/2026', '10/16/2026', '10/17/2026', '10/18/2026'], {});
  at(w1, 2, slotOf(17, 30), '홍가람 학생'); at(w1, 2, slotOf(18, 0), 'ZOOM 미팅');
  at(w1, 3, slotOf(17, 30), '=>5:20시작');
  at(w1, 5, slotOf(17, 0), '민나래 학생'); at(w1, 5, slotOf(17, 30), '민나래 학생'); at(w1, 5, slotOf(18, 0), '미팅');
  at(w1, 5, slotOf(18, 30), '김다온 학생'); at(w1, 5, slotOf(19, 0), 'ZOOM 미팅');
  at(w1, 6, slotOf(11, 0), '윤바다 덜위치 Y12'); at(w1, 6, slotOf(11, 30), '1:1 유료 상담');
  at(w1, 6, slotOf(14, 0), '김하늘 부모님 미팅'); at(w1, 6, slotOf(14, 30), '(HKU, NUS 전공 상의)');
  const w2 = week(['10/19/2026', '10/20/2026', '10/21/2026', '10/22/2026', '10/23/2026', '10/24/2026', '10/25/2026'], {});
  at(w2, 1, 0, '미국'); at(w2, 1, slotOf(18, 0), '홍가람 학생'); at(w2, 1, slotOf(18, 30), '미팅'); // LA 10/19 18:00 = 상해 10/20 09:00 (서머타임)
  at(w2, 2, 0, '한국'); at(w2, 2, slotOf(15, 0), '김하늘 학생'); // 한국 15:00 = 상해 14:00
  const w3 = week(['11/2/2026', '11/3/2026', '11/4/2026', '11/5/2026', '11/6/2026', '11/7/2026', '11/8/2026'], {});
  at(w3, 1, 0, '미국'); at(w3, 1, slotOf(18, 0), '민나래 학생'); // 서머타임 끝 → 상해 다음날 10:00
  const evs = parseSheet([['', 'Mon', 'Tue'], ...w1, [''], ...w2, [''], ...w3], tabName(2026, 10));
  const by = (t, d) => evs.find((e) => e.title === t && e.date === d);
  assert.strictEqual(tabName(2026, 10), '10 Oct 2026');
  let e = by('홍가람 학생', '2026-10-13');
  assert.strictEqual(e.startAt, '2026-10-13T17:20', '=>5:20시작 메모 반영');
  assert.strictEqual(e.detail, 'ZOOM 미팅');
  assert.strictEqual(by('민나래 학생', '2026-10-16').endAt, '2026-10-16T18:30', '같은 이름이 이어지면 한 일정');
  assert.strictEqual(by('김다온 학생', '2026-10-16').startAt, '2026-10-16T18:30', '바로 이어진 다른 학생은 새 일정');
  assert.strictEqual(by('윤바다 덜위치 Y12', '2026-10-17').startAt, '2026-10-17T11:00');
  assert.strictEqual(by('김하늘 부모님 미팅', '2026-10-17').detail, '(HKU, NUS 전공 상의)');
  e = by('홍가람 학생', '2026-10-19');
  assert.strictEqual(e.startAt, '2026-10-20T09:00', '미국(LA, 서머타임) → 상해');
  assert.strictEqual(e.sheetLabel, '10/19 18:00 미국 시간');
  assert.ok(!evs.some((x) => x.title === '미국' || x.title === '한국'), '출장 표시는 일정이 아님');
  assert.strictEqual(by('김하늘 학생', '2026-10-20').startAt, '2026-10-20T14:00', '한국 → 상해 1시간 빠름');
  assert.strictEqual(by('민나래 학생', '2026-11-02').startAt, '2026-11-03T10:00', '서머타임 끝난 뒤 LA → 상해 16시간');
  assert.ok(!evs.some((x) => /^=>/.test(x.title)));

  // 학생 연결: Compass 학생 이름이 들어간 것만, 같은 이름이 둘이면 연결 안 함
  const st = [{ id: 'a', name: '홍가람' }, { id: 'b', name: '김하늘' }, { id: 'c', name: '민나래' }, { id: 'd', name: '민나래' }];
  assert.strictEqual(matchStudent(by('홍가람 학생', '2026-10-13'), st).id, 'a');
  assert.strictEqual(matchStudent(by('김하늘 부모님 미팅', '2026-10-17'), st).id, 'b');
  assert.strictEqual(matchStudent(by('윤바다 덜위치 Y12', '2026-10-17'), st), null, '우리 학생이 아니면 null');
  assert.strictEqual(matchStudent(by('민나래 학생', '2026-10-16'), st), null, '같은 이름 학생이 둘이면 연결하지 않음');
});
