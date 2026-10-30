'use strict';
/**
 * 원서용 학생 정보 엑셀 — 학생 한 명 = 시트 한 장 (A4 세로로 인쇄되게 8칸)
 *   parts: info(학생 정보) passport(여권 번호) parents(학부모) schools(학력) semesters(학기별 재학)
 *          grades(과목·시험 성적) recs(추천인·카운슬러) accounts(사이트 계정 ID·PW) apps(지원 대학)
 */
const PARTS = ['info', 'passport', 'parents', 'schools', 'semesters', 'grades', 'recs', 'accounts', 'apps'];
const COLS = [15, 13, 13, 12, 13, 13, 12, 15];
const REC_ITEM = /^(추천인|카운슬러|카운셀러|counselor)/i;

const dot = (d) => (/^\d{4}-\d{2}-\d{2}/.test(d || '') ? d.slice(0, 10).replace(/-/g, '.') : d || '');
/** 학기 실제 재학 일수: 시작일·종료일 포함 */
function termDays(a, b) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b || '') || b < a) return null;
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;
}
/** 두 날짜 사이 n년 n개월 (끝 날짜 포함) */
function ymSpan(a, b) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b || '') || b < a) return '';
  const [y1, m1, d1] = a.split('-').map(Number), e = new Date(Date.UTC(...b.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))) + 86400000);
  let months = (e.getUTCFullYear() - y1) * 12 + (e.getUTCMonth() + 1 - m1) - (e.getUTCDate() < d1 ? 1 : 0);
  if (months < 0) months = 0;
  return Math.floor(months / 12) + '년 ' + (months % 12) + '개월';
}
const parseJson = (v) => { try { const o = JSON.parse(v || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } };

function buildStudentSheet(d, parts, today) {
  const on = (k) => parts.includes(k), s = d.student;
  const rows = [];
  const blank = (h) => rows.push({ h: h || 8, cells: [] });
  const sec = (t) => { blank(10); rows.push({ h: 22, cells: [{ v: '■ ' + t, s: 'sec', span: 8 }] }); };
  const kv = (l, v) => rows.push({ cells: [{ v: l, s: 'label', span: 2 }, { v: v || '', s: 'value', span: 6 }] });
  const th = (list) => rows.push({ cells: list.map(([v, span]) => ({ v, s: 'th', span })) });
  const td = (list) => rows.push({ cells: list.map(([v, span, c]) => ({ v: v == null ? '' : v, s: c ? 'tdc' : 'td', span })) });
  const empty = (msg) => rows.push({ cells: [{ v: msg, s: 'td', span: 8 }] });

  rows.push({ h: 30, cells: [{ v: s.name + ' — 원서용 학생 정보', s: 'title', span: 6 }, { v: '작성 ' + dot(today) + ' · REVERA Compass', s: 'sub', span: 2 }] });

  if (on('info') || on('passport')) {
    sec('학생 정보');
    if (on('info')) {
      kv('이름', s.name); kv('영문 이름 (여권 동일)', s.englishName); kv('생년월일', dot(s.dob));
      kv('학교 · 학년', [s.school, s.grade, s.curriculum].filter(Boolean).join(' · '));
      kv('이메일', s.email); kv('연락처', s.studentPhone); kv('주소', s.address); kv('영문 주소', s.addressEn);
    }
    if (on('passport')) kv('여권 번호', s.passportNo);
  }
  if (on('parents')) {
    sec('학부모 정보');
    th([['', 2], ['아버님', 3], ['어머님', 3]]);
    [['이름', 'Name'], ['영문명', 'NameEn'], ['연락처', 'Phone'], ['이메일', 'Email'], ['위챗', 'Wechat'], ['근무 기간', 'Work']].forEach(([l, k]) =>
      rows.push({ cells: [{ v: l, s: 'label', span: 2 }, { v: s['father' + k] || '', s: 'value', span: 3 }, { v: s['mother' + k] || '', s: 'value', span: 3 }] }));
  }
  if (on('schools')) {
    sec('학력');
    th([['학교명', 2], ['학교 정보', 3], ['재학 기간', 3]]);
    const list = d.schools.slice().sort((a, b) => String(a.startDate || '9').localeCompare(String(b.startDate || '9')));
    if (!list.length && s.school) list.push({ school: s.school });
    if (!list.length) empty('입력된 학력이 없습니다.');
    list.forEach((r) => {
      const o = d.schoolOpts[r.school] || {}, info = parseJson(o.info);
      const name = [r.school, o.fullName && o.fullName !== r.school ? o.fullName : ''].filter(Boolean).join('\n');
      const where = [r.country || o.country, r.city || o.city].filter(Boolean).join(' · ');
      const lines = [where && '소재: ' + where, info.system && '학년제/학기제: ' + info.system, info.address && '주소: ' + info.address,
        info.homepage && '홈페이지: ' + info.homepage, info.email && '대표 이메일: ' + info.email, info.phone && '전화: ' + info.phone].filter(Boolean);
      const range = [[r.gradeFrom, r.termFrom].filter(Boolean).join(' '), [r.gradeTo, r.termTo].filter(Boolean).join(' ')].filter(Boolean).join(' ~ ');
      const end = r.endDate || '';
      const period = [(r.startDate || end) ? dot(r.startDate) + ' – ' + (end ? dot(end) : '재학 중') : '', range, ymSpan(r.startDate, end || today) && '(' + ymSpan(r.startDate, end || today) + (end ? '' : ', 오늘까지') + ')', r.memo].filter(Boolean).join('\n');
      td([[name, 2], [lines.join('\n'), 3], [period, 3]]);
    });
  }
  if (on('semesters')) {
    sec('학기별 재학 (실제 재학일 = 학기 시작일~종료일, 양 끝 포함)');
    th([['학교', 2], ['학년', 1], ['학기', 1], ['학기 시작일', 1], ['학기 종료일', 1], ['실제 재학일', 1], ['메모', 1]]);
    const list = d.semesters.slice().sort((a, b) => String(a.startDate || '9').localeCompare(String(b.startDate || '9')) || String(a.grade).localeCompare(String(b.grade), 'ko', { numeric: true }) || String(a.term).localeCompare(String(b.term)));
    let total = 0;
    if (!list.length) empty('입력된 학기가 없습니다. (Compass 학생 화면 › 성적·학력 › 학기별 재학)');
    list.forEach((r) => {
      const n = termDays(r.startDate, r.endDate); if (n) total += n;
      td([[r.school, 2], [r.grade, 1, 1], [r.term ? r.term + '학기' : '', 1, 1], [dot(r.startDate), 1, 1], [dot(r.endDate), 1, 1], [n ? n + '일' : '', 1, 1], [r.memo, 1]]);
    });
    if (list.length) rows.push({ cells: [{ v: '합계', s: 'total', span: 6 }, { v: total + '일', s: 'total' }, { v: '', s: 'total' }] });
  }
  if (on('grades')) {
    sec('성적');
    const cs = d.courses.slice().sort((a, b) => String(a.schoolYear || a.grade).localeCompare(String(b.schoolYear || b.grade), 'ko', { numeric: true }) || String(a.subject).localeCompare(String(b.subject)));
    th([['학년도', 1], ['학년', 1], ['과목', 2], ['레벨', 1], ['1학기 / T1', 1], ['2학기 / T2', 1], ['최종', 1]]);
    if (!cs.length) empty('입력된 과목 성적이 없습니다.');
    cs.forEach((c) => td([[c.schoolYear, 1, 1], [c.grade, 1, 1], [c.subject, 2], [c.level, 1, 1], [c.g1, 1, 1], [[c.g2, c.g3 && 'T3 ' + c.g3].filter(Boolean).join(' / '), 1, 1], [c.final, 1, 1]]));
    blank(6);
    const sc = d.scores.slice().sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || String(b.date || '').localeCompare(String(a.date || '')));
    th([['시험', 1], ['과목 · 구분', 2], ['점수', 1], ['세부 점수', 2], ['응시일', 1], ['메모', 1]]);
    if (!sc.length) empty('입력된 시험 점수가 없습니다.');
    sc.forEach((r) => td([[r.kind, 1, 1], [[r.subject, r.level].filter(Boolean).join(' '), 2], [r.score, 1, 1], [r.detail, 2], [dot(r.date), 1, 1], [r.memo, 1]]));
  }
  if (on('recs')) {
    sec('추천인 · 카운슬러');
    th([['구분', 1], ['이름', 2], ['직책', 1], ['과목', 1], ['공식 이메일', 3]]);
    const list = d.appinfo.filter((r) => REC_ITEM.test(r.item || '')).sort((a, b) => String(a.item).localeCompare(String(b.item), 'ko', { numeric: true }));
    if (!list.length) empty('입력된 추천인·카운슬러가 없습니다.');
    list.forEach((r) => {
      if (r.recName || r.recTitle || r.recSubject || r.recEmail) td([[r.item, 1, 1], [r.recName, 2], [r.recTitle, 1], [r.recSubject, 1], [r.recEmail, 3]]);
      else td([[r.item, 1, 1], [r.content, 7]]); // 칸을 나누기 전에 글로 적어둔 것
    });
  }
  if (on('accounts')) {
    sec('사이트 계정');
    th([['분류', 1], ['사이트', 2], ['ID', 2], ['PW', 2], ['메모', 1]]);
    const list = d.accounts.slice().sort((a, b) => String(a.category).localeCompare(String(b.category)) || String(a.site).localeCompare(String(b.site)));
    if (!list.length) empty('입력된 계정이 없습니다.');
    list.forEach((a) => td([[a.category, 1, 1], [[a.site, a.url].filter(Boolean).join('\n'), 2], [a.loginId, 2], [a.password, 2], [a.memo, 1]]));
  }
  if (on('apps')) {
    sec('지원 대학');
    th([['대학', 2], ['전형', 1], ['전공', 3], ['마감', 1], ['상태', 1]]);
    const list = d.apps.slice().sort((a, b) => String(a.deadline || '9').localeCompare(String(b.deadline || '9')));
    if (!list.length) empty('입력된 지원 대학이 없습니다.');
    list.forEach((a) => td([[a.university, 2], [a.round, 1, 1], [a.major, 3], [dot(a.deadline), 1, 1], [a.status, 1, 1]]));
  }
  blank(12);
  rows.push({ h: 30, cells: [{ v: '개인정보(연락처' + (on('passport') ? '·여권 번호' : '') + (on('accounts') ? '·계정 비밀번호' : '') + ')가 들어 있는 파일입니다. 필요한 사람에게만 전달하고, 다 쓴 뒤에는 지워주세요.', s: 'note', span: 8 }] });
  return { name: s.name, cols: COLS, rows };
}

module.exports = { buildStudentSheet, termDays, ymSpan, PARTS };
