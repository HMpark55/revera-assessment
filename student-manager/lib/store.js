'use strict';
/**
 * 데이터 저장소 (SQLite 파일 1개 + 업로드 파일 폴더) + 업무 규칙/권한.
 *
 * 역할
 *   admin(관리자)      : 전체 + 계정 관리 + 변경 기록 + 영구 삭제
 *   staff(관리팀)      : 전체 학생, 계약 금액, 상담기록, 삭제/복구
 *   consultant(컨설턴트): 담당 학생만, 상담기록·계약 금액은 볼 수 없음
 *
 * 삭제는 모두 "휴지통으로 이동"(deletedAt 기록)이며, 관리자/관리팀이 복구할 수 있습니다.
 */
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class UserError extends Error {
  constructor(message, status) { super(message); this.status = status || 400; }
}

const ROLES = ['admin', 'staff', 'consultant'];

/** 테이블별 입력 가능한 필드 */
const TABLES = {
  students: {
    label: '학생',
    fields: ['name', 'dob', 'school', 'grade', 'curriculum', 'counselor', 'manager', 'status', 'tracks', 'studentPhone', 'progress',
      'parentName', 'parentPhone', 'email', 'tags', 'memo', 'driveUrl', 'resumeUrl',
      'fatherName', 'fatherPhone', 'fatherWechat', 'fatherEmail', 'motherName', 'motherPhone', 'motherWechat', 'motherEmail',
      'storyTrigger', 'storyProcess', 'storyLink', 'storyConclusion', 'storyStatus'],
    summary: (r) => r.name,
  },
  notes: {
    label: '상담기록',
    fields: ['studentId', 'date', 'time', 'place', 'attendees', 'type', 'content', 'nextAction', 'nextDue', 'done'],
    summary: (r) => [r.date, r.type].join(' '),
  },
  contracts: {
    label: '계약',
    fields: ['studentId', 'kind', 'tier', 'term', 'packages', 'startMonth', 'endMonth', 'signedDate', 'currency', 'amount',
      'payDue', 'scope', 'memo'],
    summary: (r) => [r.kind, r.tier, r.term, r.packages].filter(Boolean).join(' '),
  },
  apps: {
    label: '지원대학',
    fields: ['studentId', 'country', 'universityId', 'university', 'majorId', 'major', 'roundId', 'round', 'deadline',
      'deadlineManual', 'status', 'essay', 'memo'],
    summary: (r) => [r.university, r.round].filter(Boolean).join(' '),
  },
  scores: {
    label: '성적',
    fields: ['studentId', 'kind', 'subject', 'score', 'detail', 'date', 'memo'],
    summary: (r) => [r.kind, r.subject, r.score].filter(Boolean).join(' '),
  },
  activities: {
    label: '활동',
    fields: ['studentId', 'category', 'name', 'role', 'period', 'deadline', 'status', 'memo'],
    summary: (r) => [r.category, r.name].filter(Boolean).join(' '),
  },
  docs: {
    label: '서류',
    fields: ['studentId', 'name', 'status', 'due', 'memo'],
    summary: (r) => [r.name, r.status].filter(Boolean).join(' '),
  },
  links: {
    label: '링크',
    fields: ['studentId', 'label', 'url'],
    summary: (r) => r.label || r.url,
  },
  files: {
    label: '파일',
    fields: ['studentId', 'category', 'name', 'memo'], // 파일 자체는 upload 로만 추가
    summary: (r) => r.name,
  },
  followups: {
    label: '팔로업',
    fields: ['studentId', 'title', 'detail', 'category', 'assignee', 'due', 'status'],
    summary: (r) => [r.title, r.status].filter(Boolean).join(' · '),
  },
  payments: {
    label: '입금',
    fields: ['studentId', 'contractId', 'date', 'amount', 'currency', 'method', 'memo'],
    summary: (r) => [r.date, r.currency, r.amount].filter(Boolean).join(' '),
  },
};
const CURRENCIES = ['RMB', 'KRW'];
const FOLLOWUP_STATUS = ['할 일', '진행 중', '대기', '완료'];
const CHILD_TABLES = Object.keys(TABLES).filter((t) => t !== 'students');

/** 대학 정보 (학생과 무관한 공용 자료) */
const CATALOG = {
  universities: {
    label: '대학', fields: ['country', 'name', 'fullName', 'aliases', 'website', 'tips', 'sortOrder'],
    summary: (r) => r.name,
  },
  unicycles: {
    label: '입학 연도 정보', fields: ['universityId', 'year', 'term', 'requirements', 'sourceUrl', 'status', 'memo'],
    summary: (r) => cycleLabel(r),
  },
  unirounds: {
    label: '전형·마감', fields: ['universityId', 'cycleId', 'name', 'deadline', 'memo'],
    summary: (r) => [r.name, r.deadline].filter(Boolean).join(' '),
  },
  unimajors: {
    label: '전공', fields: ['universityId', 'name', 'faculty', 'code', 'detail', 'sourceUrl'],
    summary: (r) => r.name,
  },
};
/** 대학 목록 자체(추가·삭제·이름/국가 변경)는 관리자만 */
const UNI_ADMIN_FIELDS = ['country', 'name', 'fullName', 'aliases', 'sortOrder'];
const CYCLE_STATUS = ['확인 필요', '확인 완료'];
const DEF = Object.assign({}, TABLES, CATALOG);
function cycleLabel(c) { return c ? (c.year || '') + '년 ' + (c.term || '') + ' 입학' : ''; }
/** 변경 기록에 표시할 항목 이름 */
const FIELD_LABELS = {
  name: '이름', dob: '생년월일', school: '학교', grade: '학년', curriculum: '커리큘럼', counselor: '담당 컨설턴트',
  status: '상태', tracks: '트랙', studentPhone: '학생 연락처', parentName: '학부모 이름', parentPhone: '학부모 연락처',
  email: '이메일', tags: '태그', memo: '메모', driveUrl: 'Drive 링크', storyTrigger: '스토리①계기', storyProcess: '스토리②탐구',
  storyLink: '스토리③연결', storyConclusion: '스토리④결론', storyStatus: '스토리 상태', date: '날짜', time: '시간',
  place: '장소', attendees: '참석자', type: '유형', content: '내용', nextAction: '다음 할 일', nextDue: '할 일 기한',
  done: '할 일 완료', kind: '종류', tier: '등급', term: '기간', packages: '패키지', startMonth: '시작 연월',
  signedDate: '계약일', amount: '금액', paid: '납부 상태', scope: '포함 범위', university: '대학', major: '전공',
  round: '전형', deadline: '마감일', essay: '에세이', subject: '과목', score: '점수', detail: '세부 점수',
  category: '분류', role: '역할', period: '기간', due: '기한', label: '이름', url: '주소', studentId: '학생',
  resumeUrl: 'Resume 링크', fatherName: '부 이름', fatherPhone: '부 연락처', fatherWechat: '부 WeChat', fatherEmail: '부 이메일',
  motherName: '모 이름', motherPhone: '모 연락처', motherWechat: '모 WeChat', motherEmail: '모 이메일', country: '국가',
  endMonth: '종료 연월', currency: '통화', payDue: '납부 기한', contractId: '계약', method: '입금 방법',
  manager: '담당 관리팀', progress: '현재 진행 상황', title: '할 일', assignee: '담당자', doneAt: '완료 시각', doneBy: '완료한 사람',
  universityId: '대학(목록)', majorId: '전공(목록)', roundId: '전형(목록)', deadlineManual: '마감일 직접 지정',
  fullName: '정식 이름', aliases: '다른 이름', website: '홈페이지', tips: '원서 준비 유의사항', sortOrder: '순서',
  year: '입학 연도', term: '입학 학기', requirements: '공식 지원 요건', sourceUrl: '출처', faculty: '단과대',
  code: '코드', cycleId: '입학 연도',
};
/** 관리자/관리팀만 다룰 수 있는 테이블 */
const MANAGER_ONLY = ['notes', 'contracts', 'payments'];
/** 컨설턴트에게 숨기는 계약 필드 */
const HIDDEN_FOR_CONSULTANT = { contracts: ['amount', 'paid', 'currency', 'payDue'] };

