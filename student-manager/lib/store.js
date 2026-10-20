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
const { sanitizeRich, richToText, hasFormatting } = require('./rich');
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
      'hopeUnis', 'focusArea', 'recommenders', 'onlineCourse', 'meetingUrl',
      'fatherName', 'fatherPhone', 'fatherWechat', 'fatherEmail', 'motherName', 'motherPhone', 'motherWechat', 'motherEmail',
      'storyTrigger', 'storyProcess', 'storyLink', 'storyConclusion', 'storyStatus'],
    summary: (r) => r.name,
  },
  notes: {
    label: '상담기록',
    fields: ['studentId', 'date', 'time', 'place', 'attendees', 'type', 'content', 'contentHtml', 'nextAction', 'nextDue', 'done', 'sourceUrl', 'needsReview'],
    summary: (r) => [r.date, r.type].join(' '),
  },
  contracts: {
    label: '계약',
    fields: ['studentId', 'kind', 'tier', 'term', 'packages', 'startDate', 'endDate', 'startMonth', 'endMonth', 'signedDate', 'currency', 'amount',
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
    fields: ['studentId', 'title', 'detail', 'category', 'assignee', 'due', 'status', 'reply', 'replyDate', 'replyFrom', 'meetingId', 'noteId',
      'kind', 'fromWho', 'channel', 'receivedDate', 'answer', 'answerDate'],
    summary: (r) => [r.title, r.status].filter(Boolean).join(' · '),
  },
  majorplans: {
    label: '전공 선정',
    fields: ['studentId', 'date', 'universityId', 'university', 'major', 'field', 'status', 'source', 'reason', 'parentConfirmed'],
    summary: (r) => [r.university, r.major, r.status, r.parentConfirmed === 'TRUE' ? '부모님 확정' : ''].filter(Boolean).join(' · '),
  },
  schools: {
    label: '학력',
    fields: ['studentId', 'school', 'country', 'city', 'gradeFrom', 'gradeTo', 'startDate', 'endDate', 'memo'],
    summary: (r) => [r.school, [r.gradeFrom, r.gradeTo].filter(Boolean).join('~'), [r.startDate, r.endDate || '재학 중'].join('~')].filter(Boolean).join(' '),
  },
  courses: {
    label: '수강 과목',
    fields: ['studentId', 'grade', 'schoolYear', 'subject', 'level', 'termType', 'g1', 'g2', 'g3', 'final', 'memo'],
    summary: (r) => [r.grade, r.subject].filter(Boolean).join(' '),
  },
  meetings: {
    label: '미팅',
    fields: ['studentId', 'date', 'time', 'status', 'type', 'place', 'attendees', 'writer', 'topic', 'content', 'contentHtml', 'parentNote', 'nextStep', 'nextDate', 'sourceUrl', 'needsReview'],
    summary: (r) => [r.date, r.status, r.topic].filter(Boolean).join(' · '),
  },
  accounts: {
    label: '사이트 계정',
    fields: ['studentId', 'category', 'site', 'url', 'universityId', 'loginId', 'password', 'memo'],
    summary: (r) => [r.site, r.loginId].filter(Boolean).join(' · '),
  },
  appinfo: {
    label: '원서 정보',
    fields: ['studentId', 'universityId', 'item', 'content'],
    summary: (r) => r.item,
  },
  payments: {
    label: '입금',
    fields: ['studentId', 'contractId', 'date', 'amount', 'currency', 'method', 'memo'],
    summary: (r) => [r.date, r.currency, r.amount].filter(Boolean).join(' '),
  },
};
const CURRENCIES = ['RMB', 'KRW'];
const FOLLOWUP_STATUS = ['할 일', '진행 중', '대기', '완료'];
/** 팔로업 종류: '' = 우리가 챙길 할 일, 'contact' = 학생·학부모에게 받은 연락(질문·확인 요청) */
const FOLLOWUP_KINDS = ['', 'contact'];
const CONTACT_FROM = ['학생', '어머니', '아버지', '학부모', '학교', '기타'];
const CONTACT_CHANNELS = ['위챗', '문자', '이메일', '전화', '대면', '기타'];
const MAJOR_STATUS = ['후보', '유력', '최종', '제외'];
const MEETING_STATUS = ['예정', '완료', '취소'];
const COURSE_TERMS = ['1년(2학기)', '1학기만', '2학기만', 'Trimester'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 관리 페이지에서 고르는 목록 (학교·커리큘럼) → 학생 정보의 해당 칸 */
const OPTION_KINDS = { school: '학교', curriculum: '커리큘럼', site: '사이트', evcat: '일정 분류' };
/** 목록 이름을 바꾸면 함께 바뀌는 곳 */
const OPTION_TARGET = { school: ['students', 'school'], curriculum: ['students', 'curriculum'], site: ['accounts', 'site'], evcat: ['events', 'category'] };
const ACCOUNT_CATS = ['원서 포털', '시험', '학교 LMS', '기타'];
/** 메인 화면 공용 달력의 일정 분류 */
/** 달력 일정 분류 초기값 (목록 관리 › 일정 분류에서 이름·색·순서 변경) */
const DEFAULT_EVCATS = [['시험', '#d9534f'], ['원서·입시', '#d98a00'], ['학교', '#1d9e75'], ['설명회·행사', '#7c5cc4'], ['휴무', '#6b7280'], ['기타', '#9ca3af']];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** 자주 쓰는 사이트 초기값 (목록 관리 › 사이트에서 관리) */
const DEFAULT_SITES = [
  ['College Board (SAT·AP)', '시험', 'https://www.collegeboard.org'], ['TOEFL (ETS)', '시험', 'https://www.ets.org'],
  ['IELTS', '시험', 'https://www.ielts.org'], ['Common App', '원서 포털', 'https://apply.commonapp.org'],
  ['UCAS', '원서 포털', 'https://www.ucas.com'], ['Schoology', '학교 LMS', 'https://app.schoology.com'],
  ['Microsoft Teams', '학교 LMS', 'https://teams.microsoft.com']];
const DEFAULT_CURRICULA = ['IB', 'AP', 'A-Level', 'IGCSE', '국내 일반고', '국내 특목고', '기타'];
const CHILD_TABLES = Object.keys(TABLES).filter((t) => t !== 'students');

/** 대학 정보 (학생과 무관한 공용 자료) */
const CATALOG = {
  universities: {
    label: '대학', fields: ['country', 'name', 'fullName', 'aliases', 'website', 'tips', 'sortOrder'],
    summary: (r) => r.name,
  },
  unicycles: {
    label: '입학 연도 정보', fields: ['universityId', 'year', 'term', 'tracks', 'requirements', 'sourceUrl', 'status', 'memo'],
    summary: (r) => cycleLabel(r),
  },
  unirounds: {
    label: '전형·마감', fields: ['universityId', 'cycleId', 'track', 'name', 'deadline', 'memo'],
    summary: (r) => [r.track, r.name, r.deadline].filter(Boolean).join(' '),
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
  hopeUnis: '희망 대학·특례', focusArea: '집중 과목·관리 영역', recommenders: '추천서 진행', onlineCourse: '온라인 코스 진행',
  meetingUrl: '미팅 회의록 링크', reply: '학생·학부모 답변', replyDate: '답변 날짜', replyFrom: '답변한 사람', kind: '종류', fromWho: '보낸 사람', channel: '연락 경로', receivedDate: '받은 날짜', answer: '우리 답변·처리', answerDate: '우리 답변 날짜',
  site: '사이트', loginId: '아이디', password: '비밀번호',
  parentNote: '부모님 전달·대화 내용', writer: '작성자', topic: '안건', nextStep: '다음 계획', needsReview: '확인 필요',
  field: '계열', source: '제안·계기', reason: '이유', parentConfirmed: '부모님 확정', parentConfirmedAt: '부모님 확정일',
  parentConfirmedBy: '부모님 확정 기록자', city: '도시', gradeFrom: '시작 학년', gradeTo: '마지막 학년', startDate: '시작일',
  endDate: '종료일', schoolYear: '학년도', level: '레벨', termType: '학기 구분', g1: '1학기/T1 성적', g2: '2학기/T2 성적',
  g3: 'T3 성적', final: '최종 성적',
  nextDate: '다음 미팅 날짜', meetingId: '미팅', noteId: '상담기록', contentHtml: '내용 서식', item: '항목',
};
/** 관리자/관리팀만 다룰 수 있는 테이블 */
const MANAGER_ONLY = ['notes', 'contracts', 'payments'];
/** 컨설턴트에게 숨기는 계약 필드 */
const HIDDEN_FOR_CONSULTANT = { contracts: ['amount', 'paid', 'currency', 'payDue'], meetings: ['parentNote'] };

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
  ensureColumns(db, 'majorplans', ['parentConfirmedAt', 'parentConfirmedBy']);
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
  ensureColumns(db, 'files', ['mime', 'size', 'storedName', 'docId', 'meetingId', 'followupId']);
  ensureColumns(db, 'docs', ['receivedAt', 'receivedBy']);
  ensureColumns(db, 'contracts', ['paid']); // 이전 버전 열 (새 버전은 입금 기록으로 계산)
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  ensureColumns(db, 'teachers', ['notify']); // '' = 이메일 알림 받음, 'off' = 안 받음
  ensureColumns(db, 'teachers', ['homeLayout']); // 메인 화면 배치(JSON). '' = 관리자가 정한 기본 배치
  // v10: 팔로업 요청(휴무 등으로 다른 선생님에게 부탁), 대학 자료 파일
  ensureColumns(db, 'followups', ['requestedBy', 'requestedAt', 'requestNote']);
  db.exec('CREATE TABLE IF NOT EXISTS unifiles (id TEXT PRIMARY KEY)');
  ensureColumns(db, 'unifiles', ['universityId', 'cycleId', 'category', 'name', 'memo', 'mime', 'size', 'storedName', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']);
  // v11: 업로드 파일을 구글 드라이브에 하나씩 백업한 기록 (storedName 기준)
  db.exec("CREATE TABLE IF NOT EXISTS filesync (storedName TEXT PRIMARY KEY, syncedAt TEXT NOT NULL DEFAULT '', fails INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', at TEXT NOT NULL DEFAULT '')");
  // v10: 계약 시작·종료를 날짜로 (기존 연월은 시작=1일, 종료=그 달 마지막 날)
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v10_contract_dates'").get()) {
    db.prepare("UPDATE contracts SET startDate = substr(startMonth, 1, 7) || '-01' WHERE startDate = '' AND startMonth GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]*'").run();
    db.prepare("UPDATE contracts SET endDate = date(substr(endMonth, 1, 7) || '-01', '+1 month', '-1 day') WHERE endDate = '' AND endMonth GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]*'").run();
    db.prepare("INSERT INTO meta VALUES ('v10_contract_dates', ?)").run(now());
  }
  // v8: 미팅 "시간" 칸에 잘못 들어간 긴 글(회의록 가져오기 때 양식 밖 메모)을 본문으로 옮김
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v8_meeting_time'").get()) {
    db.prepare("SELECT id, time, content FROM meetings WHERE length(time) > 30").all().forEach((m) => {
      db.prepare("UPDATE meetings SET time = '', content = ? WHERE id = ?")
        .run([m.content, '[추가 메모 — 원본 시트의 양식 밖에 적혀 있던 글]\n' + m.time].filter(Boolean).join('\n\n'), m.id);
    });
    db.prepare("INSERT INTO meta VALUES ('v8_meeting_time', ?)").run(now());
  }
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
  db.exec('CREATE TABLE IF NOT EXISTS options (id TEXT PRIMARY KEY)');
  ensureColumns(db, 'options', ['kind', 'value', 'sortOrder', 'url', 'category', 'color', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']);
  // v11: 달력 일정 분류·색을 목록으로 / 대회·프로그램 정보 (모두가 함께 쓰는 자료)
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v11_evcats'").get()) {
    const ts = now();
    DEFAULT_EVCATS.forEach(([v, c], i) => {
      if (db.prepare("SELECT 1 FROM options WHERE kind = 'evcat' AND value = ?").get(v)) return;
      db.prepare('INSERT INTO options (id, kind, value, sortOrder, color, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), 'evcat', v, String(i + 1), c, ts, 'system', ts, 'system');
    });
    db.prepare("INSERT INTO meta VALUES ('v11_evcats', ?)").run(ts);
  }
  db.exec('CREATE TABLE IF NOT EXISTS programs (id TEXT PRIMARY KEY)');
  ensureColumns(db, 'programs', ['name', 'category', 'target', 'schedule', 'deadline', 'url', 'memo', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']);
  // v9: 메인 화면 공용 달력 (SAT 시험일 등 모두가 함께 보는 일정)
  db.exec('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY)');
  ensureColumns(db, 'events', ['date', 'endDate', 'title', 'category', 'memo', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']);
  db.exec('CREATE INDEX IF NOT EXISTS events_date ON events(date)');
  // v7: 자주 쓰는 사이트를 목록으로
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v7_sites'").get()) {
    const ts = now();
    DEFAULT_SITES.forEach(([v, c, u], i) => {
      if (db.prepare("SELECT 1 FROM options WHERE kind = 'site' AND value = ?").get(v)) return;
      db.prepare('INSERT INTO options (id, kind, value, sortOrder, url, category, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), 'site', v, String(i + 1), u, c, ts, 'system', ts, 'system');
    });
    db.prepare("INSERT INTO meta VALUES ('v7_sites', ?)").run(ts);
  }
  // v6: 학교·커리큘럼 목록 초기값 = 기본 커리큘럼 + 지금 학생들에게 입력된 값
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v6_options'").get()) {
    const ts = now();
    const add = (kind, value) => {
      value = String(value || '').trim();
      if (!value || db.prepare('SELECT 1 FROM options WHERE kind = ? AND value = ?').get(kind, value)) return;
      db.prepare('INSERT INTO options (id, kind, value, sortOrder, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), kind, value, '', ts, 'system', ts, 'system');
    };
    DEFAULT_CURRICULA.forEach((v) => add('curriculum', v));
    db.prepare("SELECT DISTINCT curriculum v FROM students WHERE deletedAt = '' ORDER BY 1").all().forEach((r) => add('curriculum', r.v));
    db.prepare("SELECT DISTINCT school v FROM students WHERE deletedAt = '' ORDER BY 1").all().forEach((r) => add('school', r.v));
    db.prepare("INSERT INTO meta VALUES ('v6_options', ?)").run(ts);
  }
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
  const filesDir = path.resolve(opts.filesDir || path.join(path.dirname(dbPath), 'files')); // 파일 보내기(sendFile)는 절대 경로가 필요
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
      db.prepare('INSERT INTO teachers (email, name, role, active, passwordHash, mustChangePassword, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)')
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
      me: { email: me.email, name: me.name, role: me.role, mustChangePassword: !!me.mustChangePassword,
        homeLayout: parseLayout((db.prepare('SELECT homeLayout FROM teachers WHERE email = ?').get(me.email) || {}).homeLayout) },
      homeDefault: parseLayout(getMeta('homeLayoutDefault')),
      teachers: db.prepare('SELECT email, name, role, active, notify FROM teachers ORDER BY name').all()
        .map((t) => ({ email: t.email, name: t.name, role: t.role, active: !!t.active, notify: t.notify !== 'off' })),
      students,
      serverTime: now(),
    };
    if (isManager(me)) {
      const st = storageSummary();
      if (st.pct >= 80 || st.lowDisk) out.storageAlert = { pct: st.pct, used: st.used, limit: st.limit, lowDisk: st.lowDisk, free: st.disk && st.disk.free };
    }
    if (me.role === 'admin') {
      const failed = ['backup', 'filesync'].filter((k) => /^실패/.test(getMeta('run.' + k + '.result')));
      if (failed.length) out.backupAlert = failed.map((k) => ({ kind: k, at: getMeta('run.' + k + '.at'), result: getMeta('run.' + k + '.result') }));
    }
    for (const t of CHILD_TABLES) {
      if (MANAGER_ONLY.includes(t) && t !== 'contracts' && !isManager(me)) { out[t] = []; continue; }
      out[t] = db.prepare(`SELECT * FROM ${t} WHERE deletedAt = ''`).all()
        .filter((r) => ids.has(r.studentId)).map((r) => publicRow(t, r, me));
    }
    out.options = db.prepare('SELECT id, kind, value, sortOrder, url, category, color FROM options').all();
    out.programs = db.prepare('SELECT * FROM programs ORDER BY name').all();
    out.events = db.prepare('SELECT * FROM events ORDER BY date, title').all();
    out.unifiles = db.prepare('SELECT id, universityId, cycleId, category, name, memo, mime, size, createdAt, createdBy FROM unifiles ORDER BY createdAt DESC').all();
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

  function validate(table, rec, cur, opts) {
    const v = (k) => (k in rec ? rec[k] : cur ? cur[k] : '');
    const need = (k, msg) => { if (!String(v(k) || '').trim()) throw new UserError(msg); };
    if (table === 'students') need('name', '학생 이름은 필수입니다.');
    if (table === 'notes' && !String(v('content')).trim() && !String(v('nextAction')).trim() && !(opts && opts.hasFollowups)) {
      throw new UserError('상담 내용을 입력하거나 팔로업을 추가하세요.');
    }
    if (table === 'contracts') {
      for (const k of ['startDate', 'endDate']) if (v(k) && !DATE_RE.test(v(k))) throw new UserError('계약 날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)');
      if (v('startDate') && v('endDate') && v('endDate') < v('startDate')) throw new UserError('계약 종료일이 시작일보다 빠릅니다.');
    }
    if (table === 'meetings' && v('nextDate') && !DATE_RE.test(v('nextDate'))) throw new UserError('다음 미팅 날짜 형식이 올바르지 않습니다.');
    if (table === 'followups') {
      for (const [k, t] of [['meetingId', 'meetings'], ['noteId', 'notes']]) {
        if (!v(k)) continue;
        const r = getRow(t, v(k));
        if (!r || r.studentId !== v('studentId')) throw new UserError('팔로업을 연결할 기록을 찾을 수 없습니다.');
      }
    }
    if (table === 'apps') need('university', '대학명은 필수입니다.');
    if (table === 'contracts') need('kind', '계약 종류(연간/원서)를 선택하세요.');
    if (table === 'scores') need('kind', '시험 종류를 선택하세요.');
    if (table === 'activities') need('name', '활동 이름을 입력하세요.');
    if (table === 'docs') need('name', '서류 이름을 입력하세요.');
    if (table === 'links') { need('url', '링크 주소를 입력하세요.'); checkUrl(v('url')); }
    if (table === 'files') need('name', '파일 이름을 입력하세요.');
    if (table === 'appinfo') { need('item', '항목 이름을 입력하세요. (예: 추천인 1)'); need('content', '내용을 입력하세요.'); }
    if (table === 'followups') {
      need('title', '할 일을 입력하세요.');
      if (v('status') && !FOLLOWUP_STATUS.includes(v('status'))) throw new UserError('상태가 올바르지 않습니다.');
      if (v('due') && !/^\d{4}-\d{2}-\d{2}$/.test(v('due'))) throw new UserError('기한 형식이 올바르지 않습니다.');
      if (!FOLLOWUP_KINDS.includes(v('kind') || '')) throw new UserError('종류가 올바르지 않습니다.');
      if (v('fromWho') && !CONTACT_FROM.includes(v('fromWho'))) throw new UserError('보낸 사람이 올바르지 않습니다.');
      if (v('channel') && !CONTACT_CHANNELS.includes(v('channel'))) throw new UserError('연락 경로가 올바르지 않습니다.');
      for (const k of ['receivedDate', 'answerDate']) if (v(k) && !DATE_RE.test(v(k))) throw new UserError('날짜 형식이 올바르지 않습니다.');
    }
    if (table === 'meetings') {
      need('date', '미팅 날짜를 입력하세요.');
      if (String(v('time') || '').length > 30) throw new UserError('시간은 30자 이내로 입력하세요. (예: PM 3:00) 긴 메모는 미팅 내용에 적어주세요.');
      if (!DATE_RE.test(v('date'))) throw new UserError('미팅 날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)');
      if (v('status') && !MEETING_STATUS.includes(v('status'))) throw new UserError('미팅 상태가 올바르지 않습니다.');
    }
    if (table === 'meetings' || table === 'notes') checkUrl(v('sourceUrl'), '원본 자료 링크');
    if (table === 'accounts') { need('site', '사이트 이름을 입력하세요.'); checkUrl(v('url'), '사이트 주소'); }
    if (table === 'followups' && v('replyDate') && !DATE_RE.test(v('replyDate'))) throw new UserError('답변 날짜 형식이 올바르지 않습니다.');
    if (table === 'students') checkUrl(v('meetingUrl'), '미팅 회의록 링크');
    if (table === 'majorplans') {
      need('major', '전공을 입력하세요.');
      if (v('status') && !MAJOR_STATUS.includes(v('status'))) throw new UserError('상태가 올바르지 않습니다.');
      if (v('date') && !DATE_RE.test(v('date'))) throw new UserError('날짜 형식이 올바르지 않습니다.');
    }
    if (table === 'schools') {
      need('school', '학교 이름을 입력하세요.');
      need('startDate', '시작일(입학·전학 온 날)을 입력하세요.');
      for (const k of ['startDate', 'endDate']) if (v(k) && !DATE_RE.test(v(k))) throw new UserError('날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)');
      if (v('endDate') && v('endDate') < v('startDate')) throw new UserError('종료일이 시작일보다 빠릅니다.');
    }
    if (table === 'courses') {
      need('grade', '학년을 입력하세요.');
      need('subject', '과목 이름을 입력하세요.');
      if (v('termType') && !COURSE_TERMS.includes(v('termType'))) throw new UserError('학기 구분이 올바르지 않습니다.');
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
      rec.round = r.track ? r.track + ' · ' + r.name : r.name;
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
      if ('contentHtml' in obj) {
        // 서식 있는 회의록: 허용한 서식만 남기고, 검색·메일용 일반 글(content)은 여기서 다시 만듦
        const raw = String(obj.contentHtml || '');
        if (raw.length > 400000) throw new UserError('내용이 너무 깁니다. 나눠서 기록해주세요.');
        const html = sanitizeRich(raw);
        rec.content = richToText(html);
        rec.contentHtml = hasFormatting(html) ? html : '';
      }
      if ('counselor' in rec) rec.counselor = lower(rec.counselor);
      // 컨설턴트에게 숨겨진 칸은 새로 쓰거나 고칠 수도 없음
      if (!isManager(me)) (HIDDEN_FOR_CONSULTANT[table] || []).forEach((k) => delete rec[k]);
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
        if (table === 'majorplans' && 'parentConfirmed' in rec && (rec.parentConfirmed === 'TRUE') !== (cur.parentConfirmed === 'TRUE')) {
          rec.parentConfirmedAt = rec.parentConfirmed === 'TRUE' ? t : '';
          rec.parentConfirmedBy = rec.parentConfirmed === 'TRUE' ? me.email : '';
        }
        if (table === 'followups' && 'status' in rec && rec.status !== cur.status) {
          rec.doneAt = rec.status === '완료' ? t : '';
          rec.doneBy = rec.status === '완료' ? me.email : '';
        }
        if ('manager' in rec) rec.manager = lower(rec.manager);
        if ('assignee' in rec) rec.assignee = lower(rec.assignee);
        if (table === 'contracts') contractDates(rec);
        linkUni(table, rec);
        validate(table, rec, cur, arg);
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
          if (!rec.universityId) throw new UserError('대학은 목록에서 선택하세요. 목록에 없으면 관리자에게 대학 추가를 요청하세요.');
        }
        if (table === 'majorplans') {
          if (!rec.status) rec.status = '후보';
          if (!rec.date) rec.date = t.slice(0, 10);
          if (rec.parentConfirmed === 'TRUE') { rec.parentConfirmedAt = t; rec.parentConfirmedBy = me.email; }
        }
        if (table === 'courses' && !rec.termType) rec.termType = COURSE_TERMS[0];
        if (table === 'meetings' && !rec.status) rec.status = rec.date && rec.date < t.slice(0, 10) ? '완료' : '예정';
        if (table === 'followups') {
          if (!rec.status) rec.status = '할 일';
          if (rec.status === '완료') { rec.doneAt = t; rec.doneBy = me.email; }
        }
        if ('manager' in rec) rec.manager = lower(rec.manager);
        if ('assignee' in rec) rec.assignee = lower(rec.assignee);
        if (table === 'contracts') contractDates(rec);
        linkUni(table, rec);
        validate(table, rec, null, arg);
        Object.assign(rec, { id: newId(), createdAt: t, createdBy: me.email, updatedAt: t, updatedBy: me.email });
        if (table === 'notes') rec.author = me.email;
        const keys = Object.keys(rec);
        db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => '@' + k).join(', ')})`).run(rec);
        log(me.email, 'create', table, rec.id, describe(table, rec));
        result = rec.id;
      }
    });
    if (arg.noData) return { savedId: result };
    const data = getAll(me);
    data.savedId = result;
    return data;
  }

  /** 계약: 시작일·종료일(날짜)이 기준, 연월 칸은 함께 맞춤. 연월만 들어오면(가져오기 등) 날짜로 채움 */
  function contractDates(rec) {
    const lastDay = (ym) => { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)); return d.toISOString().slice(0, 10); };
    const ymRe = /^\d{4}-\d{2}/;
    if ('startDate' in rec) rec.startMonth = ymRe.test(rec.startDate) ? rec.startDate.slice(0, 7) : '';
    else if ('startMonth' in rec) rec.startDate = ymRe.test(rec.startMonth) ? rec.startMonth.slice(0, 7) + '-01' : '';
    if ('endDate' in rec) rec.endMonth = ymRe.test(rec.endDate) ? rec.endDate.slice(0, 7) : '';
    else if ('endMonth' in rec) rec.endDate = ymRe.test(rec.endMonth) ? lastDay(rec.endMonth) : '';
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
      if (!Array.isArray(reqs) || reqs.some((x) => !x || typeof x !== 'object')) throw new UserError('공식 지원 요건 형식이 올바르지 않습니다.');
      // 한국 대학: 전형 구분(예: 3년특례, 12년특례, 외국인 전형) — 쉼표로 구분, 요건·마감일이 전형별로 나뉨
      const tracks = String(v('tracks') || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (tracks.some((x) => x.length > 30) || new Set(tracks).size !== tracks.length) throw new UserError('전형 이름은 30자 이내, 중복 없이 입력하세요.');
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
          const rn = after.track ? after.track + ' · ' + after.name : after.name;
          const n = db.prepare("UPDATE apps SET deadline = ?, round = ?, updatedAt = ?, updatedBy = ? WHERE roundId = ? AND deletedAt = '' AND deadlineManual != 'TRUE' AND (deadline != ? OR round != ?)")
            .run(after.deadline, rn, t, me.email, cur.id, after.deadline, rn).changes;
          db.prepare("UPDATE apps SET round = ? WHERE roundId = ? AND deletedAt = '' AND deadlineManual = 'TRUE'").run(rn, cur.id);
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

  /** 전공 후보·계정의 대학 연결 확인 (전공 후보는 대학 이름도 함께 저장) */
  function linkUni(table, rec) {
    if (!['majorplans', 'accounts', 'appinfo'].includes(table) || !('universityId' in rec)) return;
    const u = rec.universityId ? getRow('universities', rec.universityId) : null;
    if (rec.universityId && (!u || u.deletedAt)) throw new UserError('대학 목록에서 대학을 찾을 수 없습니다.');
    if (table === 'majorplans') rec.university = u ? u.name : '';
  }

  /** 학교·커리큘럼·사이트 목록 관리 (관리자·관리팀). 이름을 바꾸면 그 값을 쓰던 학생 정보·계정도 함께 바뀜 */
  function saveOption(me, arg) {
    requireManager(me, '목록 관리');
    const kind = arg && arg.kind;
    if (!OPTION_KINDS[kind]) throw new UserError('알 수 없는 목록입니다.');
    const value = clean(arg.value).trim();
    if (!value) throw new UserError(OPTION_KINDS[kind] + ' 이름을 입력하세요.');
    const dup = db.prepare('SELECT id FROM options WHERE kind = ? AND value = ?').get(kind, value);
    if (dup && dup.id !== arg.id) throw new UserError('이미 있는 ' + OPTION_KINDS[kind] + '입니다.');
    const url = kind === 'site' ? clean(arg.url).trim() : '';
    const category = kind === 'site' ? clean(arg.category).trim() : '';
    if (url) checkUrl(url, '사이트 주소');
    if (category && !ACCOUNT_CATS.includes(category)) throw new UserError('분류가 올바르지 않습니다.');
    const color = kind === 'evcat' ? clean(arg.color).trim() || '#9ca3af' : '';
    if (color && !HEX_COLOR.test(color)) throw new UserError('색을 다시 골라주세요.');
    const t = now();
    let id = arg.id;
    tx(() => {
      if (id) {
        const cur = db.prepare('SELECT * FROM options WHERE id = ?').get(id);
        if (!cur || cur.kind !== kind) throw new UserError('항목을 찾을 수 없습니다. 새로고침 해주세요.', 404);
        db.prepare('UPDATE options SET value = ?, sortOrder = ?, url = ?, category = ?, color = ?, updatedAt = ?, updatedBy = ? WHERE id = ?')
          .run(value, clean(arg.sortOrder !== undefined ? arg.sortOrder : cur.sortOrder), url, category, kind === 'evcat' ? (arg.color === undefined ? cur.color : color) : '', t, me.email, id);
        let n = 0;
        const [tbl, col] = OPTION_TARGET[kind];
        if (cur.value !== value) n = db.prepare(`UPDATE ${tbl} SET ${col} = ? WHERE ${col} = ?`).run(value, cur.value).changes;
        log(me.email, 'update', 'options', id, OPTION_KINDS[kind] + ' ' + cur.value + (cur.value !== value ? ' → ' + value + (n ? ' (' + n + '건 함께 변경)' : '') : ''));
      } else {
        id = newId();
        const so = arg.sortOrder !== undefined ? clean(arg.sortOrder)
          : String((db.prepare('SELECT MAX(CAST(sortOrder AS INTEGER)) n FROM options WHERE kind = ?').get(kind).n || 0) + 1);
        db.prepare('INSERT INTO options (id, kind, value, sortOrder, url, category, color, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, kind, value, so, url, category, color, t, me.email, t, me.email);
        log(me.email, 'create', 'options', id, OPTION_KINDS[kind] + ' ' + value);
      }
    });
    return Object.assign(getAll(me), { savedId: id });
  }
  function removeOption(me, arg) {
    requireManager(me, '목록 관리');
    const cur = db.prepare('SELECT * FROM options WHERE id = ?').get(arg && arg.id);
    if (!cur) throw new UserError('이미 삭제된 항목입니다.', 404);
    db.prepare('DELETE FROM options WHERE id = ?').run(cur.id);
    log(me.email, 'delete', 'options', cur.id, (OPTION_KINDS[cur.kind] || cur.kind) + ' ' + cur.value + (cur.kind === 'evcat' ? ' (이 분류의 기존 일정은 회색으로 표시)' : ' (학생 정보의 기존 값은 그대로)'));
    return getAll(me);
  }

  /** 대회·프로그램 정보 (학생에게 자주 권하는 에세이 대회·서머 프로그램 등): 누구나 추가·수정, 삭제는 등록자·관리팀 */
  function saveProgram(me, arg) {
    arg = arg || {};
    const rec = {};
    ['name', 'category', 'target', 'schedule', 'deadline', 'url', 'memo'].forEach((k) => { rec[k] = clean(arg[k]).trim(); });
    if (!rec.name) throw new UserError('이름을 입력하세요.');
    if (rec.deadline && !DATE_RE.test(rec.deadline)) throw new UserError('마감일 형식이 올바르지 않습니다. (YYYY-MM-DD)');
    checkUrl(rec.url, '홈페이지 주소');
    const t = now();
    let id = arg.id;
    tx(() => {
      if (id) {
        const cur = getRow('programs', id);
        if (!cur) throw new UserError('다른 선생님이 이미 삭제했습니다. 새로고침 해주세요.', 409);
        if (arg.updatedAt && arg.updatedAt !== cur.updatedAt) {
          const who = getTeacher(cur.updatedBy);
          throw new UserError('그 사이 ' + (who ? who.name : cur.updatedBy) + ' 님이 먼저 수정했습니다. 새로고침 후 다시 입력해주세요.', 409);
        }
        db.prepare('UPDATE programs SET name=@name, category=@category, target=@target, schedule=@schedule, deadline=@deadline, url=@url, memo=@memo, updatedAt=@t, updatedBy=@me WHERE id=@id')
          .run(Object.assign({}, rec, { t, me: me.email, id }));
        log(me.email, 'update', 'programs', id, rec.name);
      } else {
        id = newId();
        db.prepare('INSERT INTO programs (id, name, category, target, schedule, deadline, url, memo, createdAt, createdBy, updatedAt, updatedBy) VALUES (@id,@name,@category,@target,@schedule,@deadline,@url,@memo,@t,@me,@t,@me)')
          .run(Object.assign({}, rec, { t, me: me.email, id }));
        log(me.email, 'create', 'programs', id, rec.name);
      }
    });
    return Object.assign(getAll(me), { savedId: id });
  }
  function removeProgram(me, arg) {
    const cur = getRow('programs', arg && arg.id);
    if (!cur) throw new UserError('이미 삭제되었습니다.', 404);
    if (cur.createdBy !== me.email && !isManager(me)) throw new UserError('등록한 사람이나 관리자·관리팀만 지울 수 있습니다.', 403);
    db.prepare('DELETE FROM programs WHERE id = ?').run(cur.id);
    log(me.email, 'delete', 'programs', cur.id, cur.name + [cur.category, cur.url, cur.schedule, cur.memo].filter(Boolean).map((x) => ' · ' + x.slice(0, 200)).join(''));
    return getAll(me);
  }

  /** 공용 달력 일정: 누구나 추가, 수정·삭제는 등록한 사람 또는 관리자·관리팀 */
  function eventLabel(r) { return r.date + (r.endDate && r.endDate !== r.date ? '~' + r.endDate : '') + ' ' + r.title; }
  function saveEvent(me, arg) {
    arg = arg || {};
    const rec = {
      date: clean(arg.date).trim(), endDate: clean(arg.endDate).trim(), title: clean(arg.title).trim().slice(0, 200),
      category: clean(arg.category).trim(), memo: clean(arg.memo).trim(),
    };
    if (!rec.title) throw new UserError('일정 이름을 입력하세요.');
    if (!DATE_RE.test(rec.date)) throw new UserError('날짜를 YYYY-MM-DD 형식으로 입력하세요.');
    if (rec.endDate && !DATE_RE.test(rec.endDate)) throw new UserError('끝나는 날짜를 YYYY-MM-DD 형식으로 입력하세요.');
    if (rec.endDate && rec.endDate < rec.date) throw new UserError('끝나는 날짜가 시작 날짜보다 빠릅니다.');
    if (rec.endDate === rec.date) rec.endDate = '';
    const known = rec.category && db.prepare("SELECT 1 FROM options WHERE kind = 'evcat' AND value = ?").get(rec.category);
    const same = arg.id && rec.category === (getRow('events', arg.id) || {}).category;
    if (rec.category && !known && !same) throw new UserError('분류가 올바르지 않습니다. 목록 관리 › 일정 분류에 있는 것만 고를 수 있습니다.');
    const t = now();
    let id = arg.id;
    tx(() => {
      if (id) {
        const cur = getRow('events', id);
        if (!cur) throw new UserError('다른 선생님이 이미 삭제한 일정입니다. 새로고침 해주세요.', 409);
        if (cur.createdBy !== me.email && !isManager(me)) throw new UserError('일정은 등록한 사람이나 관리자·관리팀만 고칠 수 있습니다.', 403);
        if (arg.updatedAt && arg.updatedAt !== cur.updatedAt) {
          const who = getTeacher(cur.updatedBy);
          throw new UserError('그 사이 ' + (who ? who.name : cur.updatedBy) + ' 님이 먼저 수정했습니다. 새로고침 후 다시 입력해주세요.', 409);
        }
        db.prepare('UPDATE events SET date=?, endDate=?, title=?, category=?, memo=?, updatedAt=?, updatedBy=? WHERE id=?')
          .run(rec.date, rec.endDate, rec.title, rec.category, rec.memo, t, me.email, id);
        log(me.email, 'update', 'events', id, eventLabel(rec));
      } else {
        id = newId();
        db.prepare('INSERT INTO events (id, date, endDate, title, category, memo, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(id, rec.date, rec.endDate, rec.title, rec.category, rec.memo, t, me.email, t, me.email);
        log(me.email, 'create', 'events', id, eventLabel(rec));
      }
    });
    return Object.assign(getAll(me), { savedId: id });
  }
  function removeEvent(me, arg) {
    const cur = getRow('events', arg && arg.id);
    if (!cur) throw new UserError('이미 삭제된 일정입니다.', 404);
    if (cur.createdBy !== me.email && !isManager(me)) throw new UserError('일정은 등록한 사람이나 관리자·관리팀만 지울 수 있습니다.', 403);
    db.prepare('DELETE FROM events WHERE id = ?').run(cur.id);
    log(me.email, 'delete', 'events', cur.id, eventLabel(cur) + (cur.memo ? ' — ' + cur.memo.slice(0, 200) : ''));
    return getAll(me);
  }


  /** 미팅·상담기록 저장 + 거기서 나온 팔로업을 한 번에 (팔로업에는 어느 기록에서 나왔는지 연결) */
  function saveWithFollowups(me, arg) {
    const table = arg && arg.table;
    if (!['meetings', 'notes'].includes(table)) throw new UserError('팔로업을 함께 저장할 수 없는 항목입니다.');
    const fus = ((arg && arg.followups) || []).filter((f) => f && String(f.title || '').trim());
    if (fus.length > 30) throw new UserError('팔로업은 한 번에 30개까지 추가할 수 있습니다.');
    let id;
    tx(() => {
      id = save(me, { table, obj: arg.obj || {}, noData: true, hasFollowups: fus.length > 0 }).savedId;
      const rec = getRow(table, id);
      for (const f of fus) {
        save(me, { table: 'followups', noData: true, obj: { studentId: rec.studentId, title: f.title, assignee: f.assignee === undefined ? me.email : f.assignee, due: f.due || '',
          category: f.category || '', status: '할 일', [table === 'meetings' ? 'meetingId' : 'noteId']: id } });
      }
    });
    return Object.assign(getAll(me), { savedId: id });
  }

  /** 팔로업을 다른 선생님에게 요청(담당자 변경 + 누가 왜 요청했는지 기록) → 메일은 server.js 에서 */
  function requestFollowup(me, arg) {
    const f = getRow('followups', arg && arg.id);
    if (!f || f.deletedAt) throw new UserError('팔로업을 찾을 수 없습니다. 새로고침 해주세요.', 404);
    const s = requireStudent(me, f.studentId);
    if (f.status === '완료') throw new UserError('이미 완료된 팔로업입니다.');
    const to = getTeacher(arg.to);
    if (!to || !to.active) throw new UserError('요청할 선생님을 찾을 수 없습니다.');
    if (to.email === f.assignee) throw new UserError('이미 ' + to.name + ' 님이 담당입니다.');
    if (!canSeeStudent({ email: to.email, role: to.role }, s)) {
      throw new UserError(to.name + ' 님은 이 학생의 담당 컨설턴트가 아니어서 이 학생을 볼 수 없습니다. 학생의 담당자를 먼저 바꾸거나 다른 분께 요청하세요.');
    }
    if (arg.updatedAt && arg.updatedAt !== f.updatedAt) throw new UserError('그 사이 다른 선생님이 이 팔로업을 수정했습니다. 새로고침 후 다시 요청하세요.', 409);
    const note = clean(arg.note).trim().slice(0, 500);
    const t = now();
    db.prepare('UPDATE followups SET assignee = ?, requestedBy = ?, requestedAt = ?, requestNote = ?, updatedAt = ?, updatedBy = ? WHERE id = ?')
      .run(to.email, me.email, t, note, t, me.email, f.id);
    log(me.email, 'update', 'followups', f.id, s.name + ' · ' + f.title + ' — ' + to.name + ' 님에게 요청' + (note ? ' (' + note + ')' : ''));
    return Object.assign(getAll(me), { request: { to: to.email, toName: to.name, notify: to.notify !== 'off', from: me.name, student: s.name, studentId: s.id,
      title: f.title, due: f.due, note } });
  }

  /** 목록 순서 저장 (드래그): 학교·커리큘럼·사이트 = 관리자·관리팀, 대학 = 관리자 */
  function saveOrder(me, arg) {
    const ids = (arg && arg.ids) || [];
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000) throw new UserError('순서를 저장할 항목이 없습니다.');
    const t = now();
    if (arg.kind === 'universities') {
      requireAdmin(me, '대학 순서 변경');
      tx(() => ids.forEach((id, i) => db.prepare('UPDATE universities SET sortOrder = ?, updatedAt = ?, updatedBy = ? WHERE id = ?').run(String(i + 1), t, me.email, String(id))));
      log(me.email, 'update', 'universities', '', '대학 순서 변경 (' + ids.length + '곳)');
    } else {
      requireManager(me, '목록 관리');
      if (!OPTION_KINDS[arg.kind]) throw new UserError('알 수 없는 목록입니다.');
      tx(() => ids.forEach((id, i) => db.prepare('UPDATE options SET sortOrder = ?, updatedAt = ?, updatedBy = ? WHERE id = ? AND kind = ?').run(String(i + 1), t, me.email, String(id), arg.kind)));
      log(me.email, 'update', 'options', '', OPTION_KINDS[arg.kind] + ' 순서 변경');
    }
    return getAll(me);
  }

  /* ----- 대학 자료 파일 (모집요강 등, 입학 연도별) ----- */
  const UNIFILE_CATS = ['모집요강', '공식 안내', '기타 자료'];
  function addUniFile(me, info) {
    const c = getRow('unicycles', info.cycleId);
    if (!c || c.deletedAt) throw new UserError('입학 연도 정보를 찾을 수 없습니다. 새로고침 해주세요.', 404);
    const u = requireUni(c.universityId);
    const name = String(info.name || '').replace(/[\\/\r\n]/g, '_').trim().slice(0, 200);
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1];
    const type = ext && UPLOAD_TYPES[ext.toLowerCase()];
    if (!type) throw new UserError('올릴 수 없는 파일 형식입니다. (PDF, 이미지, 워드, 엑셀, 한글 파일만 가능)');
    if (!info.buffer || !info.buffer.length) throw new UserError('빈 파일입니다.');
    if (info.buffer.length > MAX_UPLOAD) throw new UserError('파일은 20MB 이하만 올릴 수 있습니다.');
    const category = UNIFILE_CATS.includes(info.category) ? info.category : (u.country === '한국' ? '모집요강' : '기타 자료');
    const id = newId(), storedName = id + '.' + ext.toLowerCase(), t = now();
    const full = path.join(filesDir, storedName);
    fs.writeFileSync(full, info.buffer);
    try {
      db.prepare('INSERT INTO unifiles (id, universityId, cycleId, category, name, memo, mime, size, storedName, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, u.id, c.id, category, name, '', type, String(info.buffer.length), storedName, t, me.email, t, me.email);
      log(me.email, 'upload', 'unifiles', id, u.name + ' · ' + cycleLabel(c) + ' · ' + category + ' · ' + name);
    } catch (e) {
      fs.rm(full, { force: true }, () => {});
      throw e;
    }
    return getAll(me);
  }
  function getUniFile(me, id) {
    const f = getRow('unifiles', id);
    if (!f) throw new UserError('파일을 찾을 수 없습니다.', 404);
    return { path: path.join(filesDir, f.storedName), name: f.name, mime: f.mime || 'application/octet-stream' };
  }
  function saveUniFile(me, arg) {
    const f = getRow('unifiles', arg && arg.id);
    if (!f) throw new UserError('파일을 찾을 수 없습니다. 새로고침 해주세요.', 404);
    if (f.createdBy !== me.email && !isManager(me)) throw new UserError('올린 사람이나 관리자·관리팀만 고칠 수 있습니다.', 403);
    const category = UNIFILE_CATS.includes(arg.category) ? arg.category : f.category;
    const memo = clean(arg.memo).trim().slice(0, 500);
    db.prepare('UPDATE unifiles SET category = ?, memo = ?, updatedAt = ?, updatedBy = ? WHERE id = ?').run(category, memo, now(), me.email, f.id);
    return getAll(me);
  }
  function removeUniFile(me, arg) {
    const f = getRow('unifiles', arg && arg.id);
    if (!f) throw new UserError('이미 삭제된 파일입니다.', 404);
    if (f.createdBy !== me.email && !isManager(me)) throw new UserError('올린 사람이나 관리자·관리팀만 지울 수 있습니다.', 403);
    db.prepare('DELETE FROM unifiles WHERE id = ?').run(f.id);
    fs.rm(path.join(filesDir, f.storedName), { force: true }, () => {});
    const u = getRow('universities', f.universityId);
    log(me.email, 'delete', 'unifiles', f.id, (u ? u.name + ' · ' : '') + f.category + ' · ' + f.name);
    return getAll(me);
  }

  /** 학생 정보에 쓰인 학교·커리큘럼이 목록에 없으면 목록에 추가 */
  function addOptionsFor(rec, me, t) {
    for (const kind of ['school', 'curriculum']) {
      const v = String(rec[kind] || '').trim();
      if (v && !db.prepare('SELECT 1 FROM options WHERE kind = ? AND value = ?').get(kind, v)) {
        db.prepare('INSERT INTO options (id, kind, value, sortOrder, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?)')
          .run(newId(), kind, v, '', t, me.email, t, me.email);
      }
    }
  }

  /** 선생님 계정 삭제 (관리자). 담당으로 지정된 학생·팔로업은 "미정"으로 바뀜 */
  function deleteTeacher(me, arg) {
    requireAdmin(me, '계정 삭제');
    const email = lower(arg && arg.email);
    const found = getTeacher(email);
    if (!found) throw new UserError('계정을 찾을 수 없습니다.', 404);
    if (email === me.email) throw new UserError('본인 계정은 삭제할 수 없습니다.');
    let n = 0;
    tx(() => {
      n += db.prepare("UPDATE students SET counselor = '' WHERE lower(counselor) = ?").run(email).changes;
      n += db.prepare("UPDATE students SET manager = '' WHERE lower(manager) = ?").run(email).changes;
      db.prepare("UPDATE followups SET assignee = '' WHERE assignee = ?").run(email);
      db.prepare('DELETE FROM sessions WHERE email = ?').run(email);
      db.prepare('DELETE FROM teachers WHERE email = ?').run(email);
      log(me.email, 'delete', 'teachers', email, found.name + ' · ' + email + (n ? ' — 담당 ' + n + '건을 미정으로 변경' : ''));
    });
    return getAll(me);
  }

  /** 같은 종류 항목 여러 건을 한 번에 저장 (전부 성공하거나 전부 취소) */
  function saveMany(me, arg) {
    const table = arg && arg.table;
    const objs = (arg && arg.objs) || [];
    if (!['courses'].includes(table)) throw new UserError('여러 건 저장을 지원하지 않는 항목입니다.');
    if (!Array.isArray(objs) || !objs.length) throw new UserError('저장할 항목이 없습니다.');
    if (objs.length > 60) throw new UserError('한 번에 60건까지만 저장할 수 있습니다.');
    const ids = [];
    tx(() => { for (const obj of objs) ids.push(save(me, { table, obj, noData: true }).savedId); });
    return Object.assign(getAll(me), { savedIds: ids });
  }

  /** 내 정보: 이름 변경 */
  function updateMe(me, arg) {
    const name = clean(arg && arg.name).trim();
    if (!name) throw new UserError('이름을 입력하세요.');
    if (name.length > 40) throw new UserError('이름이 너무 깁니다.');
    db.prepare('UPDATE teachers SET name = ?, updatedAt = ? WHERE email = ?').run(name, now(), me.email);
    log(me.email, 'update', 'teachers', me.email, '내 이름 변경: ' + name);
    return getAll(Object.assign({}, me, { name }));
  }

  /* ----- 메인 화면 배치 (계정별, 관리자는 모두의 기본 배치) ----- */
  function parseLayout(v) { try { const x = JSON.parse(v || 'null'); return Array.isArray(x) ? x : null; } catch (e) { return null; } }
  /** [{ id, s: '가로칸x세로칸'(예: 2x3), hide }] 만 받음 */
  function cleanLayout(list) {
    if (!Array.isArray(list) || list.length > 40) throw new UserError('화면 배치 형식이 올바르지 않습니다.');
    const seen = new Set();
    return list.map((x) => {
      const id = String(x && x.id || '');
      if (!/^[a-z]{1,30}$/.test(id) || seen.has(id)) throw new UserError('화면 배치 형식이 올바르지 않습니다.');
      seen.add(id);
      return { id, s: /^[1-4]x[1-6]$/.test(String(x.s)) ? String(x.s) : '', hide: !!x.hide };
    });
  }
  function saveHomeLayout(me, arg) {
    arg = arg || {};
    if (arg.asDefault) {
      requireAdmin(me, '모두의 기본 배치 정하기');
      const v = arg.layout == null ? '' : JSON.stringify(cleanLayout(arg.layout));
      setMeta('homeLayoutDefault', v);
      log(me.email, 'update', 'settings', 'homeLayout', v ? '메인 화면 기본 배치 변경' : '메인 화면 기본 배치를 처음 상태로');
    } else {
      const v = arg.layout == null ? '' : JSON.stringify(cleanLayout(arg.layout));
      db.prepare('UPDATE teachers SET homeLayout = ? WHERE email = ?').run(v, me.email);
    }
    return getAll(me);
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
      const rec = { universityId: src.universityId, year, term, tracks: src.tracks || '', requirements: src.requirements, sourceUrl: src.sourceUrl,
        status: '확인 필요', memo: cycleLabel(src) + ' 정보를 복사해 만든 초안입니다. 마감일은 1년 뒤로 옮긴 추정치이니 공식 요강으로 확인하세요.' };
      validateCatalog('unicycles', rec, null);
      Object.assign(rec, { id: newId(), createdAt: t, createdBy: me.email, updatedAt: t, updatedBy: me.email });
      insert('unicycles', rec);
      newId_ = rec.id;
      const shift = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? (Number(d.slice(0, 4)) + (Number(year) - Number(src.year))) + d.slice(4) : '';
      db.prepare("SELECT * FROM unirounds WHERE cycleId = ? AND deletedAt = ''").all(src.id).forEach((r) => {
        insert('unirounds', { id: newId(), universityId: r.universityId, cycleId: rec.id, track: r.track || '', name: r.name, deadline: shift(r.deadline),
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
    const hidden = isManager(me) ? [] : ['notes', 'contracts', 'payments'];
    if (arg && arg.all) { // 메인 "최근 활동": 볼 수 있는 학생 전체
      const seen = new Map();
      const rows = db.prepare("SELECT at, email, action, tbl, summary, studentId FROM log WHERE studentId != '' ORDER BY id DESC LIMIT 600").all()
        .filter((r) => {
          if (hidden.includes(r.tbl)) return false;
          if (!seen.has(r.studentId)) { const st = getRow('students', r.studentId); seen.set(r.studentId, canSeeStudent(me, st) ? st.name : null); }
          return seen.get(r.studentId) != null;
        }).slice(0, 40);
      rows.forEach((r) => { r.tblLabel = (DEF[r.tbl] && DEF[r.tbl].label) || r.tbl; r.studentName = seen.get(r.studentId); });
      return { rows };
    }
    const s = requireStudent(me, arg && arg.studentId);
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
  function legacyLabel(t) { return { teachers: '선생님 계정', options: '목록(학교·커리큘럼·사이트)', settings: '설정', events: '달력 일정', unifiles: '대학 자료 파일', programs: '대회·프로그램' }[t] || t; }

  /* ----- 파일 ----- */

  function addFile(me, info) {
    const s = requireStudent(me, info.studentId);
    const stored = [];
    try {
      tx(() => { storeFile(me, s, info, stored); });
    } catch (e) {
      stored.forEach((f) => fs.rm(f, { force: true }, () => {}));
      throw e;
    }
    return getAll(me);
  }
  /** 파일 1개 저장 + 기록 (트랜잭션 안에서 호출, 저장한 경로는 stored 에 추가) */
  function storeFile(me, s, info, stored) {
    let doc = null, meeting = null, fu = null;
    if (info.followupId) {
      fu = getRow('followups', info.followupId);
      if (!fu || fu.deletedAt || fu.studentId !== s.id) throw new UserError('팔로업을 찾을 수 없습니다. 새로고침 해주세요.', 404);
    }
    if (info.docId) {
      doc = getRow('docs', info.docId);
      if (!doc || doc.deletedAt || doc.studentId !== s.id) throw new UserError('서류 항목을 찾을 수 없습니다. 새로고침 해주세요.', 404);
    }
    if (info.meetingId) {
      meeting = getRow('meetings', info.meetingId);
      if (!meeting || meeting.deletedAt || meeting.studentId !== s.id) throw new UserError('미팅 기록을 찾을 수 없습니다. 새로고침 해주세요.', 404);
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
    stored.push(path.join(filesDir, storedName));
    const t = now();
    const rec = { id, studentId: s.id, category: doc ? '서류' : meeting ? '미팅' : fu ? '연락' : (clean(info.category) || '성적표'), name, memo: clean(info.memo || ''), mime: type,
      size: String(info.buffer.length), storedName, docId: doc ? doc.id : '', meetingId: meeting ? meeting.id : '', followupId: fu ? fu.id : '',
      createdAt: t, createdBy: me.email, updatedAt: t, updatedBy: me.email };
    const keys = Object.keys(rec);
    db.prepare(`INSERT INTO files (${keys.join(', ')}) VALUES (${keys.map((k) => '@' + k).join(', ')})`).run(rec);
    if (doc) {
      // 서류 파일을 올리면 자동으로 수합 완료 + 받은 날짜/사람 기록
      db.prepare("UPDATE docs SET status = '수합 완료', receivedAt = ?, receivedBy = ?, updatedAt = ?, updatedBy = ? WHERE id = ?")
        .run(t, me.email, t, me.email, doc.id);
    }
    log(me.email, 'upload', 'files', id, s.name + ' · ' + (doc ? doc.name + ' · ' : meeting ? '미팅 ' + meeting.date + ' · ' : fu ? '연락 ' + fu.title.slice(0, 30) + ' · ' : '') + name);
    return rec;
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
    const CHILD_KEYS = ['contracts', 'apps', 'scores', 'docs', 'links', 'notes', 'followups', 'majorplans', 'schools', 'courses', 'accounts', 'meetings'];
    const append = data.mode === 'append'; // 같은 이름의 학생이 있으면 기록만 덧붙임
    const review = data.markReview !== false; // 가져온 상담기록·미팅은 "확인 필요"로 표시
    const teachersByName = {};
    db.prepare('SELECT email, name FROM teachers').all().forEach((t) => { teachersByName[t.name] = t.email; });
    const result = { created: [], skipped: [], appended: [], duplicates: 0 };
    const storedPaths = [];
    try { tx(() => {
      for (const src of data.students) {
        const name = String((src && src.name) || '').trim();
        if (!name) continue;
        const t = now();
        const existing = db.prepare("SELECT * FROM students WHERE name = ? AND deletedAt = ''").get(name);
        if (existing && !append) { result.skipped.push(name); continue; }
        let st = existing;
        if (!st) {
          st = {};
          TABLES.students.fields.forEach((k) => { if (k in src) st[k] = clean(src[k]); });
          if (!st.counselor && src.counselorName && teachersByName[src.counselorName]) st.counselor = teachersByName[src.counselorName];
          st.counselor = lower(st.counselor);
          if (src.appendMemo) st.memo = [st.memo, String(src.appendMemo).trim()].filter(Boolean).join('\n\n');
          validate('students', st, null);
          Object.assign(st, { id: newId(), createdAt: t, createdBy: me.email, updatedAt: t, updatedBy: me.email });
          insert('students', st);
          addOptionsFor(st, me, t);
        }
        let added = 0;
        if (existing) {
          // 덧붙이기: 비어 있는 칸만 채우고, 메모는 같은 글이 없을 때만 이어 붙임
          const fill = {}, changed = [];
          TABLES.students.fields.forEach((k) => {
            if (k === 'name' || k === 'counselor' || k === 'manager' || !(k in src)) return;
            const v = clean(src[k]);
            if (v && !String(existing[k] || '').trim()) { fill[k] = v; changed.push(FIELD_LABELS[k] || k); }
          });
          const memo = String(src.appendMemo || '').trim();
          if (memo && !String(existing.memo || '').includes(memo)) {
            fill.memo = [existing.memo, memo].filter(Boolean).join('\n\n'); changed.push('메모(이어 붙임)');
          }
          if (changed.length) {
            validate('students', fill, existing);
            const keys = Object.keys(fill);
            db.prepare(`UPDATE students SET ${keys.map((k) => k + ' = @' + k).join(', ')}, updatedAt = @updatedAt, updatedBy = @updatedBy WHERE id = @id`)
              .run(Object.assign({}, fill, { id: existing.id, updatedAt: t, updatedBy: me.email }));
            addOptionsFor(fill, me, t);
            log(me.email, 'import', 'students', existing.id, name + ' — 빈 칸 채움: ' + changed.join(', '));
            result.filled = (result.filled || 0) + 1;
          }
        }
        for (const key of CHILD_KEYS) {
          for (const item of (src[key] || [])) {
            const rec = { studentId: st.id };
            TABLES[key].fields.forEach((k) => { if (k !== 'studentId' && item && k in item) rec[k] = clean(item[k]); });
            if (key === 'contracts' && !rec.currency) rec.currency = 'RMB';
            if ((key === 'meetings' || key === 'notes') && review) rec.needsReview = 'TRUE';
            if ((key === 'accounts' || key === 'majorplans') && !rec.universityId && item.university) {
              rec.universityId = findUniByName(item.university);
              if (!rec.universityId) throw new UserError(name + ': 대학 목록에서 "' + item.university + '"을(를) 찾을 수 없습니다.');
            }
            if (key === 'majorplans' && rec.universityId) linkUni(key, rec);
            if (key === 'accounts' && append && db.prepare("SELECT 1 FROM accounts WHERE studentId = ? AND site = ? AND loginId = ? AND deletedAt = ''")
                  .get(st.id, rec.site || '', rec.loginId || '')) { result.duplicates++; continue; }
            if (key === 'schools' && append && db.prepare("SELECT 1 FROM schools WHERE studentId = ? AND school = ? AND startDate = ? AND deletedAt = ''")
                  .get(st.id, rec.school || '', rec.startDate || '')) { result.duplicates++; continue; }
            if (key === 'meetings' && !rec.status) rec.status = rec.date && rec.date < t.slice(0, 10) ? '완료' : '예정';
            // 같은 원본(링크·날짜·시간)에서 이미 가져온 기록은 건너뜀 → 여러 번 가져와도 중복 없음
            if ((key === 'meetings' || key === 'notes') && rec.sourceUrl &&
                db.prepare(`SELECT 1 FROM ${key} WHERE studentId = ? AND sourceUrl = ? AND date = ? AND time = ? AND deletedAt = ''`)
                  .get(st.id, rec.sourceUrl, rec.date || '', rec.time || '')) { result.duplicates++; continue; }
            if (key === 'followups' && append && db.prepare("SELECT 1 FROM followups WHERE studentId = ? AND title = ? AND detail = ? AND deletedAt = ''")
                  .get(st.id, rec.title || '', rec.detail || '')) { result.duplicates++; continue; }
            validate(key, rec, null);
            added++;
            Object.assign(rec, { id: newId(), createdAt: t, createdBy: me.email, updatedAt: t, updatedBy: me.email });
            if (key === 'notes') rec.author = me.email;
            insert(key, rec);
            if (key === 'meetings' && Array.isArray(item.files)) {
              for (const f of item.files) {
                const buffer = Buffer.from(String((f && f.data) || ''), 'base64');
                storeFile(me, st, { name: f.name, memo: f.memo, buffer, meetingId: rec.id }, storedPaths);
                result.files = (result.files || 0) + 1;
              }
            }
          }
        }
        log(me.email, 'import', 'students', st.id, name + (existing ? ' — 기록 ' + added + '건 추가' : ''));
        if (existing) result.appended.push(name + ' (' + added + '건)'); else result.created.push(name);
      }
      linkAppsByName(db);
    }); } catch (e) {
      storedPaths.forEach((f) => fs.rm(f, { force: true }, () => {}));
      throw e;
    }
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
        if ('notify' in obj) db.prepare('UPDATE teachers SET notify=? WHERE email=?').run(obj.notify === false ? 'off' : '', email);
        if (password) {
          db.prepare('UPDATE teachers SET passwordHash=?, mustChangePassword=0 WHERE email=?').run(hashPassword(password), email);
        }
        // 비활성화·비밀번호 초기화·역할 변경 시 기존 로그인 즉시 해제
        if (!active || password || role !== found.role) db.prepare('DELETE FROM sessions WHERE email = ?').run(email);
      } else {
        if (!password) throw new UserError('새 계정의 비밀번호를 입력하세요 (6자 이상).');
        db.prepare('INSERT INTO teachers (email, name, role, active, passwordHash, mustChangePassword, createdAt, updatedAt, notify) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(email, name, role, active, hashPassword(password), 0, t, t, obj.notify === false ? 'off' : '');
      }
      const roleLabel = { admin: '관리자', staff: '관리팀', consultant: '컨설턴트' }[role];
      log(me.email, found ? 'update' : 'create', 'teachers', email,
        [name, email, roleLabel, active ? '활성' : '비활성', password ? (found ? '비밀번호 초기화' : '임시 비밀번호 설정') : '']
          .filter(Boolean).join(' · '));
    });
    return getAll(me);
  }

  async function backup(destPath) { await db.backup(destPath); }

  /* ----- 자동 백업·이메일 알림 설정 (관리자) ----- */
  const CONFIG_KEYS = { scriptUrl: '', secret: '', siteUrl: '', backupOn: '', backupHour: '3', mailOn: '', mailHour: '8', volumeGB: '5' };
  function getConfig() {
    const out = Object.assign({}, CONFIG_KEYS);
    db.prepare("SELECT key, value FROM meta WHERE key LIKE 'cfg.%'").all().forEach((r) => { out[r.key.slice(4)] = r.value; });
    return out;
  }
  function setMeta(key, value) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }
  function getMeta(key) { const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key); return r ? r.value : ''; }
  function getAutomation(me) {
    requireAdmin(me, '자동 백업·알림 설정');
    const status = {};
    ['backup', 'digest', 'filesync'].forEach((k) => { status[k] = { at: getMeta('run.' + k + '.at'), result: getMeta('run.' + k + '.result'), date: getMeta('run.' + k + '.date') }; });
    return { config: getConfig(), status };
  }
  function saveAutomation(me, arg) {
    requireAdmin(me, '자동 백업·알림 설정');
    arg = arg || {};
    const cur = getConfig();
    const next = {};
    if ('scriptUrl' in arg) {
      const u = clean(arg.scriptUrl).trim();
      if (u && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(u)) throw new UserError('Apps Script 주소는 https://script.google.com/macros/s/…/exec 형식이어야 합니다.');
      next.scriptUrl = u;
    }
    if ('siteUrl' in arg) { const u = clean(arg.siteUrl).trim().replace(/\/+$/, ''); if (u) checkUrl(u, '사이트 주소'); next.siteUrl = u; }
    if ('backupOn' in arg) next.backupOn = arg.backupOn ? 'on' : '';
    if ('mailOn' in arg) next.mailOn = arg.mailOn ? 'on' : '';
    if ('volumeGB' in arg) {
      const g = Number(arg.volumeGB);
      if (!Number.isFinite(g) || g < 0.5 || g > 10000) throw new UserError('저장 공간 크기는 0.5~10000 GB 사이 숫자로 입력하세요.');
      next.volumeGB = String(g);
    }
    for (const k of ['backupHour', 'mailHour']) {
      if (k in arg) {
        const h = Number(arg[k]);
        if (!Number.isInteger(h) || h < 0 || h > 23) throw new UserError('시간은 0~23 사이 숫자로 입력하세요.');
        next[k] = String(h);
      }
    }
    if (arg.newSecret || !cur.secret) next.secret = crypto.randomBytes(18).toString('base64url');
    tx(() => {
      Object.keys(next).forEach((k) => setMeta('cfg.' + k, next[k]));
      log(me.email, 'update', 'settings', 'automation', '자동 백업·알림 설정 변경: ' + Object.keys(next).filter((k) => k !== 'secret').concat(next.secret ? ['비밀 키 새로 만듦'] : []).join(', '));
    });
    return getAutomation(me);
  }
  function recordRun(kind, result, date) {
    setMeta('run.' + kind + '.at', now());
    setMeta('run.' + kind + '.result', String(result).slice(0, 500));
    if (date) setMeta('run.' + kind + '.date', date);
  }
  /** 활성 선생님 목록 (알림 대상 계산용) */
  function listTeachers() {
    return db.prepare('SELECT email, name, role, active, notify FROM teachers').all()
      .map((t) => ({ email: t.email, name: t.name, role: t.role, active: !!t.active, notify: t.notify !== 'off' }));
  }
  /** 백업용 전체 파일 목록 (휴지통 포함) */
  function listFiles() {
    return db.prepare(`SELECT f.storedName, f.name, f.category, f.createdAt, f.deletedAt, s.name AS studentName, f.studentId, CAST(f.size AS INTEGER) AS size, f.mime, 'student' AS kind
      FROM files f LEFT JOIN students s ON s.id = f.studentId
      UNION ALL SELECT u.storedName, u.name, u.category, u.createdAt, '' AS deletedAt, IFNULL(v.name, '') || ' (대학 자료)' AS studentName, '' AS studentId, CAST(u.size AS INTEGER) AS size, u.mime, 'uni' AS kind
      FROM unifiles u LEFT JOIN universities v ON v.id = u.universityId ORDER BY 4`).all();
  }

  /* ----- 파일 드라이브 백업 기록 ----- */
  const SYNC_MAX_FAILS = 3; // 같은 파일이 3번 실패하면 건너뛰고 "실패한 파일"로 표시
  function syncRows() {
    const m = {};
    db.prepare('SELECT * FROM filesync').all().forEach((r) => { m[r.storedName] = r; });
    return m;
  }
  /** 아직 드라이브에 안 올라간 파일 (오래된 것부터, 실패 3번 넘은 것 제외) */
  function pendingSync() {
    const m = syncRows();
    return listFiles().filter((f) => f.storedName && !(m[f.storedName] && (m[f.storedName].syncedAt || m[f.storedName].fails >= SYNC_MAX_FAILS)));
  }
  function markSync(storedName, error) {
    const t = now();
    if (error) {
      db.prepare(`INSERT INTO filesync (storedName, fails, error, at) VALUES (?, 1, ?, ?)
        ON CONFLICT(storedName) DO UPDATE SET fails = fails + 1, error = excluded.error, at = excluded.at`).run(storedName, String(error).slice(0, 300), t);
    } else {
      db.prepare(`INSERT INTO filesync (storedName, syncedAt, at) VALUES (?, ?, ?)
        ON CONFLICT(storedName) DO UPDATE SET syncedAt = excluded.syncedAt, error = '', at = excluded.at`).run(storedName, t, t);
    }
  }
  function retrySync(me) {
    requireAdmin(me, '파일 백업 다시 시도');
    db.prepare("UPDATE filesync SET fails = 0, error = '' WHERE syncedAt = ''").run();
    return getStorage(me);
  }

  /* ----- 저장 공간 현황 ----- */
  function sizeOf(p) { try { return fs.statSync(p).size; } catch (e) { return 0; } }
  /** 사용량 요약 (경고 표시용, 가벼운 계산) */
  function storageSummary() {
    const fileBytes = db.prepare('SELECT IFNULL(SUM(CAST(size AS INTEGER)), 0) AS n FROM files').get().n + db.prepare('SELECT IFNULL(SUM(CAST(size AS INTEGER)), 0) AS n FROM unifiles').get().n;
    const dbBytes = sizeOf(dbPath) + sizeOf(dbPath + '-wal');
    const limit = Math.round(Number(getConfig().volumeGB || 5) * 1024 * 1024 * 1024);
    let disk = null;
    try {
      const st = fs.statfsSync(filesDir);
      disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
    } catch (e) { /* 지원하지 않는 환경 */ }
    const used = fileBytes + dbBytes;
    // 경고 기준은 "Compass 데이터 ÷ 설정한 볼륨 크기". 서버가 보는 디스크 수치는 환경마다 다르게 나와서(예약 공간 등) 참고만 하고,
    // 실제로 남은 공간이 500MB 아래로 떨어졌을 때만 따로 경고
    const lowDisk = !!(disk && disk.total && disk.free < 500 * 1024 * 1024);
    return { used, fileBytes, dbBytes, limit, disk, lowDisk, pct: Math.round(used / limit * 1000) / 10 };
  }
  function getStorage(me) {
    requireAdmin(me, '저장 공간 보기');
    const all = listFiles(), m = syncRows();
    const sum = (list) => list.reduce((a, f) => a + (f.size || 0), 0);
    const live = all.filter((f) => f.kind === 'student' && !f.deletedAt), trash = all.filter((f) => f.deletedAt), uni = all.filter((f) => f.kind === 'uni');
    const byStudent = {};
    live.forEach((f) => { const x = byStudent[f.studentId] || (byStudent[f.studentId] = { studentId: f.studentId, name: f.studentName || '(삭제된 학생)', count: 0, bytes: 0 }); x.count++; x.bytes += f.size || 0; });
    const byCat = {};
    live.forEach((f) => { const k = f.category || '기타'; const x = byCat[k] || (byCat[k] = { category: k, count: 0, bytes: 0 }); x.count++; x.bytes += f.size || 0; });
    const top = (list, n) => list.sort((a, b) => b.bytes - a.bytes).slice(0, n);
    const synced = all.filter((f) => m[f.storedName] && m[f.storedName].syncedAt);
    const failed = all.filter((f) => m[f.storedName] && !m[f.storedName].syncedAt && m[f.storedName].fails >= SYNC_MAX_FAILS);
    const pending = pendingSync();
    return {
      summary: storageSummary(), volumeGB: getConfig().volumeGB,
      students: { count: live.length, bytes: sum(live) }, trash: { count: trash.length, bytes: sum(trash) }, uni: { count: uni.length, bytes: sum(uni) },
      byStudent: top(Object.values(byStudent), 10), byCategory: top(Object.values(byCat), 20),
      largest: all.slice().sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 10)
        .map((f) => ({ name: f.name, studentName: f.studentName, studentId: f.studentId, category: f.category, size: f.size || 0, deleted: !!f.deletedAt, createdAt: f.createdAt })),
      sync: {
        total: all.length, done: synced.length, pending: pending.length, pendingBytes: sum(pending),
        failed: failed.map((f) => ({ name: f.name, studentName: f.studentName, size: f.size || 0, error: m[f.storedName].error })),
        lastError: (pending.map((f) => m[f.storedName]).filter((r) => r && r.error)[0] || {}).error || '',
        status: { at: getMeta('run.filesync.at'), result: getMeta('run.filesync.result') },
      },
    };
  }

  return {
    db, filesDir, listFiles, pendingSync, markSync, countTeachers, upsertAdmin, login, logout, authenticate, addFile, getFile, addUniFile, getUniFile,
    rpc: { getAll: (me) => getAll(me), save, remove, restore, purge, getTrash, getLog, saveTeacher, changePassword, importData, copyCycle, getActivity, saveMany, updateMe,
      saveOption, removeOption, deleteTeacher, getAutomation, saveAutomation, saveEvent, removeEvent,
      saveWithFollowups, requestFollowup, saveOrder, saveUniFile, removeUniFile, saveProgram, removeProgram, getStorage, retrySync, saveHomeLayout },
    backup, getConfig, getMeta, recordRun, listTeachers, close: () => db.close(),
  };
}

module.exports = { openStore, UserError, MAX_UPLOAD };
