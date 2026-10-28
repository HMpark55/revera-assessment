'use strict';
/**
 * REVERA A (학원 관리) — Compass와 같은 DB·로그인을 쓰는 별도 화면
 *   상담 Roster: 학생(학년·학교별) + 상담 기록 + 행사별 팔로업 답변
 *   수업 Roster: 수업(반·특강·개인) + 수강생(수강료 결제 내역·Remark) + 날짜별 출결 / 개인수업 기록
 *   가져오기: 구글 시트(상담·수업 Roster)를 바꾼 atlas-import-v1 파일
 * 아직 공개 전이라 허용된 계정만 들어올 수 있음 (ATLAS_NAMES / 환경변수 ATLAS_EMAILS)
 */
const crypto = require('crypto');

const ATLAS_NAMES = ['박현모'];
const GROUPS = ['한학', '북경', '중국 문의', '기타'];
const CLASS_KINDS = ['정규반', '특강', '개인', '그룹', '유료 상담'];

/* 표 → 저장할 수 있는 칸 (id·만든/고친 시각은 자동) */
const TABLES = {
  atlas_students: ['name', 'phone', 'school', 'schoolNote', 'gradYear', 'grp', 'tag', 'payment', 'subjMid', 'subjHigh', 'memo'],
  atlas_consults: ['studentId', 'date', 'program', 'content'],
  atlas_fu: ['studentId', 'campaign', 'response'],
  atlas_classes: ['name', 'kind', 'term', 'teacher', 'schedule', 'status', 'memo', 'dates', 'rate'], // dates: 출결 날짜 칸 이름(JSON 배열), rate: 시간당 수강료
  atlas_enroll: ['classId', 'studentId', 'payment', 'remark', 'note', 'extra'], // note: 이름 칸 메모(10회권 등), extra: 유료 상담 칸들(JSON)
  atlas_attend: ['classId', 'studentId', 'col', 'value'], // 정규반·특강 출결 (학생 × 날짜 칸)
  atlas_lessons: ['classId', 'sortOrder', 'date', 'mode', 'time', 'status', 'fee', 'kst', 'feedback'], // 개인·그룹 수업 기록 (시트 줄 그대로)
};
const PREVIEW = 300; // 화면 전체를 불러올 때 긴 글은 앞부분만 (눌러서 열 때 전체)
const META = ['createdAt', 'createdBy', 'updatedAt', 'updatedBy'];

class AtlasError extends Error { constructor(msg, status) { super(msg); this.status = status || 400; } }

