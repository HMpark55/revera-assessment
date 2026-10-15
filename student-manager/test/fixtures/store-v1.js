'use strict';
/**
 * 데이터 저장소 (SQLite 파일 1개) + 업무 규칙.
 * 모든 함수는 (me, 입력값) 을 받고, 화면에 필요한 전체 데이터(getAll)를 돌려줍니다.
 */
const Database = require('better-sqlite3');
const crypto = require('crypto');

class UserError extends Error {
  constructor(message, status) { super(message); this.status = status || 400; }
}

const STUDENT_FIELDS = ['name', 'dob', 'school', 'grade', 'curriculum', 'counselor', 'status', 'studentPhone',
  'parentName', 'parentPhone', 'email', 'tags', 'memo'];
const NOTE_FIELDS = ['studentId', 'date', 'type', 'content', 'nextAction', 'nextDue', 'done'];
const APP_FIELDS = ['studentId', 'university', 'major', 'round', 'deadline', 'status', 'essay', 'memo'];
const TABLE_LABEL = { students: '학생', notes: '상담기록', apps: '지원대학', teachers: '선생님' };

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS teachers (
  email TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'teacher',
  active INTEGER NOT NULL DEFAULT 1, passwordHash TEXT NOT NULL, mustChangePassword INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  tokenHash TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES teachers(email) ON DELETE CASCADE,
  createdAt TEXT NOT NULL, expiresAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY, ${STUDENT_FIELDS.map((f) => f + " TEXT NOT NULL DEFAULT ''").join(', ')},
  createdAt TEXT NOT NULL, createdBy TEXT NOT NULL, updatedAt TEXT NOT NULL, updatedBy TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, studentId TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  ${NOTE_FIELDS.slice(1).map((f) => f + " TEXT NOT NULL DEFAULT ''").join(', ')},
  author TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, updatedBy TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY, studentId TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  ${APP_FIELDS.slice(1).map((f) => f + " TEXT NOT NULL DEFAULT ''").join(', ')},
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, updatedBy TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, email TEXT NOT NULL, action TEXT NOT NULL,
  tbl TEXT NOT NULL, targetId TEXT NOT NULL, summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_student ON notes(studentId);
CREATE INDEX IF NOT EXISTS apps_student ON apps(studentId);
`;

const SESSION_DAYS = 14;

/* ---------------- 유틸 ---------------- */

let lastNow = '';
/** 한국 시간 ISO 문자열(밀리초). 같은 밀리초에 두 번 저장돼도 값이 겹치지 않게 보정 */
function now() {
  let ms = Date.now();
  let s;
  do {
    s = new Date(ms + 9 * 3600000).toISOString().replace('Z', '');
    ms++;
  } while (s <= lastNow);
  lastNow = s;
  return s;
}
const newId = () => crypto.randomBytes(6).toString('hex');
const lower = (s) => String(s || '').trim().toLowerCase();
const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
function clean(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v).replace(/\r\n/g, '\n').slice(0, 20000);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return 'scrypt$' + salt.toString('base64') + '$' + hash.toString('base64');
}
function verifyPassword(pw, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}
function checkPasswordRule(pw) {
  if (String(pw || '').length < 8) throw new UserError('비밀번호는 8자 이상이어야 합니다.');
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ---------------- 저장소 ---------------- */

function openStore(dbPath) {
  const db = new Database(dbPath);
  db.exec(SCHEMA);

  const tx = (fn) => db.transaction(fn)();
  const log = (email, action, table, id, summary) =>
    db.prepare('INSERT INTO log (at, email, action, tbl, targetId, summary) VALUES (?,?,?,?,?,?)')
      .run(now(), email, action, TABLE_LABEL[table] || table, String(id), String(summary || '').slice(0, 500));
  const getTeacher = (email) => db.prepare('SELECT * FROM teachers WHERE email = ?').get(lower(email));
  const getRow = (table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(String(id || ''));

  /* ----- 계정 / 로그인 ----- */

  function countTeachers() { return db.prepare('SELECT COUNT(*) n FROM teachers').get().n; }

  /** 관리자 계정 생성 또는 비밀번호 재설정 (서버 콘솔/최초 실행용) */
  function upsertAdmin(email, name, password) {
    email = lower(email);
    if (!isEmail(email)) throw new UserError('이메일 형식이 올바르지 않습니다.');
    checkPasswordRule(password);
    const t = now();
    const found = getTeacher(email);
    if (found) {
      db.prepare("UPDATE teachers SET role='admin', active=1, passwordHash=?, mustChangePassword=0, updatedAt=? WHERE email=?")
        .run(hashPassword(password), t, email);
      db.prepare('DELETE FROM sessions WHERE email = ?').run(email);
    } else {
      db.prepare('INSERT INTO teachers VALUES (?,?,?,?,?,?,?,?)')
        .run(email, name || email.split('@')[0], 'admin', 1, hashPassword(password), 0, t, t);
    }
    log(email, found ? 'reset-admin' : 'create-admin', 'teachers', email, 'console');
  }

  /** 로그인 성공 시 세션 토큰(원문)을 반환. 실패 시 null */
  function login(email, password) {
    const t = getTeacher(email);
    // 계정이 없어도 같은 시간이 걸리도록 해시 계산은 수행
    const ok = verifyPassword(password, t ? t.passwordHash : 'scrypt$AAAA$AAAA');
    if (!t || !ok || !t.active) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)')
      .run(sha256(token), t.email, now(), Date.now() + SESSION_DAYS * 86400000);
    db.prepare('DELETE FROM sessions WHERE expiresAt < ?').run(Date.now());
    log(t.email, 'login', 'teachers', t.email, '');
    return token;
  }
  function logout(token) { if (token) db.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(sha256(token)); }

  /** 세션 토큰 → 로그인한 선생님 (없거나 비활성이면 null) */
  function authenticate(token) {
    if (!token) return null;
    const row = db.prepare(`SELECT t.*, s.expiresAt FROM sessions s JOIN teachers t ON t.email = s.email
      WHERE s.tokenHash = ?`).get(sha256(token));
    if (!row || !row.active || row.expiresAt < Date.now()) return null;
    return { email: row.email, name: row.name, role: row.role === 'admin' ? 'admin' : 'teacher',
      mustChangePassword: !!row.mustChangePassword, token };
  }

  function changePassword(me, obj) {
    const t = getTeacher(me.email);
    if (!verifyPassword(obj && obj.current, t.passwordHash)) throw new UserError('현재 비밀번호가 맞지 않습니다.');
    checkPasswordRule(obj.next);
    if (obj.next === obj.current) throw new UserError('새 비밀번호가 기존과 같습니다.');
    tx(() => {
      db.prepare('UPDATE teachers SET passwordHash=?, mustChangePassword=0, updatedAt=? WHERE email=?')
        .run(hashPassword(obj.next), now(), me.email);
      // 다른 기기의 로그인은 모두 해제
      db.prepare('DELETE FROM sessions WHERE email = ? AND tokenHash != ?').run(me.email, sha256(me.token || ''));
      log(me.email, 'change-password', 'teachers', me.email, '');
    });
    return getAll(Object.assign({}, me, { mustChangePassword: false }));
  }

  /* ----- 조회 ----- */

  function getAll(me) {
    return {
      me: { email: me.email, name: me.name, role: me.role, mustChangePassword: !!me.mustChangePassword },
      teachers: db.prepare('SELECT email, name, role, active FROM teachers ORDER BY name').all()
        .map((t) => ({ email: t.email, name: t.name, role: t.role, active: !!t.active })),
      students: db.prepare('SELECT * FROM students').all(),
      notes: db.prepare('SELECT * FROM notes').all(),
      apps: db.prepare('SELECT * FROM apps').all(),
      serverTime: now(),
    };
  }

  /* ----- 저장 공통 ----- */

  function save(table, fields, me, obj, summarize, extraNew) {
    tx(() => {
      const rec = {};
      fields.forEach((k) => { if (k in obj) rec[k] = clean(obj[k]); });
      if ('counselor' in rec) rec.counselor = lower(rec.counselor);
      if (rec.studentId !== undefined && !getRow('students', rec.studentId)) throw new UserError('존재하지 않는 학생입니다.');
      const t = now();
      if (obj.id) {
        const cur = getRow(table, obj.id);
        if (!cur) throw new UserError('다른 선생님이 이미 삭제한 항목입니다. 새로고침 해주세요.', 409);
        // 동시 수정 방지: 화면을 불러온 뒤 다른 사람이 먼저 저장했으면 거부
        if (obj.updatedAt && obj.updatedAt !== cur.updatedAt) {
          const who = getTeacher(cur.updatedBy);
          throw new UserError('그 사이 ' + (who ? who.name : cur.updatedBy) + ' 님이 먼저 수정했습니다. ' +
            '새로고침 후 다시 입력해주세요.', 409);
        }
        const keys = Object.keys(rec);
        db.prepare(`UPDATE ${table} SET ${keys.map((k) => k + ' = @' + k).concat(['updatedAt = @updatedAt', 'updatedBy = @updatedBy']).join(', ')} WHERE id = @id`)
          .run(Object.assign({}, rec, { updatedAt: t, updatedBy: me.email, id: cur.id }));
        log(me.email, 'update', table, cur.id, summarize(Object.assign({}, cur, rec)));
      } else {
        Object.assign(rec, { id: newId(), createdAt: t, updatedAt: t, updatedBy: me.email }, extraNew || {});
        const keys = Object.keys(rec);
        db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => '@' + k).join(', ')})`).run(rec);
        log(me.email, 'create', table, rec.id, summarize(rec));
      }
    });
    return getAll(me);
  }

  function saveStudent(me, obj) {
    if (!obj || !String(obj.name || '').trim()) throw new UserError('학생 이름은 필수입니다.');
    return save('students', STUDENT_FIELDS, me, obj, (r) => r.name, { createdBy: me.email });
  }
  function saveNote(me, obj) {
    if (!obj || !obj.studentId) throw new UserError('학생이 지정되지 않았습니다.');
    if (!String(obj.content || '').trim() && !String(obj.nextAction || '').trim()) {
      throw new UserError('상담 내용 또는 다음 할 일을 입력하세요.');
    }
    return save('notes', NOTE_FIELDS, me, obj, (r) => r.date + ' ' + r.type, { author: me.email });
  }
  function saveApp(me, obj) {
    if (!obj || !obj.studentId) throw new UserError('학생이 지정되지 않았습니다.');
    if (!String(obj.university || '').trim()) throw new UserError('대학명은 필수입니다.');
    return save('apps', APP_FIELDS, me, obj, (r) => r.university + ' ' + (r.round || ''));
  }

  function remove(table, me, id) {
    tx(() => {
      const cur = getRow(table, id);
      if (!cur) throw new UserError('이미 삭제된 항목입니다.', 404);
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(cur.id);
      log(me.email, 'delete', table, cur.id, JSON.stringify(cur));
    });
    return getAll(me);
  }
  const deleteNote = (me, id) => remove('notes', me, id);
  const deleteApp = (me, id) => remove('apps', me, id);
  function deleteStudent(me, id) {
    if (me.role !== 'admin') throw new UserError('학생 삭제는 관리자만 할 수 있습니다. 상태를 "종료"로 바꿔주세요.', 403);
    return remove('students', me, id); // 상담기록·지원대학은 외래키로 함께 삭제
  }

  /* ----- 선생님 관리 (관리자) ----- */

  function saveTeacher(me, obj) {
    if (me.role !== 'admin') throw new UserError('관리자만 선생님을 관리할 수 있습니다.', 403);
    obj = obj || {};
    const email = lower(obj.email);
    if (!isEmail(email)) throw new UserError('이메일 형식이 올바르지 않습니다.');
    const role = obj.role === 'admin' ? 'admin' : 'teacher';
    const active = obj.active === false ? 0 : 1;
    if (email === me.email && (role !== 'admin' || !active)) throw new UserError('본인의 관리자 권한은 해제할 수 없습니다.');
    const password = obj.password ? String(obj.password) : '';
    if (password) checkPasswordRule(password);
    tx(() => {
      const found = getTeacher(email);
      const name = String(obj.name || '').trim() || (found ? found.name : email.split('@')[0]);
      const t = now();
      if (found) {
        db.prepare('UPDATE teachers SET name=?, role=?, active=?, updatedAt=? WHERE email=?').run(name, role, active, t, email);
        if (password) {
          db.prepare('UPDATE teachers SET passwordHash=?, mustChangePassword=1 WHERE email=?').run(hashPassword(password), email);
        }
        // 비활성화·비밀번호 초기화 시 기존 로그인 즉시 해제
        if (!active || password) db.prepare('DELETE FROM sessions WHERE email = ?').run(email);
      } else {
        if (!password) throw new UserError('새 선생님의 임시 비밀번호를 입력하세요 (8자 이상).');
        db.prepare('INSERT INTO teachers VALUES (?,?,?,?,?,?,?,?)').run(email, name, role, active, hashPassword(password), 1, t, t);
      }
      log(me.email, found ? 'update' : 'create', 'teachers', email,
        [name, role, active ? '활성' : '비활성', password ? '비밀번호 초기화' : ''].join(' '));
    });
    return getAll(me);
  }

  async function backup(destPath) { await db.backup(destPath); }

  return {
    db, countTeachers, upsertAdmin, login, logout, authenticate,
    rpc: { getAll: (me) => getAll(me), saveStudent, saveNote, saveApp, deleteNote, deleteApp, deleteStudent, saveTeacher, changePassword },
    backup, close: () => db.close(),
  };
}

module.exports = { openStore, UserError };