const UPLOAD_TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  heic: 'image/heic', gif: 'image/gif',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  hwp: 'application/x-hwp',
};
const MAX_UPLOAD = 20 * 1024 * 1024;
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
const isManager = (me) => me.role === 'admin' || me.role === 'staff';
function clean(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join(', ');
  return String(v).replace(/\r\n/g, '\n').slice(0, 20000);
}
function checkUrl(u, label) {
  if (u && !/^https?:\/\/\S+$/i.test(u)) throw new UserError((label || '링크') + '는 http:// 또는 https:// 로 시작해야 합니다.');
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
  if (String(pw || '').length < 6) throw new UserError('비밀번호는 6자 이상이어야 합니다.');
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** "30,000" → 30000 (숫자가 아니면 0) */
function parseAmount(v) { const n = Number(String(v || '').replace(/[^\d.]/g, '')); return isFinite(n) ? n : 0; }

/* ---------------- 스키마 ---------------- */

const BASE_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS teachers (
  email TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'consultant',
  active INTEGER NOT NULL DEFAULT 1, passwordHash TEXT NOT NULL, mustChangePassword INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  tokenHash TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES teachers(email) ON DELETE CASCADE,
  createdAt TEXT NOT NULL, expiresAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS students (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, email TEXT NOT NULL, action TEXT NOT NULL,
  tbl TEXT NOT NULL, targetId TEXT NOT NULL, summary TEXT NOT NULL
);
`;
const META_COLS = ['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'deletedAt', 'deletedBy'];

/** 없는 열을 추가 (기존 DB를 데이터 손실 없이 새 구조로 올림) */
function ensureColumns(db, table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const c of cols) {
    if (!have.has(c)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''`);
  }
}

function migrate(db) {
  db.exec(BASE_SCHEMA);
  for (const t of CHILD_TABLES) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY,
      studentId TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${t}_student ON ${t}(studentId)`);
  }
  for (const t of Object.keys(TABLES)) {
    ensureColumns(db, t, TABLES[t].fields.filter((f) => f !== 'studentId').concat(META_COLS));
  }
  ensureColumns(db, 'notes', ['author']);
  ensureColumns(db, 'followups', ['doneAt', 'doneBy']);
  ensureColumns(db, 'log', ['studentId']);
  db.exec('CREATE INDEX IF NOT EXISTS log_student ON log(studentId)');
  // v5: 첫 로그인 비밀번호 변경 강제 없앰
  db.prepare('UPDATE teachers SET mustChangePassword = 0 WHERE mustChangePassword != 0').run();
  for (const t of Object.keys(CATALOG)) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY)`);
    ensureColumns(db, t, CATALOG[t].fields.concat(META_COLS));
  }
  ensureColumns(db, 'unicycles', ['verifiedAt', 'verifiedBy']);
  db.exec('CREATE INDEX IF NOT EXISTS unicycles_uni ON unicycles(universityId)');
  db.exec('CREATE INDEX IF NOT EXISTS unirounds_uni ON unirounds(universityId)');
  db.exec('CREATE INDEX IF NOT EXISTS unimajors_uni ON unimajors(universityId)');
  ensureColumns(db, 'files', ['mime', 'size', 'storedName', 'docId']);
  ensureColumns(db, 'docs', ['receivedAt', 'receivedBy']);
  ensureColumns(db, 'contracts', ['paid']); // 이전 버전 열 (새 버전은 입금 기록으로 계산)
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare("UPDATE contracts SET currency = 'RMB' WHERE currency = ''").run();
  // v3: 이전 버전의 '납부 완료' 표시를 입금 기록으로 한 번만 옮김 (입금일 기준 매출 계산을 위해)
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v3_paid_to_payments'").get()) {
    const ts = now();
    db.prepare(`SELECT * FROM contracts WHERE paid LIKE '%완료%'`).all().forEach((c) => {
      const amount = parseAmount(c.amount);
      if (!amount) return;
      db.prepare(`INSERT INTO payments (id, studentId, contractId, date, amount, currency, method, memo,
        createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(newId(), c.studentId, c.id, c.signedDate || c.createdAt.slice(0, 10), String(amount), c.currency || 'RMB', '',
          '이전 버전의 "납부 완료" 표시에서 자동 생성 — 실제 입금일을 확인해 수정해주세요', ts, 'system', ts, 'system');
    });
    db.prepare("INSERT INTO meta VALUES ('v3_paid_to_payments', ?)").run(ts);
  }
  // 이전 버전의 'teacher' 역할은 권한이 가장 좁은 컨설턴트로 전환
  db.prepare(`UPDATE teachers SET role = 'consultant' WHERE role NOT IN ('admin','staff','consultant')`).run();
  // 이전 버전 데이터의 작성자 정보 보정
  db.prepare(`UPDATE notes SET createdBy = author WHERE createdBy = '' AND author != ''`).run();
  for (const t of ['apps']) db.prepare(`UPDATE ${t} SET createdBy = updatedBy WHERE createdBy = ''`).run();
  // v4: 대학 정보 초기 자료 (목록이 비어 있을 때 한 번만)
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v4_university_seed'").get()) {
    if (!db.prepare('SELECT 1 FROM universities LIMIT 1').get()) seedUniversities(db);
    db.prepare("INSERT INTO meta VALUES ('v4_university_seed', ?)").run(now());
  }
}

function seedUniversities(db) {
  const seed = require('./university-seed');
  const ts = now();
  const meta = { createdAt: ts, createdBy: 'system', updatedAt: ts, updatedBy: 'system' };
  const ins = (table, rec) => {
    const keys = Object.keys(rec);
    db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => '@' + k).join(', ')})`).run(rec);
  };
  seed.forEach((u, i) => {
    const uid = newId();
    ins('universities', Object.assign({ id: uid, country: u.country, name: u.name, fullName: u.fullName || '', aliases: u.aliases || '',
      website: u.website || '', tips: u.tips || '', sortOrder: String(i + 1) }, meta));
    (u.cycles || []).forEach((c) => {
      const cid = newId();
      ins('unicycles', Object.assign({ id: cid, universityId: uid, year: c.year, term: c.term, requirements: JSON.stringify(c.requirements || []),
        sourceUrl: c.sourceUrl || '', status: '확인 필요', memo: c.memo || '' }, meta));
      (c.rounds || []).forEach((r) => ins('unirounds', Object.assign({ id: newId(), universityId: uid, cycleId: cid,
        name: r.name, deadline: r.deadline || '', memo: r.memo || '' }, meta)));
    });
    (u.majors || []).forEach((m) => ins('unimajors', Object.assign({ id: newId(), universityId: uid, name: m.name,
      faculty: m.faculty || '', code: m.code || '', detail: m.detail || '', sourceUrl: m.sourceUrl || '' }, meta)));
  });
  linkAppsByName(db);
}