function attachAtlas(db) {
  for (const [t, cols] of Object.entries(TABLES)) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY)`);
    const have = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    cols.concat(META, t === 'atlas_students' || t === 'atlas_classes' ? ['deletedAt'] : []).forEach((c) => {
      if (!have.has(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} TEXT DEFAULT ''`);
    });
  }

  const extra = String(process.env.ATLAS_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const allowed = (me) => !!me && !me.mustChangePassword && (ATLAS_NAMES.includes(String(me.name || '').trim()) || extra.includes(me.email));

  const get = (t, id) => db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(String(id || ''));
  const ts = () => new Date().toISOString();
  const clean = (v, max) => String(v == null ? '' : v).slice(0, max || 20000);
  ['atlas_attend:classId', 'atlas_lessons:classId', 'atlas_enroll:classId', 'atlas_consults:studentId', 'atlas_fu:studentId'].forEach((x) => {
    const [t, c] = x.split(':'); db.exec(`CREATE INDEX IF NOT EXISTS ix_${t}_${c} ON ${t}(${c})`);
  });
  /** 긴 글은 앞부분만 + _cut 에 잘린 칸 이름 */
  const preview = (rows, cols) => rows.map((r) => {
    const cut = cols.filter((c) => String(r[c] || '').length > PREVIEW);
    if (!cut.length) return r;
    const o = Object.assign({}, r, { _cut: cut });
    cut.forEach((c) => { o[c] = String(r[c]).slice(0, PREVIEW); });
    return o;
  });

  function getAll() {
    const all = (t, where) => db.prepare(`SELECT * FROM ${t}${where ? ' WHERE ' + where : ''}`).all();
    return {
      students: preview(all('atlas_students', "deletedAt = ''"), ['payment', 'memo', 'schoolNote', 'phone', 'subjMid', 'subjHigh', 'tag']),
      consults: preview(all('atlas_consults'), ['content']),
      fu: preview(all('atlas_fu'), ['response']),
      classes: all('atlas_classes', "deletedAt = ''"),
      enroll: preview(all('atlas_enroll'), ['payment', 'remark', 'note']),
      attend: all('atlas_attend').map((a) => ({ id: a.id, classId: a.classId, studentId: a.studentId, col: a.col, value: a.value })),
      groups: GROUPS, classKinds: CLASS_KINDS,
    };
  }
  /** 한 줄 전체 (앞부분만 받은 긴 칸을 열 때) */
  function getRow(me, arg) {
    const t = arg && arg.table;
    if (!TABLES[t]) throw new AtlasError('없는 표입니다.');
    const r = get(t, arg.id); if (!r || r.deletedAt) throw new AtlasError('이미 삭제되었습니다.', 404);
    return r;
  }
  const getConsults = (me, arg) => db.prepare('SELECT * FROM atlas_consults WHERE studentId = ?').all(String(arg && arg.studentId || ''));
  const getLessons = (me, arg) => db.prepare('SELECT * FROM atlas_lessons WHERE classId = ? ORDER BY CAST(sortOrder AS REAL), createdAt').all(String(arg && arg.classId || ''));

  /** 저장: id 가 있으면 보낸 칸만 고침(같은 줄을 여럿이 고쳐도 다른 칸은 안 덮어씀), 없으면 새로 만듦 */
  function save(me, arg) {
    const t = arg && arg.table, rec = (arg && arg.rec) || {};
    if (!TABLES[t]) throw new AtlasError('없는 표입니다.');
    const cols = TABLES[t].filter((c) => Object.prototype.hasOwnProperty.call(rec, c));
    const v = {}; cols.forEach((c) => { v[c] = clean(rec[c], c === 'content' || c === 'remark' || c === 'feedback' ? 100000 : 20000).trim(); });
    if (t === 'atlas_classes' && v.dates !== undefined) {
      let d; try { d = JSON.parse(v.dates || '[]'); } catch (e) { d = null; }
      if (!Array.isArray(d) || d.some((x) => typeof x !== 'string')) throw new AtlasError('날짜 칸이 올바르지 않습니다.');
    }
    if (t === 'atlas_enroll' && v.extra) { try { JSON.parse(v.extra); } catch (e) { throw new AtlasError('칸 값이 올바르지 않습니다.'); } }
    if (t === 'atlas_students' && 'name' in v && !v.name) throw new AtlasError('학생 이름을 입력하세요.');
    if (t === 'atlas_classes' && 'name' in v && !v.name) throw new AtlasError('수업 이름을 입력하세요.');
    if (t === 'atlas_students' && v.gradYear && !/^\d{4}$/.test(v.gradYear)) throw new AtlasError('학년이 올바르지 않습니다.');
    if (t === 'atlas_students' && v.grp && !GROUPS.includes(v.grp)) throw new AtlasError('구분이 올바르지 않습니다.');
    if (t === 'atlas_classes' && v.kind && !CLASS_KINDS.includes(v.kind)) throw new AtlasError('수업 종류가 올바르지 않습니다.');
    if (t === 'atlas_fu' && 'campaign' in v && !v.campaign) throw new AtlasError('팔로업 이름을 입력하세요.');
    if (v.studentId !== undefined && !get('atlas_students', v.studentId)) throw new AtlasError('학생을 찾을 수 없습니다.', 404);
    if (v.classId !== undefined && !get('atlas_classes', v.classId)) throw new AtlasError('수업을 찾을 수 없습니다.', 404);
    const at = ts();
    if (rec.id) {
      const cur = get(t, rec.id);
      if (!cur || cur.deletedAt) throw new AtlasError('이미 삭제되었습니다.', 404);
      const sets = cols.map((c) => c + ' = @' + c).concat(['updatedAt = @updatedAt', 'updatedBy = @updatedBy']);
      db.prepare(`UPDATE ${t} SET ${sets.join(', ')} WHERE id = @id`).run(Object.assign({}, v, { id: cur.id, updatedAt: at, updatedBy: me.email }));
      return get(t, cur.id);
    }
    if (t === 'atlas_students' && !v.name) throw new AtlasError('학생 이름을 입력하세요.');
    if (t === 'atlas_classes' && !v.name) throw new AtlasError('수업 이름을 입력하세요.');
    if ((t === 'atlas_consults' || t === 'atlas_fu') && !v.studentId) throw new AtlasError('학생을 고르세요.');
    if (t === 'atlas_lessons' && !v.classId) throw new AtlasError('수업을 고르세요.');
    if (t === 'atlas_attend') { // 학생 × 날짜 = 1칸, 비우면 지움
      if (!v.classId || !v.studentId || !v.col) throw new AtlasError('출결 칸이 올바르지 않습니다.');
      const cur = db.prepare('SELECT id FROM atlas_attend WHERE classId = ? AND studentId = ? AND col = ?').get(v.classId, v.studentId, v.col);
      if (cur && !v.value) { db.prepare('DELETE FROM atlas_attend WHERE id = ?').run(cur.id); return { id: cur.id, removed: true }; }
      if (cur) return save(me, { table: t, rec: { id: cur.id, value: v.value } });
      if (!v.value) return { removed: true };
    }
    if (t === 'atlas_enroll') {
      if (!v.classId || !v.studentId) throw new AtlasError('수업과 학생을 고르세요.');
      if (db.prepare('SELECT 1 FROM atlas_enroll WHERE classId = ? AND studentId = ?').get(v.classId, v.studentId)) throw new AtlasError('이미 이 수업에 등록된 학생입니다.');
    }
    if (t === 'atlas_fu') { // 학생 1명 · 팔로업 1개 = 답변 1칸
      const cur = db.prepare('SELECT id FROM atlas_fu WHERE studentId = ? AND campaign = ?').get(v.studentId, v.campaign);
      if (cur) return save(me, { table: t, rec: { id: cur.id, response: v.response || '' } });
    }
    const row = Object.assign({}, v, { id: crypto.randomUUID(), createdAt: at, createdBy: me.email, updatedAt: at, updatedBy: me.email });
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${t} (${keys.join(', ')}) VALUES (${keys.map((k) => '@' + k).join(', ')})`).run(row);
    return get(t, row.id);
  }

  /** 삭제: 학생·수업은 숨김(나중에 되살릴 수 있게), 상담 기록·팔로업·수강 등록은 바로 지움 */
  function remove(me, arg) {
    const t = arg && arg.table;
    if (!TABLES[t]) throw new AtlasError('없는 표입니다.');
    const cur = get(t, arg.id);
    if (!cur) throw new AtlasError('이미 삭제되었습니다.', 404);
    if (t === 'atlas_students' || t === 'atlas_classes') db.prepare(`UPDATE ${t} SET deletedAt = ?, updatedBy = ? WHERE id = ?`).run(ts(), me.email, cur.id);
    else db.prepare(`DELETE FROM ${t} WHERE id = ?`).run(cur.id);
    return { ok: true };
  }

  /** 팔로업 이름 바꾸기 (그 팔로업의 답변 전체) */
  function renameCampaign(me, arg) {
    const from = clean(arg && arg.from).trim(), to = clean(arg && arg.to).trim();
    if (!from || !to) throw new AtlasError('팔로업 이름을 입력하세요.');
    if (from !== to && db.prepare('SELECT 1 FROM atlas_fu WHERE campaign = ?').get(to)) throw new AtlasError('같은 이름의 팔로업이 이미 있습니다.');
    db.prepare('UPDATE atlas_fu SET campaign = ?, updatedAt = ?, updatedBy = ? WHERE campaign = ?').run(to, ts(), me.email, from);
    return { ok: true };
  }

  /**
   * 가져오기 (atlas-import-v1): 같은 학생(이름+학교, 학교를 모르면 이름이 하나뿐일 때)은 빈 칸만 채움,
   * 같은 상담 글은 다시 넣지 않음, 같은 이름·기간의 수업이 이미 있으면 그 수업은 건너뜀. dryRun 이면 세기만.
   */
  function importData(me, arg) {
    const data = arg && arg.data;
    if (!data || data.format !== 'atlas-import-v1' || !Array.isArray(data.students) || !Array.isArray(data.classes)) throw new AtlasError('REVERA A 가져오기 파일이 아닙니다.');
    const n = { newStudents: 0, matched: 0, consults: 0, fu: 0, classes: 0, skippedClasses: [], enroll: 0, attend: 0, lessons: 0 };
    const norm = (x) => String(x || '').replace(/\s+/g, '').toLowerCase();
    const run = () => {
      const at = ts(), mk = (t, row) => {
        const r = Object.assign({}, row, { id: crypto.randomUUID(), createdAt: at, createdBy: me.email, updatedAt: at, updatedBy: me.email });
        if (!arg.dryRun) { const k = Object.keys(r); db.prepare(`INSERT INTO ${t} (${k.join(', ')}) VALUES (${k.map((x) => '@' + x).join(', ')})`).run(r); }
        return r;
      };
      const existing = db.prepare("SELECT * FROM atlas_students WHERE deletedAt = ''").all();
      const idOf = {};
      const SF = TABLES.atlas_students;
      for (const s of data.students) {
        const name = clean(s.name, 200).trim(); if (!name || !s.key) continue;
        const same = existing.filter((x) => norm(x.name) === norm(name));
        let cur = same.find((x) => norm(x.school) && norm(x.school) === norm(s.school)) || (same.length === 1 && (!norm(same[0].school) || !norm(s.school)) ? same[0] : null);
        if (cur) {
          n.matched++;
          const fill = SF.filter((c) => c !== 'name' && s[c] && !cur[c]);
          if (fill.length && !arg.dryRun) db.prepare(`UPDATE atlas_students SET ${fill.map((c) => c + ' = @' + c).join(', ')}, updatedAt = @at, updatedBy = @by WHERE id = @id`)
            .run(Object.assign({ id: cur.id, at, by: me.email }, Object.fromEntries(fill.map((c) => [c, clean(s[c])]))));
        } else {
          n.newStudents++;
          const row = { deletedAt: '' }; SF.forEach((c) => { row[c] = clean(s[c]).trim(); }); row.name = name;
          if (row.gradYear && !/^\d{4}$/.test(row.gradYear)) row.gradYear = '';
          if (row.grp && !GROUPS.includes(row.grp)) row.grp = '';
          cur = mk('atlas_students', row); existing.push(cur);
        }
        idOf[s.key] = cur.id;
        const have = new Set(cur.createdAt === at ? [] : db.prepare('SELECT content FROM atlas_consults WHERE studentId = ?').all(cur.id).map((c) => c.content));
        for (const c of s.consults || []) {
          const content = clean(c.content, 100000).trim(); if (!content || have.has(content)) continue;
          have.add(content); n.consults++;
          mk('atlas_consults', { studentId: cur.id, date: clean(c.date, 20), program: clean(c.program, 200), content });
        }
        for (const f of s.fu || []) { // 행사별 팔로업 체크: 이미 있으면 그대로
          const campaign = clean(f.campaign, 300).trim(); if (!campaign) continue;
          if (cur.createdAt !== at && db.prepare('SELECT 1 FROM atlas_fu WHERE studentId = ? AND campaign = ?').get(cur.id, campaign)) continue;
          n.fu++; mk('atlas_fu', { studentId: cur.id, campaign, response: clean(f.response, 20000) });
        }
      }
      for (const c of data.classes) {
        const name = clean(c.name, 300).trim(); if (!name) continue;
        if (db.prepare("SELECT 1 FROM atlas_classes WHERE name = ? AND term = ? AND deletedAt = ''").get(name, clean(c.term, 200))) { n.skippedClasses.push(name); continue; }
        n.classes++;
        const dates = (Array.isArray(c.dates) ? c.dates : []).map((d) => clean(d, 40));
        const k = mk('atlas_classes', { name, kind: CLASS_KINDS.includes(c.kind) ? c.kind : '', term: clean(c.term, 200), teacher: clean(c.teacher, 200), schedule: clean(c.schedule, 500),
          status: c.status === '완료' ? '완료' : '', memo: clean(c.memo), dates: JSON.stringify(dates), rate: clean(c.rate, 200), deletedAt: '' });
        const seen = new Set();
        for (const e of c.enroll || []) {
          const sid = idOf[e.studentKey]; if (!sid || seen.has(sid)) continue;
          seen.add(sid); n.enroll++;
          mk('atlas_enroll', { classId: k.id, studentId: sid, payment: clean(e.payment, 100000), remark: clean(e.remark, 100000), note: clean(e.note), extra: e.extra ? JSON.stringify(e.extra) : '' });
          for (const [col, val] of Object.entries(e.attend || {})) {
            if (!dates.includes(col) || !String(val).trim()) continue;
            n.attend++; mk('atlas_attend', { classId: k.id, studentId: sid, col, value: clean(val, 500) });
          }
        }
        (c.lessons || []).forEach((l, i) => {
          n.lessons++;
          mk('atlas_lessons', { classId: k.id, sortOrder: String(i + 1), date: clean(l.date, 200), mode: clean(l.mode, 200), time: clean(l.time, 500), status: clean(l.status), fee: clean(l.fee), kst: clean(l.kst, 500), feedback: clean(l.feedback, 100000) });
        });
      }
    };
    if (arg.dryRun) run(); else db.transaction(run)();
    n.skippedClasses = n.skippedClasses.slice(0, 50);
    return n;
  }

  return { allowed, rpc: { ping: () => ({ ok: true }), getAll, getRow, getConsults, getLessons, save, remove, renameCampaign, importData }, AtlasError };
}

module.exports = { attachAtlas, AtlasError };
