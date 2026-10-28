'use strict';
/**
 * REVERA A (학원 관리) — Compass와 같은 DB·로그인을 쓰는 별도 화면
 *   상담 Roster: 학생(학년·학교별) + 상담 기록 + 행사별 팔로업 답변
 *   수업 Roster: 수업(반·특강·개인) + 수강생(수강료 결제 내역·Remark)
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
  atlas_classes: ['name', 'kind', 'term', 'teacher', 'schedule', 'status', 'memo'],
  atlas_enroll: ['classId', 'studentId', 'payment', 'remark'],
};
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
  const clean = (v, max) => String(v == null ? '' : v).slice(0, max || 4000);

  function getAll() {
    const all = (t, where) => db.prepare(`SELECT * FROM ${t}${where ? ' WHERE ' + where : ''}`).all();
    return {
      students: all('atlas_students', "deletedAt = ''"),
      consults: all('atlas_consults'),
      fu: all('atlas_fu'),
      classes: all('atlas_classes', "deletedAt = ''"),
      enroll: all('atlas_enroll'),
      groups: GROUPS, classKinds: CLASS_KINDS,
    };
  }

  /** 저장: id 가 있으면 보낸 칸만 고침(같은 줄을 여럿이 고쳐도 다른 칸은 안 덮어씀), 없으면 새로 만듦 */
  function save(me, arg) {
    const t = arg && arg.table, rec = (arg && arg.rec) || {};
    if (!TABLES[t]) throw new AtlasError('없는 표입니다.');
    const cols = TABLES[t].filter((c) => Object.prototype.hasOwnProperty.call(rec, c));
    const v = {}; cols.forEach((c) => { v[c] = clean(rec[c], c === 'content' || c === 'memo' ? 20000 : 4000).trim(); });
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

  return { allowed, rpc: { ping: () => ({ ok: true }), getAll, save, remove, renameCampaign }, AtlasError };
}

module.exports = { attachAtlas, AtlasError };