/** 대학 목록과 이름이 같은 지원대학을 목록에 연결 (이름 · 정식 이름 · 다른 이름 기준) */
function linkAppsByName(db) {
  const norm = (x) => String(x || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const map = {};
  db.prepare("SELECT * FROM universities WHERE deletedAt = ''").all().forEach((u) => {
    [u.name, u.fullName].concat(String(u.aliases || '').split(',')).map(norm).filter(Boolean).forEach((n) => { map[n] = map[n] || u; });
  });
  let n = 0;
  db.prepare("SELECT id, university FROM apps WHERE universityId = '' AND deletedAt = ''").all().forEach((a) => {
    const u = map[norm(a.university)];
    if (u) { db.prepare('UPDATE apps SET universityId = ?, university = ?, country = ? WHERE id = ?').run(u.id, u.name, u.country, a.id); n++; }
  });
  return n;
}

/* ---------------- 저장소 ---------------- */

function openStore(dbPath, opts) {
  opts = opts || {};
  const db = new Database(dbPath);
  migrate(db);
  const filesDir = opts.filesDir || path.join(path.dirname(dbPath), 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  const tx = (fn) => db.transaction(fn)();
  const log = (email, action, table, id, summary) => {
    let sid = '';
    if (table === 'students') sid = String(id);
    else if (TABLES[table]) { const r = getRow(table, id); sid = r ? r.studentId : ''; }
    db.prepare('INSERT INTO log (at, email, action, tbl, targetId, summary, studentId) VALUES (?,?,?,?,?,?,?)')
      .run(now(), email, action, table, String(id), String(summary || '').slice(0, 500), sid);
  };
  const getTeacher = (email) => db.prepare('SELECT * FROM teachers WHERE email = ?').get(lower(email));
  const getRow = (table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(String(id || ''));

  /* ----- 권한 ----- */

  function canSeeStudent(me, s) {
    return !!s && !s.deletedAt && (isManager(me) || lower(s.counselor) === me.email);
  }
  function requireStudent(me, id) {
    const s = getRow('students', id);
    if (!s || s.deletedAt) throw new UserError('존재하지 않거나 삭제된 학생입니다.', 404);
    if (!canSeeStudent(me, s)) throw new UserError('담당 학생이 아니어서 접근할 수 없습니다.', 403);
    return s;
  }
  function requireManager(me, what) {
    if (!isManager(me)) throw new UserError((what || '이 작업') + '은(는) 관리자·관리팀만 할 수 있습니다.', 403);
  }
  function requireAdmin(me, what) {
    if (me.role !== 'admin') throw new UserError((what || '이 작업') + '은(는) 관리자만 할 수 있습니다.', 403);
  }
  function requireTableAccess(me, table) {
    if (MANAGER_ONLY.includes(table)) requireManager(me, TABLES[table].label + ' 관리');
  }

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

  /** 세션 토큰 → 로그인한 사용자 (없거나 비활성이면 null) */
  function authenticate(token) {
    if (!token) return null;
    const row = db.prepare(`SELECT t.*, s.expiresAt FROM sessions s JOIN teachers t ON t.email = s.email
      WHERE s.tokenHash = ?`).get(sha256(token));
    if (!row || !row.active || row.expiresAt < Date.now()) return null;
    return { email: row.email, name: row.name, role: ROLES.includes(row.role) ? row.role : 'consultant',
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

  function publicRow(table, r, me) {
    const o = Object.assign({}, r);
    if (table === 'files') delete o.storedName;
    if (!isManager(me)) (HIDDEN_FOR_CONSULTANT[table] || []).forEach((k) => delete o[k]);
    return o;
  }

  function getAll(me) {
    const students = db.prepare("SELECT * FROM students WHERE deletedAt = ''").all().filter((s) => canSeeStudent(me, s));
    const ids = new Set(students.map((s) => s.id));
    const out = {
      me: { email: me.email, name: me.name, role: me.role, mustChangePassword: !!me.mustChangePassword },
      teachers: db.prepare('SELECT email, name, role, active FROM teachers ORDER BY name').all()
        .map((t) => ({ email: t.email, name: t.name, role: t.role, active: !!t.active })),
      students,
      serverTime: now(),
    };
    for (const t of CHILD_TABLES) {
      if (MANAGER_ONLY.includes(t) && t !== 'contracts' && !isManager(me)) { out[t] = []; continue; }
      out[t] = db.prepare(`SELECT * FROM ${t} WHERE deletedAt = ''`).all()
        .filter((r) => ids.has(r.studentId)).map((r) => publicRow(t, r, me));
    }
    // 대학 정보는 모두에게 공개
    const unis = db.prepare("SELECT * FROM universities WHERE deletedAt = ''").all();
    const uids = new Set(unis.map((u) => u.id));
    out.universities = unis;
    for (const t of ['unicycles', 'unirounds', 'unimajors']) {
      out[t] = db.prepare(`SELECT * FROM ${t} WHERE deletedAt = ''`).all().filter((r) => uids.has(r.universityId));
    }
    return out;
  }

  /* ----- 저장 (모든 테이블 공통) ----- */

  function validate(table, rec, cur) {
    const v = (k) => (k in rec ? rec[k] : cur ? cur[k] : '');
    const need = (k, msg) => { if (!String(v(k) || '').trim()) throw new UserError(msg); };
    if (table === 'students') need('name', '학생 이름은 필수입니다.');
    if (table === 'notes' && !String(v('content')).trim() && !String(v('nextAction')).trim()) {
      throw new UserError('상담 내용 또는 다음 할 일을 입력하세요.');
    }
    if (table === 'apps') need('university', '대학명은 필수입니다.');
    if (table === 'contracts') need('kind', '계약 종류(연간/원서)를 선택하세요.');
    if (table === 'scores') need('kind', '시험 종류를 선택하세요.');
    if (table === 'activities') need('name', '활동 이름을 입력하세요.');
    if (table === 'docs') need('name', '서류 이름을 입력하세요.');
    if (table === 'links') { need('url', '링크 주소를 입력하세요.'); checkUrl(v('url')); }
    if (table === 'files') need('name', '파일 이름을 입력하세요.');
    if (table === 'followups') {
      need('title', '할 일을 입력하세요.');
      if (v('status') && !FOLLOWUP_STATUS.includes(v('status'))) throw new UserError('상태가 올바르지 않습니다.');
      if (v('due') && !/^\d{4}-\d{2}-\d{2}$/.test(v('due'))) throw new UserError('기한 형식이 올바르지 않습니다.');
    }
    if (table === 'students') {
      for (const k of ['counselor', 'manager']) {
        const e = v(k);
        if (e && !getTeacher(e)) throw new UserError('담당자로 지정한 계정을 찾을 수 없습니다.');
      }
    }
    if (table === 'students') { checkUrl(v('driveUrl'), 'Drive 폴더 링크'); checkUrl(v('resumeUrl'), 'Resume 링크'); }
    if (table === 'contracts' && v('currency') && !CURRENCIES.includes(v('currency'))) throw new UserError('통화는 RMB 또는 KRW만 가능합니다.');
    if (table === 'payments') {
      need('date', '입금일을 입력하세요.');
      if (!(parseAmount(v('amount')) > 0)) throw new UserError('입금액을 숫자로 입력하세요.');
      if (!CURRENCIES.includes(v('currency'))) throw new UserError('통화는 RMB 또는 KRW만 가능합니다.');
      const c = getRow('contracts', v('contractId'));
      if (!c || c.deletedAt || c.studentId !== v('studentId')) throw new UserError('입금을 연결할 계약을 찾을 수 없습니다.');
    }
  }

  /** 지원대학이 대학 목록과 연결되어 있으면 대학명·국가·전공·전형·마감일을 목록 값으로 채움 */
  function resolveApp(rec, cur) {
    const pick = (k) => (k in rec ? rec[k] : cur ? cur[k] : '');
    let uid = pick('universityId');
    const u = uid ? getRow('universities', uid) : null;
    if (uid && (!u || u.deletedAt)) uid = '';
    if (!uid) {
      if ('universityId' in rec || (cur && cur.universityId)) { rec.universityId = ''; rec.roundId = ''; rec.majorId = ''; }
      return;
    }
    rec.universityId = uid;
    rec.university = u.name;
    rec.country = u.country;
    const rid = pick('roundId');
    const r = rid ? getRow('unirounds', rid) : null;
    if (r && !r.deletedAt && r.universityId === uid) {
      rec.round = r.name;
      if (pick('deadlineManual') !== 'TRUE') rec.deadline = r.deadline;
    } else if (rid) rec.roundId = '';
    const mid = pick('majorId');
    const m = mid ? getRow('unimajors', mid) : null;
    if (m && !m.deletedAt && m.universityId === uid) rec.major = m.name;
    else if (mid) rec.majorId = '';
  }

  function save(me, arg) {
    const table = arg && arg.table;
    const obj = (arg && arg.obj) || {};
    if (CATALOG[table]) return saveCatalog(me, table, obj);
    if (!TABLES[table]) throw new UserError('알 수 없는 항목입니다.');
    requireTableAccess(me, table);
    let result;
    tx(() => {
      const rec = {};
      TABLES[table].fields.forEach((k) => { if (k in obj) rec[k] = clean(obj[k]); });
      if ('counselor' in rec) rec.counselor = lower(rec.counselor);
      const t = now();
      if (obj.id) {
        const cur = getRow(table, obj.id);
        if (!cur || cur.deletedAt) throw new UserError('다른 선생님이 이미 삭제한 항목입니다. 새로고침 해주세요.', 409);
        if (table === 'students') {
          requireStudent(me, cur.id);
          if (!isManager(me)) { delete rec.counselor; delete rec.manager; } // 컨설턴트는 담당자 변경 불가
        } else {
          requireStudent(me, cur.studentId);
          if (rec.studentId && rec.studentId !== cur.studentId) requireStudent(me, rec.studentId);
          if (!isManager(me)) (HIDDEN_FOR_CONSULTANT[table] || []).forEach((k) => delete rec[k]);
        }
        // 동시 수정 방지: 화면을 불러온 뒤 다른 사람이 먼저 저장했으면 거부
        if (obj.updatedAt && obj.updatedAt !== cur.updatedAt) {
          const who = getTeacher(cur.updatedBy);
          throw new UserError('그 사이 ' + (who ? who.name : cur.updatedBy) + ' 님이 먼저 수정했습니다. ' +
            '새로고침 후 다시 입력해주세요.', 409);
        }
        if (table === 'payments' && 'amount' in rec) rec.amount = String(parseAmount(rec.amount));
        if (table === 'apps') resolveApp(rec, cur);
        if (table === 'followups' && 'status' in rec && rec.status !== cur.status) {
          rec.doneAt = rec.status === '완료' ? t : '';
          rec.doneBy = rec.status === '완료' ? me.email : '';
        }
        if ('manager' in rec) rec.manager = lower(rec.manager);
        if ('assignee' in rec) rec.assignee = lower(rec.assignee);
        validate(table, rec, cur);
        const keys = Object.keys(rec);
        db.prepare(`UPDATE ${table} SET ${keys.map((k) => k + ' = @' + k).concat(['updatedAt = @updatedAt', 'updatedBy = @updatedBy']).join(', ')} WHERE id = @id`)
          .run(Object.assign({}, rec, { updatedAt: t, updatedBy: me.email, id: cur.id }));
        const changed = keys.filter((k) => String(rec[k]) !== String(cur[k] == null ? '' : cur[k]))
          .map((k) => FIELD_LABELS[k] || k);
        log(me.email, 'update', table, cur.id, describe(table, Object.assign({}, cur, rec)) +
          (changed.length ? ' — 변경: ' + changed.join(', ') : ' — 변경 없음'));
        result = cur.id;
      } else {
        if (table === 'students') {
          requireManager(me, '학생 등록');
        } else {
          if (!rec.studentId) throw new UserError('학생이 지정되지 않았습니다.');
          requireStudent(me, rec.studentId);
          if (table === 'files') throw new UserError('파일은 업로드로만 추가할 수 있습니다.');
        }
        if (table === 'payments' && !rec.currency) {
          const c = getRow('contracts', rec.contractId);
          rec.currency = (c && c.currency) || 'RMB';
        }
        if (table === 'contracts' && !rec.currency) rec.currency = 'RMB';
        if (table === 'payments') rec.amount = String(parseAmount(rec.amount));
        if (table === 'apps') {
          if (!rec.universityId && rec.university) rec.universityId = findUniByName(rec.university);
          resolveApp(rec, null);
        }
        if (table === 'followups') {
          if (!rec.status) rec.status = '할 일';
          if (rec.status === '완료') { rec.doneAt = t; rec.doneBy = me.email; }
        }
        if ('manager' in rec) rec.manager = lower(rec.manager);
        if ('assignee' in rec) rec.assignee = lower(rec.assignee);
        validate(table, rec, null);
        Object.assign(rec, { id: newId(), createdAt: t, createdBy: me.email, updatedAt: t, updatedBy: me.email });
        if (table === 'notes') rec.author = me.email;
        const keys = Object.keys(rec);
        db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => '@' + k).join(', ')})`).run(rec);
        log(me.email, 'create', table, rec.id, describe(table, rec));
        result = rec.id;
      }
    });
    const data = getAll(me);
    data.savedId = result;
    return data;
  }

  /** 로그에 남길 설명: "학생명 · 내용" (대학 정보는 "대학명 · 내용") */
  function describe(table, r) {
    if (CATALOG[table]) {
      const u = table === 'universities' ? null : getRow('universities', r.universityId);
      const extra = table === 'unirounds' ? cycleLabel(getRow('unicycles', r.cycleId)) : '';
      return [u ? u.name : '', extra, CATALOG[table].summary(r)].filter(Boolean).join(' · ');
    }
    const s = table === 'students' ? null : getRow('students', r.studentId);
    return [s ? s.name : '', TABLES[table].summary(r)].filter(Boolean).join(' · ');
  }

  function findUniByName(name) {
    const norm = (x) => String(x || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const n = norm(name);
    if (!n) return '';
    const u = db.prepare("SELECT * FROM universities WHERE deletedAt = ''").all().find((x) =>
      [x.name, x.fullName].concat(String(x.aliases || '').split(',')).map(norm).includes(n));
    return u ? u.id : '';
  }
  function requireUni(id) {
    const u = getRow('universities', id);
    if (!u || u.deletedAt) throw new UserError('대학 정보를 찾을 수 없습니다. 새로고침 해주세요.', 404);
    return u;
  }
  function validateCatalog(table, rec, cur) {
    const v = (k) => (k in rec ? rec[k] : cur ? cur[k] : '');
    const need = (k, msg) => { if (!String(v(k) || '').trim()) throw new UserError(msg); };
    if (table === 'universities') {
      need('name', '대학 이름을 입력하세요.'); need('country', '국가를 선택하세요.');
      checkUrl(v('website'), '홈페이지');
      const dup = db.prepare("SELECT id FROM universities WHERE name = ? AND deletedAt = ''").get(v('name'));
      if (dup && (!cur || dup.id !== cur.id)) throw new UserError('같은 이름의 대학이 이미 있습니다.');
    }
    if (table === 'unicycles') {
      if (!/^\d{4}$/.test(v('year'))) throw new UserError('입학 연도를 4자리 숫자로 입력하세요. (예: 2027)');
      need('term', '입학 학기를 선택하세요.');
      if (v('status') && !CYCLE_STATUS.includes(v('status'))) throw new UserError('상태는 "확인 필요" 또는 "확인 완료"만 가능합니다.');
      checkUrl(v('sourceUrl'), '출처 링크');
      let reqs;
      try { reqs = JSON.parse(v('requirements') || '[]'); } catch (e) { reqs = null; }
      if (!Array.isArray(reqs)) throw new UserError('공식 지원 요건 형식이 올바르지 않습니다.');
      const dup = db.prepare("SELECT id FROM unicycles WHERE universityId = ? AND year = ? AND term = ? AND deletedAt = ''")
        .get(v('universityId'), v('year'), v('term'));
      if (dup && (!cur || dup.id !== cur.id)) throw new UserError(v('year') + '년 ' + v('term') + ' 입학 정보가 이미 있습니다.');
    }
    if (table === 'unirounds') {
      need('name', '전형 이름을 입력하세요. (예: Early, Regular)');
      const c = getRow('unicycles', v('cycleId'));
      if (!c || c.deletedAt || c.universityId !== v('universityId')) throw new UserError('입학 연도 정보를 찾을 수 없습니다.');
      if (v('deadline') && !/^\d{4}-\d{2}-\d{2}$/.test(v('deadline'))) throw new UserError('마감일 형식이 올바르지 않습니다.');
    }
    if (table === 'unimajors') { need('name', '전공 이름을 입력하세요.'); checkUrl(v('sourceUrl'), '출처 링크'); }
  }

  function saveCatalog(me, table, obj) {
    const def = CATALOG[table];
    let result;
    tx(() => {
      const rec = {};
      def.fields.forEach((k) => { if (k in obj) rec[k] = clean(obj[k]); });
      const t = now();
      if (obj.id) {
        const cur = getRow(table, obj.id);
        if (!cur || cur.deletedAt) throw new UserError('다른 선생님이 이미 삭제한 항목입니다. 새로고침 해주세요.', 409);
        if (table === 'universities') {
          if (me.role !== 'admin') UNI_ADMIN_FIELDS.forEach((k) => delete rec[k]);
        } else {
          requireUni(cur.universityId);
          delete rec.universityId; // 다른 대학으로 옮기기 불가
          if (table === 'unirounds') delete rec.cycleId;
        }
        if (obj.updatedAt && obj.updatedAt !== cur.updatedAt) {
          const who = getTeacher(cur.updatedBy);
          throw new UserError('그 사이 ' + (who ? who.name : cur.updatedBy) + ' 님이 먼저 수정했습니다. 새로고침 후 다시 입력해주세요.', 409);
        }
        validateCatalog(table, rec, cur);
        if (table === 'unicycles' && 'status' in rec && rec.status !== cur.status) {
          rec.verifiedAt = rec.status === '확인 완료' ? t : '';
          rec.verifiedBy = rec.status === '확인 완료' ? me.email : '';
        }
        const keys = Object.keys(rec);
        db.prepare(`UPDATE ${table} SET ${keys.map((k) => k + ' = @' + k).concat(['updatedAt = @updatedAt', 'updatedBy = @updatedBy']).join(', ')} WHERE id = @id`)
          .run(Object.assign({}, rec, { updatedAt: t, updatedBy: me.email, id: cur.id }));
        const after = Object.assign({}, cur, rec);
        const changed = keys.filter((k) => String(rec[k]) !== String(cur[k] == null ? '' : cur[k])).map((k) => FIELD_LABELS[k] || k);
        let cascade = '';
        // 연결된 학생 지원대학에 자동 반영
        if (table === 'universities' && (rec.name !== undefined || rec.country !== undefined)) {
          db.prepare("UPDATE apps SET university = ?, country = ? WHERE universityId = ? AND deletedAt = ''").run(after.name, after.country, cur.id);
        }
        if (table === 'unirounds') {
          const n = db.prepare("UPDATE apps SET deadline = ?, round = ?, updatedAt = ?, updatedBy = ? WHERE roundId = ? AND deletedAt = '' AND deadlineManual != 'TRUE' AND (deadline != ? OR round != ?)")
            .run(after.deadline, after.name, t, me.email, cur.id, after.deadline, after.name).changes;
          db.prepare("UPDATE apps SET round = ? WHERE roundId = ? AND deletedAt = '' AND deadlineManual = 'TRUE'").run(after.name, cur.id);
          if (n) cascade = ' — 학생 지원대학 ' + n + '건 마감일 자동 반영';
        }
        if (table === 'unimajors' && rec.name !== undefined) {
          db.prepare("UPDATE apps SET major = ? WHERE majorId = ? AND deletedAt = ''").run(after.name, cur.id);
        }
        log(me.email, 'update', table, cur.id, describe(table, after) + (changed.length ? ' — 변경: ' + changed.join(', ') : ' — 변경 없음') + cascade);
        result = cur.id;
      } else {
        if (table === 'universities') requireAdmin(me, '대학 추가');
        else requireUni(rec.universityId);
        if (table === 'unicycles') {
          if (!rec.status) rec.status = '확인 필요';
          if (!rec.requirements) rec.requirements = '[]';
        }
        validateCatalog(table, rec, null);
        if (table === 'unicycles' && rec.status === '확인 완료') { rec.verifiedAt = t; rec.verifiedBy = me.email; }
        Object.assign(rec, { id: newId(), createdAt: t, createdBy: me.email, updatedAt: t, updatedBy: me.email });
        insert(table, rec);
        let extra = '';
        if (table === 'universities') {
          const n = linkAppsByName(db);
          if (n) extra = ' — 이름이 같은 학생 지원대학 ' + n + '건 자동 연결';
        }
        log(me.email, 'create', table, rec.id, describe(table, rec) + extra);
        result = rec.id;
      }
    });
    const data = getAll(me);
    data.savedId = result;
    return data;
  }

  /** 입학 연도 정보 복사 (예: 2027 → 2028). 마감일은 1년 뒤로 옮긴 추정치 */
  function copyCycle(me, arg) {
    const src = getRow('unicycles', arg && arg.cycleId);
    if (!src || src.deletedAt) throw new UserError('복사할 입학 연도 정보를 찾을 수 없습니다.', 404);
    requireUni(src.universityId);
    const year = String((arg && arg.year) || (Number(src.year) + 1));
    const term = String((arg && arg.term) || src.term);
    let newId_;
    tx(() => {
      const t = now();
      const rec = { universityId: src.universityId, year, term, requirements: src.requirements, sourceUrl: src.sourceUrl,
        status: '확인 필요', memo: cycleLabel(src) + ' 정보를 복사해 만든 초안입니다. 마감일은 1년 뒤로 옮긴 추정치이니 공식 요강으로 확인하세요.' };
      validateCatalog('unicycles', rec, null);
      Object.assign(rec, { id: newId(), createdAt: t, createdBy: me.email, updatedAt: t, updatedBy: me.email });
      insert('unicycles', rec);
      newId_ = rec.id;
      const shift = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? (Number(d.slice(0, 4)) + (Number(year) - Number(src.year))) + d.slice(4) : '';
      db.prepare("SELECT * FROM unirounds WHERE cycleId = ? AND deletedAt = ''").all(src.id).forEach((r) => {
        insert('unirounds', { id: newId(), universityId: r.universityId, cycleId: rec.id, name: r.name, deadline: shift(r.deadline),
          memo: (r.memo ? r.memo + ' / ' : '') + '추정 날짜 — 확인 필요', createdAt: t, createdBy: me.email, updatedAt: t, updatedBy: me.email });
      });
      log(me.email, 'create', 'unicycles', rec.id, describe('unicycles', rec) + ' — ' + cycleLabel(src) + '에서 복사');
    });
    const data = getAll(me);
    data.savedId = newId_;
    return data;
  }

  /** 삭제 = 휴지통으로 이동 */
  function remove(me, arg) {
    const table = arg && arg.table;
    if (!DEF[table]) throw new UserError('알 수 없는 항목입니다.');
    tx(() => {
      const cur = getRow(table, arg.id);
      if (!cur || cur.deletedAt) throw new UserError('이미 삭제된 항목입니다.', 404);
      if (table === 'universities') {
        requireAdmin(me, '대학 삭제');
      } else if (CATALOG[table]) {
        requireUni(cur.universityId);
      } else if (table === 'students') {
        requireManager(me, '학생 삭제');
      } else {
        requireTableAccess(me, table);
        requireStudent(me, cur.studentId);
      }
      db.prepare(`UPDATE ${table} SET deletedAt = ?, deletedBy = ? WHERE id = ?`).run(now(), me.email, cur.id);
      log(me.email, 'delete', table, cur.id, describe(table, cur));
    });
    return getAll(me);
  }

  /** 휴지통에서 복구 (관리자·관리팀) */
  function restore(me, arg) {
    requireManager(me, '복구');
    const table = arg && arg.table;
    if (!DEF[table]) throw new UserError('알 수 없는 항목입니다.');
    tx(() => {
      const cur = getRow(table, arg.id);
      if (!cur || !cur.deletedAt) throw new UserError('휴지통에 없는 항목입니다.', 404);
      if (CATALOG[table] && table !== 'universities') {
        const u = getRow('universities', cur.universityId);
        if (!u) throw new UserError('대학 정보가 영구 삭제되어 복구할 수 없습니다.');
        if (u.deletedAt) throw new UserError('"' + u.name + '" 대학이 휴지통에 있습니다. 대학을 먼저 복구하세요.');
        if (table === 'unirounds') {
          const c = getRow('unicycles', cur.cycleId);
          if (!c || c.deletedAt) throw new UserError('이 전형의 입학 연도 정보가 휴지통에 있습니다. 먼저 복구하세요.');
        }
      } else if (table !== 'students' && !CATALOG[table]) {
        const s = getRow('students', cur.studentId);
        if (!s) throw new UserError('학생 정보가 영구 삭제되어 복구할 수 없습니다.');
        if (s.deletedAt) throw new UserError('"' + s.name + '" 학생이 휴지통에 있습니다. 학생을 먼저 복구하세요.');
      }
      db.prepare(`UPDATE ${table} SET deletedAt = '', deletedBy = '' WHERE id = ?`).run(cur.id);
      log(me.email, 'restore', table, cur.id, describe(table, cur));
    });
    return getAll(me);
  }

  /** 영구 삭제 (관리자, 휴지통에 있는 것만) */
  function purge(me, arg) {
    requireAdmin(me, '영구 삭제');
    const table = arg && arg.table;
    if (!DEF[table]) throw new UserError('알 수 없는 항목입니다.');
    const files = [];
    tx(() => {
      const cur = getRow(table, arg.id);
      if (!cur || !cur.deletedAt) throw new UserError('휴지통에 있는 항목만 영구 삭제할 수 있습니다.', 404);
      if (table === 'students') {
        db.prepare('SELECT storedName FROM files WHERE studentId = ?').all(cur.id).forEach((f) => files.push(f.storedName));
        for (const t of CHILD_TABLES) db.prepare(`DELETE FROM ${t} WHERE studentId = ?`).run(cur.id);
      } else if (table === 'files') {
        files.push(cur.storedName);
      } else if (table === 'contracts') {
        db.prepare('DELETE FROM payments WHERE contractId = ?').run(cur.id);
      } else if (table === 'universities') {
        for (const t of ['unicycles', 'unirounds', 'unimajors']) db.prepare(`DELETE FROM ${t} WHERE universityId = ?`).run(cur.id);
        db.prepare("UPDATE apps SET universityId = '', roundId = '', majorId = '' WHERE universityId = ?").run(cur.id);
      } else if (table === 'unicycles') {
        db.prepare("UPDATE apps SET roundId = '' WHERE roundId IN (SELECT id FROM unirounds WHERE cycleId = ?)").run(cur.id);
        db.prepare('DELETE FROM unirounds WHERE cycleId = ?').run(cur.id);
      } else if (table === 'unirounds') {
        db.prepare("UPDATE apps SET roundId = '' WHERE roundId = ?").run(cur.id);
      } else if (table === 'unimajors') {
        db.prepare("UPDATE apps SET majorId = '' WHERE majorId = ?").run(cur.id);
      }
      log(me.email, 'purge', table, cur.id, describe(table, cur));
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(cur.id);
    });
    files.filter(Boolean).forEach((f) => fs.rm(path.join(filesDir, f), { force: true }, () => {}));
    return getTrash(me);
  }

  function getTrash(me) {
    requireManager(me, '휴지통 보기');
    const names = {};
    db.prepare('SELECT id, name, deletedAt FROM students').all().forEach((s) => { names[s.id] = s; });
    const items = [];
    for (const t of Object.keys(TABLES)) {
      db.prepare(`SELECT * FROM ${t} WHERE deletedAt != ''`).all().forEach((r) => {
        const s = t === 'students' ? r : names[r.studentId];
        items.push({ table: t, id: r.id, label: TABLES[t].label, summary: TABLES[t].summary(r),
          studentId: t === 'students' ? r.id : r.studentId, studentName: s ? s.name : '(삭제됨)',
          studentDeleted: t !== 'students' && !!(s && s.deletedAt),
          deletedAt: r.deletedAt, deletedBy: r.deletedBy });
      });
    }
    const unis = {};
    db.prepare('SELECT id, name, deletedAt FROM universities').all().forEach((u) => { unis[u.id] = u; });
    for (const t of Object.keys(CATALOG)) {
      db.prepare(`SELECT * FROM ${t} WHERE deletedAt != ''`).all().forEach((r) => {
        const u = t === 'universities' ? r : unis[r.universityId];
        items.push({ table: t, id: r.id, label: CATALOG[t].label, summary: describe(t, r).replace((u ? u.name : '') + ' · ', ''),
          studentId: '', studentName: (u ? u.name : '(삭제됨)') + ' (대학 정보)',
          studentDeleted: t !== 'universities' && !!(u && u.deletedAt),
          deletedAt: r.deletedAt, deletedBy: r.deletedBy });
      });
    }
    items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    return { items };
  }

  /** 학생별 최근 활동 (담당자 모두 볼 수 있음, 컨설턴트에게는 상담기록·계약·입금 기록 제외) */
  function getActivity(me, arg) {
    const s = requireStudent(me, arg && arg.studentId);
    const hidden = isManager(me) ? [] : ['notes', 'contracts', 'payments'];
    const rows = db.prepare('SELECT at, email, action, tbl, summary FROM log WHERE studentId = ? ORDER BY id DESC LIMIT 200').all(s.id)
      .filter((r) => !hidden.includes(r.tbl)).slice(0, 60);
    rows.forEach((r) => { r.tblLabel = (DEF[r.tbl] && DEF[r.tbl].label) || r.tbl; });
    return { rows };
  }

  /** 변경 기록 (관리자) */
  function getLog(me, arg) {
    requireAdmin(me, '변경 기록 보기');
    const limit = Math.min(Math.max(Number(arg && arg.limit) || 1000, 1), 5000);
    const rows = db.prepare('SELECT * FROM log ORDER BY id DESC LIMIT ?').all(limit);
    rows.forEach((r) => { r.tblLabel = (DEF[r.tbl] && DEF[r.tbl].label) || legacyLabel(r.tbl); });
    return { rows };
  }
  function legacyLabel(t) { return { teachers: '계정' }[t] || t; }

  /* ----- 파일 ----- */

  function addFile(me, info) {
    const s = requireStudent(me, info.studentId);
    let doc = null;
    if (info.docId) {
      doc = getRow('docs', info.docId);
      if (!doc || doc.deletedAt || doc.studentId !== s.id) throw new UserError('서류 항목을 찾을 수 없습니다. 새로고침 해주세요.', 404);
    }
    const name = String(info.name || '').replace(/[\\/\r\n]/g, '_').trim().slice(0, 200);
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1];
    const type = ext && UPLOAD_TYPES[ext.toLowerCase()];
    if (!type) throw new UserError('올릴 수 없는 파일 형식입니다. (PDF, 이미지, 워드, 엑셀, 한글 파일만 가능)');
    if (!info.buffer || !info.buffer.length) throw new UserError('빈 파일입니다.');
    if (info.buffer.length > MAX_UPLOAD) throw new UserError('파일은 20MB 이하만 올릴 수 있습니다.');
    const id = newId();
    const storedName = id + '.' + ext.toLowerCase();
    fs.writeFileSync(path.join(filesDir, storedName), info.buffer);
    const t = now();
    const rec = { id, studentId: s.id, category: doc ? '서류' : (clean(info.category) || '성적표'), name, memo: '', mime: type,
      size: String(info.buffer.length), storedName, docId: doc ? doc.id : '',
      createdAt: t, createdBy: me.email, updatedAt: t, updatedBy: me.email };
    try {
      tx(() => {
        const keys = Object.keys(rec);
        db.prepare(`INSERT INTO files (${keys.join(', ')}) VALUES (${keys.map((k) => '@' + k).join(', ')})`).run(rec);
        if (doc) {
          // 서류 파일을 올리면 자동으로 수합 완료 + 받은 날짜/사람 기록
          db.prepare("UPDATE docs SET status = '수합 완료', receivedAt = ?, receivedBy = ?, updatedAt = ?, updatedBy = ? WHERE id = ?")
            .run(t, me.email, t, me.email, doc.id);
        }
        log(me.email, 'upload', 'files', id, s.name + ' · ' + (doc ? doc.name + ' · ' : '') + name);
      });
    } catch (e) {
      fs.rm(path.join(filesDir, storedName), { force: true }, () => {});
      throw e;
    }
    return getAll(me);
  }

  /**
   * 기존 트래커 등에서 만든 JSON 일괄 가져오기 (관리자)
   * { format: 'compass-import-v1', students: [{ name, ..., contracts: [], apps: [], scores: [], docs: [], links: [], notes: [] }] }
   * 같은 이름의 학생이 이미 있으면 건너뜀.
   */
  function importData(me, data) {
    requireAdmin(me, '데이터 가져오기');
    if (!data || data.format !== 'compass-import-v1' || !Array.isArray(data.students)) {
      throw new UserError('Compass 가져오기 파일 형식이 아닙니다.');
    }
    const CHILD_KEYS = ['contracts', 'apps', 'scores', 'docs', 'links', 'notes', 'followups'];
    const teachersByName = {};
    db.prepare('SELECT email, name FROM teachers').all().forEach((t) => { teachersByName[t.name] = t.email; });
    const result = { created: [], skipped: [] };
    tx(() => {
      for (const src of data.students) {
        const name = String((src && src.name) || '').trim();
        if (!name) continue;
        if (db.prepare("SELECT 1 FROM students WHERE name = ? AND deletedAt = ''").get(name)) { result.skipped.push(name); continue; }
        const t = now();
        const st = {};
        TABLES.students.fields.forEach((k) => { if (k in src) st[k] = clean(src[k]); });
        if (!st.counselor && src.counselorName && teachersByName[src.counselorName]) st.counselor = teachersByName[src.counselorName];
        st.counselor = lower(st.counselor);
        validate('students', st, null);
        Object.assign(st, { id: newId(), createdAt: t, createdBy: me.email, updatedAt: t, updatedBy: me.email });
        insert('students', st);
        for (const key of CHILD_KEYS) {
          for (const item of (src[key] || [])) {
            const rec = { studentId: st.id };
            TABLES[key].fields.forEach((k) => { if (k !== 'studentId' && item && k in item) rec[k] = clean(item[k]); });
            if (key === 'contracts' && !rec.currency) rec.currency = 'RMB';
            validate(key, rec, null);
            Object.assign(rec, { id: newId(), createdAt: t, createdBy: me.email, updatedAt: t, updatedBy: me.email });
            if (key === 'notes') rec.author = me.email;
            insert(key, rec);
          }
        }
        log(me.email, 'import', 'students', st.id, name);
        result.created.push(name);
      }
      linkAppsByName(db);
    });
    return Object.assign(getAll(me), { importResult: result });
  }
  function insert(table, rec) {
    const keys = Object.keys(rec);
    db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => '@' + k).join(', ')})`).run(rec);
  }

  /** 다운로드용 파일 정보 (권한 확인 포함) */
  function getFile(me, id) {
    const f = getRow('files', id);
    if (!f || f.deletedAt) throw new UserError('파일을 찾을 수 없습니다.', 404);
    requireStudent(me, f.studentId);
    return { path: path.join(filesDir, f.storedName), name: f.name, mime: f.mime || 'application/octet-stream' };
  }

  /* ----- 계정 관리 (관리자) ----- */

  function saveTeacher(me, obj) {
    requireAdmin(me, '계정 관리');
    obj = obj || {};
    const email = lower(obj.email);
    if (!isEmail(email)) throw new UserError('이메일 형식이 올바르지 않습니다.');
    const role = ROLES.includes(obj.role) ? obj.role : 'consultant';
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
          db.prepare('UPDATE teachers SET passwordHash=?, mustChangePassword=0 WHERE email=?').run(hashPassword(password), email);
        }
        // 비활성화·비밀번호 초기화·역할 변경 시 기존 로그인 즉시 해제
        if (!active || password || role !== found.role) db.prepare('DELETE FROM sessions WHERE email = ?').run(email);
      } else {
        if (!password) throw new UserError('새 계정의 비밀번호를 입력하세요 (6자 이상).');
        db.prepare('INSERT INTO teachers VALUES (?,?,?,?,?,?,?,?)').run(email, name, role, active, hashPassword(password), 0, t, t);
      }
      const roleLabel = { admin: '관리자', staff: '관리팀', consultant: '컨설턴트' }[role];
      log(me.email, found ? 'update' : 'create', 'teachers', email,
        [name, email, roleLabel, active ? '활성' : '비활성', password ? (found ? '비밀번호 초기화' : '임시 비밀번호 설정') : '']
          .filter(Boolean).join(' · '));
    });
    return getAll(me);
  }

  async function backup(destPath) { await db.backup(destPath); }
  /** 백업용 전체 파일 목록 (휴지통 포함) */
  function listFiles() {
    return db.prepare(`SELECT f.storedName, f.name, f.category, f.createdAt, f.deletedAt, s.name AS studentName
      FROM files f LEFT JOIN students s ON s.id = f.studentId ORDER BY f.createdAt`).all();
  }

  return {
    db, filesDir, listFiles, countTeachers, upsertAdmin, login, logout, authenticate, addFile, getFile,
    rpc: { getAll: (me) => getAll(me), save, remove, restore, purge, getTrash, getLog, saveTeacher, changePassword, importData, copyCycle, getActivity },
    backup, close: () => db.close(),
  };
}

module.exports = { openStore, UserError, MAX_UPLOAD };
