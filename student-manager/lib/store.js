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
const { sanitizeRich, richToText, hasFormatting, sanitizeDoc } = require('./rich');
const { DEFAULT_TEMPLATES } = require('./contract-template');
const { DEFAULT_PRICES } = require('./pricelist');
const appforms = require('./appforms');
const schedule = require('./schedule');
const fs = require('fs');
const path = require('path');

class UserError extends Error {
  constructor(message, status) { super(message); this.status = status || 400; }
}

const ROLES = ['admin', 'staff', 'consultant', 'developer']; // developer: 관리자 권한 + 다른 계정으로 로그인 (개발·점검용)
/** 지점: 계정·학생마다 하나. 화면 시간은 계정 지점의 시간대로 보임 (첫 번째 = 예전 자료의 기본값) */
const BRANCHES = ['상해', '압구정'];
const BRANCH_TZ = { 상해: 'Asia/Shanghai', 압구정: 'Asia/Seoul' };
/** 고를 수 있는 시간대 = 목록 관리 › 시간대 (처음 목록은 아래 6개, 지점 시간대 2개는 늘 포함). 서머타임은 자동 */
const DEFAULT_TZS = [['중국', 'Asia/Shanghai', '상해·홍콩·싱가포르'], ['한국', 'Asia/Seoul', '서울·도쿄'], ['미국 동부', 'America/New_York', '뉴욕·보스턴·토론토'],
  ['미국 서부', 'America/Los_Angeles', 'LA·샌프란시스코·밴쿠버'], ['영국', 'Europe/London', '런던'], ['호주 동부', 'Australia/Sydney', '시드니·멜버른']];
const TZS = DEFAULT_TZS.map((z) => z[1]); // 저장소를 열 때·시간대 목록을 바꿀 때 DB 목록으로 다시 채움
/** 세계 시간대 이름(IANA, 예: Europe/Paris)인지 */
function isRealTz(z) { if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(z || '')) return false; try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch (e) { return false; } }
const branchOf = (x) => (x && BRANCHES.includes(x.branch) ? x.branch : BRANCHES[0]);
/** 계정 지점: 상해·압구정 + 전체(지점 구분 없음 — 원장님처럼 두 지점을 모두 맡는 계정). 전체 계정의 화면 시간은 계정에서 고른 나라 */
const ALL_BRANCH = '전체';
const ACCOUNT_BRANCHES = BRANCHES.concat([ALL_BRANCH]);
const accountBranch = (t) => (t && ACCOUNT_BRANCHES.includes(t.branch) ? t.branch : BRANCHES[0]);
const branchTz = (t) => (accountBranch(t) === ALL_BRANCH ? (TZS.includes(t.tz) ? t.tz : BRANCH_TZ[BRANCHES[0]]) : BRANCH_TZ[accountBranch(t)]);
/** 화면 시간: My Page에서 직접 고른 시간(출장 등)이 있으면 그것, 없으면 지점 기준 */
const accountTz = (t) => (t && TZS.includes(t.viewTz) ? t.viewTz : branchTz(t));
/** 다른 지점 학생에게 관리팀이 할 수 있는 것: 팔로업·답변·상담기록 추가 (학생 정보 수정은 그 지점 관리팀·관리자) */
const CROSS_BRANCH_TABLES = ['followups', 'fureplies', 'notes'];

/** 테이블별 입력 가능한 필드 */
const TABLES = {
  students: {
    label: '학생',
    fields: ['name', 'dob', 'school', 'grade', 'curriculum', 'counselor', 'manager', 'status', 'tracks', 'tracksNote', 'studentPhone', 'progress',
      'parentName', 'parentPhone', 'email', 'tags', 'memo', 'driveUrl', 'resumeUrl', 'englishName', 'address', 'addressEn',
      'hopeUnis', 'focusArea', 'recommenders', 'onlineCourse', 'meetingUrl',
      'fatherName', 'fatherPhone', 'fatherWechat', 'fatherEmail', 'motherName', 'motherPhone', 'motherWechat', 'motherEmail',
      'storyTrigger', 'storyProcess', 'storyLink', 'storyConclusion', 'storyStatus', 'branch', // branch: 지점 (상해·압구정)
      'passportNo', 'fatherNameEn', 'motherNameEn', 'fatherWork', 'motherWork'], // 원서용: 여권 번호(여러 개면 줄바꿈), 부모 영문명·근무 기간
    summary: (r) => r.name,
  },
  notes: {
    label: '상담기록',
    fields: ['studentId', 'date', 'time', 'tz', 'place', 'attendees', 'type', 'content', 'contentHtml', 'nextAction', 'nextDue', 'done', 'sourceUrl', 'needsReview'], // tz: 시간을 어느 나라 기준으로 적었는지
    summary: (r) => [r.date, r.type].join(' '),
  },
  contracts: {
    label: '계약',
    fields: ['studentId', 'kind', 'tier', 'term', 'packages', 'startDate', 'endDate', 'startMonth', 'endMonth', 'signedDate', 'currency', 'amount',
      'payDue', 'scope', 'memo', 'items', 'listPrice'], // items: 가격표에서 고른 패키지(JSON) — listPrice = 정가 합계, amount = 실제 계약 금액(할인 반영)
    summary: (r) => [r.kind, r.tier, r.term, r.packages].filter(Boolean).join(' '),
  },
  apps: {
    label: '지원대학',
    fields: ['studentId', 'country', 'universityId', 'university', 'majorId', 'major', 'roundId', 'round', 'deadline',
      'deadlineManual', 'status', 'essay', 'memo', 'parentConfirmed', 'submittedAt', 'majorChoices'], // submittedAt: 원서 관리 "제출 완료" 누른 날, majorChoices: 2지망부터 [{label, major}]
    summary: (r) => [r.university, r.round].filter(Boolean).join(' '),
  },
  scores: {
    label: '성적',
    fields: ['studentId', 'kind', 'subject', 'level', 'score', 'detail', 'date', 'memo'], // level: IB HL·SL
    summary: (r) => [r.kind, r.subject, r.score].filter(Boolean).join(' '),
  },
  activities: {
    label: '활동',
    fields: ['studentId', 'category', 'name', 'role', 'period', 'deadline', 'status', 'memo'],
    summary: (r) => [r.category, r.name].filter(Boolean).join(' '),
  },
  docs: {
    label: '서류',
    fields: ['studentId', 'name', 'category', 'status', 'due', 'memo'],
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
      'kind', 'fromWho', 'channel', 'receivedDate', 'answer', 'answerDate', 'groupId',
      'remindAt', 'remindTo', 'topic', 'titleHtml', 'detailHtml'], // titleHtml·detailHtml: 할 일·세부(받은) 내용의 서식(글자색·굵게·취소선), 일반 글(title·detail)은 저장할 때 서식에서 다시 만듦 / topic: 주제 한 줄 (같은 학생의 같은 주제끼리 한 사건으로 묶임), remindAt: 알림 시각(한국 시간 'YYYY-MM-DDTHH:MM'), remindTo: 받는 사람 ('@assignee' = 그때의 담당자, 쉼표로 이메일 추가)
    summary: (r) => [r.title, r.status].filter(Boolean).join(' · '),
  },
  fureplies: { // 팔로업·받은 연락에 이어지는 답변 (학생 → 우리 → 어머님 …)
    label: '답변',
    fields: ['studentId', 'followupId', 'who', 'date', 'content'],
    summary: (r) => [r.who, r.content].filter(Boolean).join(' · '),
  },
  majorplans: {
    label: '전공 선정',
    fields: ['studentId', 'date', 'universityId', 'university', 'major', 'field', 'status', 'source', 'reason', 'parentConfirmed'],
    summary: (r) => [r.university, r.major, r.status, r.parentConfirmed === 'TRUE' ? '부모님 확정' : ''].filter(Boolean).join(' · '),
  },
  schools: {
    label: '학력',
    fields: ['studentId', 'school', 'country', 'city', 'gradeFrom', 'termFrom', 'gradeTo', 'termTo', 'startDate', 'endDate', 'memo'],
    summary: (r) => [r.school, [[r.gradeFrom, r.termFrom].filter(Boolean).join(' '), [r.gradeTo, r.termTo].filter(Boolean).join(' ')].filter(Boolean).join('~'), [r.startDate, r.endDate || '재학 중'].join('~')].filter(Boolean).join(' '),
  },
  cdocs: { // 계약서: 양식으로 자동 채운 뒤 고친 본문(HTML) + 보냄·서명 기록. 서명본 파일은 files.contractId 로 계약에 붙음
    label: '계약서',
    fields: ['studentId', 'contractId', 'templateId', 'title', 'body', 'status', 'signMethod', 'sentAt', 'sentVia', 'signedAt', 'signUrl', 'memo', 'special'], // special: 특약사항 입력 칸 글 (한 줄 = 한 항목)
    summary: (r) => [r.title, r.status].filter(Boolean).join(' · '),
  },
  semesters: { // 학기별 재학: 학기 시작일~종료일로 실제 재학 일수를 계산 (3년특례 등 재학기간 증빙)
    label: '학기별 재학',
    fields: ['studentId', 'school', 'grade', 'term', 'startDate', 'endDate', 'memo'],
    summary: (r) => [r.school, r.grade, r.term && r.term + '학기', [r.startDate, r.endDate].filter(Boolean).join('~')].filter(Boolean).join(' '),
  },
  courses: {
    label: '수강 과목',
    fields: ['studentId', 'grade', 'schoolYear', 'subject', 'level', 'termType', 'g1', 'g2', 'g3', 'final', 'memo'],
    summary: (r) => [r.grade, r.subject].filter(Boolean).join(' '),
  },
  meetings: {
    label: '미팅',
    fields: ['studentId', 'date', 'time', 'tz', 'status', 'type', 'place', 'attendees', 'writer', 'topic', 'content', 'contentHtml', 'parentNote', 'nextStep', 'nextDate', 'sourceUrl', 'needsReview'],
    summary: (r) => [r.date, r.status, r.topic].filter(Boolean).join(' · '),
  },
  accounts: {
    label: '사이트 계정',
    fields: ['studentId', 'category', 'site', 'url', 'universityId', 'loginId', 'password', 'memo'],
    summary: (r) => [r.site, r.loginId].filter(Boolean).join(' · '),
  },
  appinfo: {
    label: '원서 정보',
    fields: ['studentId', 'universityId', 'item', 'content', 'sent', 'recName', 'recTitle', 'recSubject', 'recEmail'], // sent: 추천인에게 질문지 맞춰 이메일 보냄 / rec*: 추천인·카운슬러 이름·직책·과목·공식 이메일
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
const CONTACT_FROM = ['학생', '어머님', '아버님', '학부모', '학교', '기타'];
const CONTACT_CHANNELS = ['위챗', '카톡', '왓츠앱', '전화', '대면', '기타'];
// 예전에 쓰던 경로 — 이미 저장된 기록은 그대로 수정할 수 있게 받아준다
const CONTACT_CHANNELS_OLD = ['문자', '이메일'];
const MAJOR_STATUS = ['후보', '유력', '최종', '제외'];
const MEETING_STATUS = ['예정', '완료', '취소'];
const COURSE_TERMS = ['1년(2학기)', '1학기만', '2학기만', 'Trimester'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 관리 페이지에서 고르는 목록 (학교·커리큘럼) → 학생 정보의 해당 칸 */
/** 달력 자동 표시 항목 (키, 처음 색) — 화면 이름은 원장님 미팅·다음 미팅·지원 마감 */
const AUTO_CATS = [['sched', '#7c5cc4'], ['nextmeet', '#0b1b45'], ['deadline', '#9ca3af']];
const { SUBJECTS, KIND_CATS, LEVEL_CATS } = require('./subjects');
const OPTION_KINDS = { subject: '과목', school: '학교', curriculum: '커리큘럼', site: '사이트', evcat: '일정 분류', track: '트랙', doccat: '서류 분류', pgcat: '대회·프로그램 분류', fucat: '팔로업 분류', tz: '시간대' }; // tz: value = 화면 이름, category = 세계 시간대(IANA), fullName = 같은 시간을 쓰는 도시
/** 팔로업 분류 초기값 (목록 관리 › 팔로업 분류) — 팔로업·받은 연락을 분류별로 묶어 봄 */
const DEFAULT_FUCATS = ['서류', '에세이', '추천서', '시험·성적', '원서·지원', '학교 생활', '상담·미팅', '기타'];
const DEFAULT_PGCATS = ['에세이 대회', '수학·과학 대회', '경시·올림피아드', '리서치', '서머 프로그램', '봉사·활동', '기타'];
/** 서류 분류 초기값 (목록 관리 › 서류 분류) — 성적·학력 탭 파일과 서류 탭 항목에 씀 */
const DEFAULT_DOCCATS = ['재학증명서', '성적증명서', '졸업증명서', '어학증빙', '표준화학력(SAT·AP·IB)', '지원자격증빙(출입국·여권 등)', '기타(학사일정표·고교 프로파일 등)'];
const DC = { lang: DEFAULT_DOCCATS[3], std: DEFAULT_DOCCATS[4], elig: DEFAULT_DOCCATS[5], etc: DEFAULT_DOCCATS[6] };
/** 점수 첨부 파일 분류: 어학 → 어학증빙, SAT·AP·IB 등 → 표준화학력 */
function scoreDocCat(kind) {
  if (/^(TOEFL|IELTS|TOPIK|HSK|Duolingo)/i.test(kind || '')) return DC.lang;
  if (/^(SAT|ACT|AP|IB|A-Level)/i.test(kind || '')) return DC.std;
  if (kind === 'GPA') return DEFAULT_DOCCATS[1];
  return DC.etc;
}
/** 서류 이름으로 분류 짐작 (예전 서류·새로 만든 서류) */
function guessDocCat(name) {
  const n = String(name || '');
  if (/재학/.test(n)) return DEFAULT_DOCCATS[0];
  if (/성적/.test(n)) return DEFAULT_DOCCATS[1];
  if (/졸업/.test(n)) return DEFAULT_DOCCATS[2];
  if (/토플|TOEFL|IELTS|아이엘츠|어학|TOPIK|HSK/i.test(n)) return DC.lang;
  if (/SAT|\bAP\b|\bIB\b|ACT/.test(n)) return DC.std;
  if (/출입국|여권|가족관계|외국인등록|비자|거주/.test(n)) return DC.elig;
  return DC.etc;
}
/** 학생 목록에 넣을 수 있는 칸 (화면 이름은 index.html STUDENT_COLS) */
const STUDENT_COLS = ['school', 'consult', 'todo', 'contacts', 'nextMeet', 'deadline', 'lastMeet', 'check', 'manager', 'status', 'tracks', 'country', 'major', 'progress', 'hope',
  'contract', 'amount', 'unpaid', 'contractEnd', 'scores', 'appProgress', 'nextSched', 'curriculum', 'parentPhone', 'dob'];
/** 예전 계약 패키지 이름 → 트랙 이름 (가져오기·예전 화면에서 들어와도 맞춰 줌) */
const OLD_PACKAGES = { '홍콩 패키지': '홍콩', '한국 3특': '3년특례', '한국 12특': '12년특례' };
const DEFAULT_TRACKS = ['3년특례', '12년특례', '홍콩', '싱가폴', '미국', '캐나다', '영국', '일본', '한국 일반', '기타'];
/** 목록 이름을 바꾸면 함께 바뀌는 곳 */
const OPTION_TARGET = { school: ['students', 'school'], curriculum: ['students', 'curriculum'], site: ['accounts', 'site'], evcat: ['events', 'category'], track: ['students', 'tracks'], doccat: ['files', 'category'], pgcat: ['programs', 'category'], fucat: ['followups', 'category'] };
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
/** 지점별로 숨길 수 있는 메뉴 (메인 위젯 중 같은 이름도 함께 숨김) */
const HIDEABLE_MENUS = ['followups', 'meetings', 'deadlines', 'apply', 'unis', 'programs', 'results'];
/** 맨 위 🐞 버그·요청 버튼의 처음 링크 (사이트 설정에서 바꾸거나 비울 수 있음) */
const DEFAULT_BUG_URL = 'https://docs.google.com/spreadsheets/d/1kc0zuaz4AxdTnXXskaM_-mxggxhPW_B1oh7pEFQ3SC4/edit?usp=sharing';
/** 학교 상세 칸: 주소, 홈페이지, 학년제·학기제, 대표 이메일, 전화 */
const SCHOOL_INFO = ['address', 'homepage', 'system', 'email', 'phone'];
const CHILD_TABLES = Object.keys(TABLES).filter((t) => t !== 'students');

/** 대학 정보 (학생과 무관한 공용 자료) */
const CATALOG = {
  universities: {
    label: '대학', fields: ['country', 'name', 'fullName', 'aliases', 'website', 'portalUrl', 'tips', 'sortOrder', 'campuses'], // campuses: 대학 지도용 [{name, lat, lng, approx}]
    summary: (r) => r.name,
  },
  unicycles: {
    label: '입학 연도 정보', fields: ['universityId', 'year', 'term', 'tracks', 'requirements', 'choices', 'sourceUrl', 'status', 'memo'], // choices: 전공 지망 형식 [{label, n}]
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
/** 대학 목록 자체(추가·이름/국가 변경·순서)는 관리자·관리팀, 삭제는 관리자만 */
const UNI_ADMIN_FIELDS = ['country', 'name', 'fullName', 'aliases', 'sortOrder'];
const CYCLE_STATUS = ['확인 필요', '확인 완료'];
const DEF = Object.assign({}, TABLES, CATALOG);
function cycleLabel(c) { return c ? (c.year || '') + '년 ' + (c.term || '') + ' 입학' : ''; }
/** 변경 기록에 표시할 항목 이름 */
const FIELD_LABELS = {
  name: '이름', dob: '생년월일', school: '학교', grade: '학년', curriculum: '커리큘럼', counselor: '담당 컨설턴트',
  status: '상태', tracks: '트랙', tracksNote: '트랙 기타 내용', termFrom: '시작 학기', termTo: '마지막 학기', studentPhone: '학생 연락처', parentName: '학부모 이름', parentPhone: '학부모 연락처',
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
  fullName: '정식 이름', aliases: '다른 이름', website: '홈페이지', portalUrl: '원서 접수(포털) 주소', tips: '원서 준비 유의사항', sortOrder: '순서',
  year: '입학 연도', term: '입학 학기', requirements: '주요 정보', sourceUrl: '출처', faculty: '단과대',
  code: '코드', cycleId: '입학 연도',
  submittedAt: '제출일', englishName: '영문 이름', address: '주소', addressEn: '영문 주소', sent: '추천인 이메일 보냄', sentAt: '이메일 보낸 날', sentBy: '이메일 체크한 사람',
  hopeUnis: '희망 대학·특례', focusArea: '집중 과목·관리 영역', recommenders: '추천서 진행', onlineCourse: '온라인 코스 진행',
  who: '답변한 사람', meetingUrl: '미팅 회의록 링크', reply: '학생·학부모 답변', replyDate: '답변 날짜', replyFrom: '답변한 사람', kind: '종류', fromWho: '보낸 사람', channel: '연락 경로', receivedDate: '받은 날짜', answer: '우리 답변·처리', answerDate: '우리 답변 날짜',
  site: '사이트', loginId: '아이디', password: '비밀번호',
  parentNote: '부모님 전달·대화 내용', writer: '작성자', topic: '안건', nextStep: '다음 계획', needsReview: '확인 필요',
  field: '계열', source: '제안·계기', reason: '이유', parentConfirmed: '부모님 확정', parentConfirmedAt: '부모님 확정일',
  parentConfirmedBy: '부모님 확정 기록자', city: '도시', gradeFrom: '시작 학년', gradeTo: '마지막 학년', startDate: '시작일',
  endDate: '종료일', schoolYear: '학년도', level: '레벨', termType: '학기 구분', g1: '1학기/T1 성적', g2: '2학기/T2 성적',
  g3: 'T3 성적', final: '최종 성적',
  passportNo: '여권 번호', fatherNameEn: '부 영문명', motherNameEn: '모 영문명', fatherWork: '부 근무 기간', motherWork: '모 근무 기간',
  recName: '추천인 이름', recTitle: '추천인 직책', recSubject: '추천인 과목', recEmail: '추천인 이메일',
  nextDate: '다음 미팅 날짜', meetingId: '미팅', noteId: '상담기록', contentHtml: '내용 서식', item: '항목',
};
/** 관리자/관리팀만 다룰 수 있는 테이블 */
const MANAGER_ONLY = ['notes', 'contracts', 'payments', 'cdocs'];
/** 계약서: 상태와 서명 방식 (방문 서명 = 종이 서명 후 스캔, 안내형 = 안내문으로 보내고 회신, 전자서명 = 외부 전자서명) */
const CDOC_STATUS = ['초안', '보냄', '서명 완료'];
const SIGN_METHODS = ['방문 서명', '안내형', '전자서명'];
/** 컨설턴트에게 숨기는 계약 필드 */
const HIDDEN_FOR_CONSULTANT = { contracts: ['amount', 'paid', 'currency', 'payDue'], meetings: ['parentNote'] };

const UPLOAD_TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  heic: 'image/heic', gif: 'image/gif',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  hwp: 'application/x-hwp',
};
// 파일 한 개 최대 크기: 관리 › 저장 공간에서 1~100MB로 정함 (기본 20MB). MAX_UPLOAD는 서버가 받는 절대 상한
const MAX_UPLOAD = 100 * 1024 * 1024;
const UPLOAD_MB_DEFAULT = 20, UPLOAD_MB_MAX = MAX_UPLOAD / 1024 / 1024;
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
const isManager = (me) => me.role === 'admin' || me.role === 'staff' || me.role === 'developer';
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
  ensureColumns(db, 'apps', ['parentConfirmedAt', 'parentConfirmedBy', 'submittedBy']);
  ensureColumns(db, 'appinfo', ['sentAt', 'sentBy']);
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
  ensureColumns(db, 'files', ['mime', 'size', 'storedName', 'docId', 'meetingId', 'followupId', 'scoreId']);
  ensureColumns(db, 'files', ['replyId']);
  ensureColumns(db, 'files', ['contractId']); // 계약서 서명본·스캔 (관리자·관리팀만 보임)
  ensureColumns(db, 'teachers', ['fuOrder']);
  ensureColumns(db, 'teachers', ['uiPrefs']); // 그 밖의 개인 화면 설정(JSON): 표 칸 너비·접기·정렬·달력 체크·REVERA A 화면 등 — 어느 PC에서나 같게 // 메인 위젯에서 끌어서 정한 내 팔로업 순서 (팔로업 id JSON 배열, 계정마다 따로) // 팔로업·연락의 어느 답변(말풍선)에 붙은 파일인지
  ensureColumns(db, 'docs', ['receivedAt', 'receivedBy']);
  ensureColumns(db, 'contracts', ['paid']); // 이전 버전 열 (새 버전은 입금 기록으로 계산)
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  ensureColumns(db, 'teachers', ['notify']); // '' = 이메일 알림 받음, 'off' = 안 받음
  ensureColumns(db, 'teachers', ['homeLayout']);
  ensureColumns(db, 'teachers', ['viewPrefs']); // 화면 보기 선택(JSON) — 메인 팔로업 간단히/자세히, 원서 관리 보기 등
  ensureColumns(db, 'teachers', ['color']);
  ensureColumns(db, 'teachers', ['sortOrder']); // 계정 관리에서 끌어서 정한 순서 (학생 목록 관리팀 담당순) // 관리팀 색 (학생 목록 줄 배경). '' = 없음 // 메인 화면 배치(JSON). '' = 관리자가 정한 기본 배치
  // v10: 팔로업 요청(휴무 등으로 다른 선생님에게 부탁), 대학 자료 파일
  ensureColumns(db, 'followups', ['requestedBy', 'requestedAt', 'requestNote']);
  db.exec('CREATE TABLE IF NOT EXISTS unifiles (id TEXT PRIMARY KEY)');
  ensureColumns(db, 'unifiles', ['universityId', 'cycleId', 'programId', 'category', 'name', 'memo', 'mime', 'size', 'storedName', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']); // programId: 대회·프로그램 첨부
  // v12: 확인 요청 — 이 기록(상담·미팅·연락)을 다른 선생님이 꼭 보도록 (휴무 후 출근해서 확인 등)
  // 알림함: 팔로업 알림 시각(remind) · 확인 요청(review) · 넘겨받은 팔로업(handover). ukey 로 같은 알림은 한 번만
  db.exec("CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, ukey TEXT UNIQUE NOT NULL, email TEXT NOT NULL, kind TEXT NOT NULL, refTable TEXT NOT NULL DEFAULT '', refId TEXT NOT NULL DEFAULT '', studentId TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', fromEmail TEXT NOT NULL DEFAULT '', at TEXT NOT NULL, readAt TEXT NOT NULL DEFAULT '', closedAt TEXT NOT NULL DEFAULT '', snoozeUntil TEXT NOT NULL DEFAULT '')");
  db.exec('CREATE INDEX IF NOT EXISTS ix_notices_email ON notices(email, at)');
  db.exec("CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, studentId TEXT NOT NULL, refTable TEXT NOT NULL, refId TEXT NOT NULL, toEmail TEXT NOT NULL, fromEmail TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, doneAt TEXT NOT NULL DEFAULT '')");
  // v13: 원장님 상담 스케줄(구글 시트)에서 가져온 일정 — Compass 학생과 연결된 것만. schedex = "우리 학생 아님"으로 뺀 일정
  db.exec("CREATE TABLE IF NOT EXISTS sched (key TEXT PRIMARY KEY, tab TEXT NOT NULL, studentId TEXT NOT NULL, startAt TEXT NOT NULL, endAt TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', zone TEXT NOT NULL DEFAULT '', sheetLabel TEXT NOT NULL DEFAULT '', syncedAt TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS schedex (key TEXT PRIMARY KEY, studentId TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', startAt TEXT NOT NULL DEFAULT '', by TEXT NOT NULL, at TEXT NOT NULL)");
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
  db.prepare(`UPDATE teachers SET role = 'consultant' WHERE role NOT IN ('admin','staff','consultant','developer')`).run();
  // v36: 개발자 역할 — 처음 한 번, 박현모 계정 (그 뒤로는 개발자만 개발자를 정함)
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v36_developer'").get()) {
    if (!db.prepare("SELECT 1 FROM teachers WHERE role = 'developer'").get()) db.prepare("UPDATE teachers SET role = 'developer' WHERE TRIM(name) = '박현모' AND active = 1").run();
    db.prepare("INSERT INTO meta VALUES ('v36_developer', ?)").run(now());
  }
  // 이전 버전 데이터의 작성자 정보 보정
  db.prepare(`UPDATE notes SET createdBy = author WHERE createdBy = '' AND author != ''`).run();
  for (const t of ['apps']) db.prepare(`UPDATE ${t} SET createdBy = updatedBy WHERE createdBy = ''`).run();
  db.exec('CREATE TABLE IF NOT EXISTS options (id TEXT PRIMARY KEY)');
  ensureColumns(db, 'options', ['kind', 'value', 'sortOrder', 'url', 'category', 'color', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']);
  ensureColumns(db, 'options', ['fullName', 'country', 'city']);
  ensureColumns(db, 'options', ['info']); // 학교 상세(JSON): 주소·홈페이지·학년제/학기제·대표 이메일·전화 — 원서용 학생 정보 엑셀에 씀 // 학교: 정식 이름·나라·도시 (화면에는 짧은 이름 value)
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
  // v14: 달력 자동 표시 항목(원장님 미팅·다음 미팅·지원 마감) — 이름 고정, 색·순서·보이기만 바꿀 수 있음 (category = 'off' 이면 숨김)
  {
    const ts = now();
    AUTO_CATS.forEach(([v, c], i) => {
      if (db.prepare("SELECT 1 FROM options WHERE kind = 'evauto' AND value = ?").get(v)) return;
      db.prepare('INSERT INTO options (id, kind, value, sortOrder, category, color, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), 'evauto', v, String(i + 1), '', c, ts, 'system', ts, 'system');
    });
  }
  // v15: 학생 트랙을 목록 관리에서 (처음엔 기존 고정 목록)
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v15_tracks'").get()) {
    const ts = now();
    DEFAULT_TRACKS.forEach((v, i) => {
      if (db.prepare("SELECT 1 FROM options WHERE kind = 'track' AND value = ?").get(v)) return;
      db.prepare('INSERT INTO options (id, kind, value, sortOrder, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), 'track', v, String(i + 1), ts, 'system', ts, 'system');
    });
    db.prepare("INSERT INTO meta VALUES ('v15_tracks', ?)").run(ts);
  }
  // v16: 팔로업 답변·받은 연락의 우리 답변(한 칸씩) → 이어지는 답변 목록으로 옮김
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v16_replies'").get()) {
    const ts = now(), WHO = { 어머니: '어머님', 아버지: '아버님', 학부모: '학부모(예전)' };
    const ins = db.prepare('INSERT INTO fureplies (id, studentId, followupId, who, date, content, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?,?)');
    db.transaction(() => {
      for (const f of db.prepare("SELECT * FROM followups WHERE reply != '' OR replyFrom != '' OR answer != ''").all()) {
        const by = f.updatedBy || f.createdBy || 'system', at = f.updatedAt || ts;
        if (f.reply || f.replyFrom) ins.run(crypto.randomUUID(), f.studentId, f.id, WHO[f.replyFrom] || f.replyFrom || '학생', f.replyDate || '', f.reply || '(' + f.replyFrom + ')', at, by, at, by);
        if (f.answer) ins.run(crypto.randomUUID(), f.studentId, f.id, '담당 선생님', f.answerDate || '', f.answer, at, by, at, by);
      }
      db.prepare("UPDATE followups SET reply = '', replyFrom = '', replyDate = '', answer = '', answerDate = '' WHERE reply != '' OR replyFrom != '' OR answer != ''").run();
      db.prepare("UPDATE followups SET fromWho = CASE fromWho WHEN '어머니' THEN '어머님' ELSE '아버님' END WHERE fromWho IN ('어머니', '아버지')").run();
      db.prepare("INSERT INTO meta VALUES ('v16_replies', ?)").run(ts);
    })();
  }
  // v17: 서류 분류 목록 + 기존 파일·서류 분류 옮기기 (성적표 → 성적증명서, 그 밖의 분류 → 기타 + 메모에 예전 분류)
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v17_doccats'").get()) {
    const ts = now();
    db.transaction(() => {
      DEFAULT_DOCCATS.forEach((v, i) => {
        if (db.prepare("SELECT 1 FROM options WHERE kind = 'doccat' AND value = ?").get(v)) return;
        db.prepare('INSERT INTO options (id, kind, value, sortOrder, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?)')
          .run(crypto.randomUUID(), 'doccat', v, String(i + 1), ts, 'system', ts, 'system');
      });
      for (const d of db.prepare("SELECT id, name FROM docs WHERE category = ''").all()) db.prepare('UPDATE docs SET category = ? WHERE id = ?').run(guessDocCat(d.name), d.id);
      for (const f of db.prepare('SELECT f.id, f.category, f.memo, f.docId, f.scoreId, f.meetingId, f.followupId, d.category dc, s.kind sk FROM files f LEFT JOIN docs d ON d.id = f.docId LEFT JOIN scores s ON s.id = f.scoreId').all()) {
        let cat = f.category, memo = f.memo;
        if (f.docId) cat = f.dc || DC.etc;
        else if (f.scoreId) cat = scoreDocCat(f.sk);
        else if (f.meetingId || f.followupId) continue; // 미팅·연락 첨부는 그대로
        else if (f.category === '성적표') cat = DEFAULT_DOCCATS[1];
        else if (!DEFAULT_DOCCATS.includes(f.category)) { cat = DC.etc; if (f.category && f.category !== '기타') memo = [f.category, f.memo].filter(Boolean).join(' · '); }
        if (cat !== f.category || memo !== f.memo) db.prepare('UPDATE files SET category = ?, memo = ? WHERE id = ?').run(cat, memo, f.id);
      }
      db.prepare("INSERT INTO meta VALUES ('v17_doccats', ?)").run(ts);
    })();
  }
  // v35: 과목 목록 (목록 관리 › 과목) — 커리큘럼(category)별 공식 과목
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v35_subjects'").get()) {
    const ts = now();
    db.transaction(() => {
      for (const [cat, list] of Object.entries(SUBJECTS)) list.forEach((v, i) => {
        if (db.prepare("SELECT 1 FROM options WHERE kind = 'subject' AND category = ? AND value = ?").get(cat, v)) return;
        db.prepare('INSERT INTO options (id, kind, value, sortOrder, category, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(crypto.randomUUID(), 'subject', v, String(i + 1), cat, ts, 'system', ts, 'system');
      });
      db.prepare("INSERT INTO meta VALUES ('v35_subjects', ?)").run(ts);
    })();
  }
  // v32: 시간대 목록 (목록 관리 › 시간대) — 처음 6개
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v32_tz'").get()) {
    const ts = now();
    db.transaction(() => {
      DEFAULT_TZS.forEach(([name, zone, hint], i) => {
        if (db.prepare("SELECT 1 FROM options WHERE kind = 'tz' AND category = ?").get(zone)) return;
        db.prepare('INSERT INTO options (id, kind, value, sortOrder, category, fullName, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(crypto.randomUUID(), 'tz', name, String(i + 1), zone, hint, ts, 'system', ts, 'system');
      });
      db.prepare("INSERT INTO meta VALUES ('v32_tz', ?)").run(ts);
    })();
  }
  // v31: 서류 분류 목록 정리 — 파일·서류가 쓰고 있는데 목록에서 빠진 분류를 되살리고, 순서를 기본 분류 → 직접 추가한 분류 → 기타(맨 뒤)로
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v31_doccat_tidy'").get() && db.prepare("SELECT 1 FROM meta WHERE key = 'v17_doccats'").get()) {
    const ts = now();
    db.transaction(() => {
      const list = db.prepare("SELECT id, value FROM options WHERE kind = 'doccat' ORDER BY CAST(sortOrder AS INTEGER), value").all();
      const used = new Set(db.prepare("SELECT DISTINCT category c FROM docs WHERE deletedAt = '' AND category != '' UNION SELECT DISTINCT category FROM files WHERE deletedAt = '' AND category != '' AND meetingId = '' AND followupId = '' AND docId = ''").all().map((r) => r.c));
      const have = new Set(list.map((o) => o.value));
      const etc = DEFAULT_DOCCATS[DEFAULT_DOCCATS.length - 1];
      const order = DEFAULT_DOCCATS.filter((v) => v !== etc && (have.has(v) || used.has(v)))
        .concat(list.map((o) => o.value).filter((v) => !DEFAULT_DOCCATS.includes(v)))
        .concat([...used].filter((v) => !have.has(v) && !DEFAULT_DOCCATS.includes(v)).sort())
        .concat(have.has(etc) || used.has(etc) ? [etc] : []);
      order.forEach((v, i) => {
        if (have.has(v)) db.prepare("UPDATE options SET sortOrder = ? WHERE kind = 'doccat' AND value = ?").run(String(i + 1), v);
        else db.prepare('INSERT INTO options (id, kind, value, sortOrder, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?)').run(crypto.randomUUID(), 'doccat', v, String(i + 1), ts, 'system', ts, 'system');
      });
      db.prepare("INSERT INTO meta VALUES ('v31_doccat_tidy', ?)").run(ts);
    })();
  }
  // v18: 부모님 확정은 지원대학에서 — 전공 탭의 확정 기록을 같은 대학·같은 전공 지원대학으로 옮김 (전공 탭 기록은 그대로 남김)
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v18_app_parent'").get()) {
    const norm = (x) => String(x || '').trim().toLowerCase();
    db.transaction(() => {
      for (const m of db.prepare("SELECT * FROM majorplans WHERE parentConfirmed = 'TRUE' AND deletedAt = ''").all()) {
        for (const a of db.prepare("SELECT id, universityId, major FROM apps WHERE studentId = ? AND deletedAt = '' AND parentConfirmed != 'TRUE'").all(m.studentId)) {
          if (m.universityId && a.universityId === m.universityId && norm(a.major) && norm(a.major) === norm(m.major)) {
            db.prepare("UPDATE apps SET parentConfirmed = 'TRUE', parentConfirmedAt = ?, parentConfirmedBy = ? WHERE id = ?").run(m.parentConfirmedAt || m.updatedAt || '', m.parentConfirmedBy || m.updatedBy || '', a.id);
          }
        }
      }
      db.prepare("INSERT INTO meta VALUES ('v18_app_parent', ?)").run(now());
    })();
  }
  // v19: 학생 정보 정리 — 원서 정보의 공통 "영문 이름·영문 주소" → 학생 정보 칸, 추천서 진행·온라인 코스(관리 메모) → 학생 메모 끝에 붙임
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v19_profile'").get()) {
    const ts = now();
    db.transaction(() => {
      const MOVE = [[/^영문\s*이름/, 'englishName'], [/^영문\s*주소/, 'addressEn']];
      for (const r of db.prepare("SELECT id, studentId, item, content FROM appinfo WHERE universityId = '' AND deletedAt = '' ORDER BY createdAt").all()) {
        const m = MOVE.find(([re]) => re.test(r.item || ''));
        if (!m) continue;
        const st = db.prepare(`SELECT ${m[1]} v FROM students WHERE id = ?`).get(r.studentId);
        if (!st || st.v) continue; // 이미 칸에 값이 있으면 원서 정보에 그대로 둠
        db.prepare(`UPDATE students SET ${m[1]} = ? WHERE id = ?`).run(r.content, r.studentId);
        db.prepare("UPDATE appinfo SET deletedAt = ?, deletedBy = 'system' WHERE id = ?").run(ts, r.id);
      }
      for (const st of db.prepare("SELECT id, memo, recommenders, onlineCourse FROM students WHERE recommenders != '' OR onlineCourse != ''").all()) {
        const add = [st.recommenders && '[추천서 진행] ' + st.recommenders, st.onlineCourse && '[온라인 코스] ' + st.onlineCourse].filter(Boolean).join('\n');
        db.prepare("UPDATE students SET memo = ?, recommenders = '', onlineCourse = '' WHERE id = ?").run([st.memo, add].filter(Boolean).join('\n'), st.id);
      }
      db.prepare("INSERT INTO meta VALUES ('v19_profile', ?)").run(ts);
    })();
  }
  // v20: 대학 정보 처음부터 — 처음 넣은 조사 요건(선생님이 고치지 않은 것)은 비우고, "확인 필요/완료"는 없앰. 마감일·전공·파일·유의사항은 그대로
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v20_uni_reset'").get()) {
    const ts = now();
    db.transaction(() => {
      db.prepare("UPDATE unicycles SET requirements = '[]' WHERE createdBy = 'system' AND updatedBy = 'system'").run();
      for (const c of db.prepare('SELECT id, memo FROM unicycles').all()) {
        const m = stripSeedNote(c.memo);
        if (m !== c.memo) db.prepare('UPDATE unicycles SET memo = ? WHERE id = ?').run(m, c.id);
      }
      db.prepare("INSERT INTO meta VALUES ('v20_uni_reset', ?)").run(ts);
    })();
  }
  // v21: 계약 "포함 국가·패키지"를 목록 관리 › 트랙 이름으로 (홍콩 패키지 → 홍콩, 한국 3특 → 3년특례, 한국 12특 → 12년특례)
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v21_packages'").get()) {
    const MAP = OLD_PACKAGES;
    db.transaction(() => {
      for (const c of db.prepare("SELECT id, packages FROM contracts WHERE packages != ''").all()) {
        const list = [...new Set(String(c.packages).split(',').map((x) => x.trim()).filter(Boolean).map((x) => MAP[x] || x))].join(', ');
        if (list !== c.packages) db.prepare('UPDATE contracts SET packages = ? WHERE id = ?').run(list, c.id);
      }
      db.prepare("INSERT INTO meta VALUES ('v21_packages', ?)").run(now());
    })();
  }
  db.exec('CREATE TABLE IF NOT EXISTS programs (id TEXT PRIMARY KEY)');
  ensureColumns(db, 'programs', ['category']);
  // v22: 대회·프로그램 분류를 목록 관리에서 (처음 목록 + 이미 쓰던 분류)
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v22_pgcats'").get()) {
    const ts = now();
    const used = db.prepare("SELECT DISTINCT category v FROM programs WHERE category != ''").all().map((r) => r.v);
    [...new Set(DEFAULT_PGCATS.concat(used))].forEach((v, i) => {
      if (db.prepare("SELECT 1 FROM options WHERE kind = 'pgcat' AND value = ?").get(v)) return;
      db.prepare('INSERT INTO options (id, kind, value, sortOrder, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), 'pgcat', v, String(i + 1), ts, 'system', ts, 'system');
    });
    db.prepare("INSERT INTO meta VALUES ('v22_pgcats', ?)").run(ts);
  }
  // v37: 팔로업 분류 (자유 입력 주제 대신 정해진 분류에서 고름 — 처음 목록 + 이미 쓰던 분류)
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v37_fucats'").get()) {
    const ts = now();
    const used = db.prepare("SELECT DISTINCT category v FROM followups WHERE category != '' AND deletedAt = ''").all().map((r) => r.v);
    [...new Set(DEFAULT_FUCATS.concat(used))].forEach((v, i) => {
      if (db.prepare("SELECT 1 FROM options WHERE kind = 'fucat' AND value = ?").get(v)) return;
      db.prepare('INSERT INTO options (id, kind, value, sortOrder, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), 'fucat', v, String(i + 1), ts, 'system', ts, 'system');
    });
    db.prepare("INSERT INTO meta VALUES ('v37_fucats', ?)").run(ts);
  }
  // 계약서 양식 (학생과 무관, 관리자·관리팀이 고침)
  db.exec("CREATE TABLE IF NOT EXISTS ctemplates (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', sortOrder TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL DEFAULT '', createdBy TEXT NOT NULL DEFAULT '', updatedAt TEXT NOT NULL DEFAULT '', updatedBy TEXT NOT NULL DEFAULT '', deletedAt TEXT NOT NULL DEFAULT '')");
  // 원서 연습 초안: 학생 × 양식(대학·입학 연도) 하나, data = 칸 값(JSON), done = 다 쓴 탭(JSON)
  // 원서 연습: studentId가 비면 만든 사람만 보는 개인 연습, 있으면 그 학생을 볼 수 있는 사람 모두
  db.exec("CREATE TABLE IF NOT EXISTS appdrafts (id TEXT PRIMARY KEY, formId TEXT NOT NULL, studentId TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}', done TEXT NOT NULL DEFAULT '[]', createdAt TEXT NOT NULL DEFAULT '', createdBy TEXT NOT NULL DEFAULT '', updatedAt TEXT NOT NULL DEFAULT '', updatedBy TEXT NOT NULL DEFAULT '')");
  ensureColumns(db, 'appdrafts', ['title']);
  db.exec('DROP INDEX IF EXISTS appdrafts_sf');
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v38_ctemplates'").get()) { // 이전에 쓰던 원서 컨설팅 계약서를 기본 양식으로
    const ts = now();
    DEFAULT_TEMPLATES.forEach((t, i) => db.prepare('INSERT INTO ctemplates (id, name, kind, body, sortOrder, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), t.name, t.kind, sanitizeDoc(t.body), String(i + 1), ts, 'system', ts, 'system'));
    db.prepare("INSERT INTO meta VALUES ('v38_ctemplates', ?)").run(ts);
  }
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v39_annual_ctemplate'").get()) { // 연간 컨설팅 계약서 양식 추가 (같은 이름이 없을 때만)
    const ts = now();
    DEFAULT_TEMPLATES.forEach((t, i) => {
      if (db.prepare("SELECT 1 FROM ctemplates WHERE name = ? AND deletedAt = ''").get(t.name)) return;
      db.prepare('INSERT INTO ctemplates (id, name, kind, body, sortOrder, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), t.name, t.kind, sanitizeDoc(t.body), String(i + 1), ts, 'system', ts, 'system');
    });
    db.prepare("INSERT INTO meta VALUES ('v39_annual_ctemplate', ?)").run(ts);
  }
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v40_ctemplate_indent'").get()) { // 기본 양식의 번호 항목에 들여쓰기 — 아무도 고치지 않은 기본 양식만 새 내용으로
    const ts = now();
    DEFAULT_TEMPLATES.forEach((t) => db.prepare("UPDATE ctemplates SET body = ? WHERE name = ? AND createdBy = 'system' AND updatedBy = 'system' AND deletedAt = ''").run(sanitizeDoc(t.body), t.name));
    db.prepare("INSERT INTO meta VALUES ('v40_ctemplate_indent', ?)").run(ts);
  }
  ensureColumns(db, 'programs', ['name', 'category', 'target', 'schedule', 'deadline', 'url', 'memo', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']);
  // v23: "성적·재학·졸업 증명서" 칸을 서류 목록으로 합침 — 서류 줄에 안 묶인 학생 파일을 학생·분류별 서류 줄(수합 완료)로.
  // 휴지통 파일은 같은 분류 줄이 생길 때만 붙임 (휴지통 파일만 있는 분류는 줄을 만들지 않음)
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v23_certdocs'").get()) {
    const ts = now();
    db.transaction(() => {
      const loose = db.prepare("SELECT id, studentId, category, deletedAt, createdAt, createdBy FROM files WHERE docId = '' AND meetingId = '' AND followupId = '' AND scoreId = '' ORDER BY createdAt").all()
        .sort((a, b) => (a.deletedAt ? 1 : 0) - (b.deletedAt ? 1 : 0));
      const made = {};
      for (const f of loose) {
        const cat = f.category || '기타 파일', k = f.studentId + '|' + cat;
        if (!made[k]) {
          if (f.deletedAt) continue;
          made[k] = crypto.randomUUID();
          db.prepare("INSERT INTO docs (id, studentId, name, category, status, receivedAt, receivedBy, createdAt, createdBy, updatedAt, updatedBy) VALUES (?, ?, ?, ?, '수합 완료', ?, ?, ?, 'system', ?, 'system')")
            .run(made[k], f.studentId, cat, cat, f.createdAt, f.createdBy, ts, ts);
        }
        db.prepare('UPDATE files SET docId = ? WHERE id = ?').run(made[k], f.id);
      }
      db.prepare("INSERT INTO meta VALUES ('v23_certdocs', ?)").run(ts);
    })();
  }
  // v24: 대학별 공식 자료 확인 결과(2026-10-25)를 넣음 — 그 입학 연도의 주요 정보가 비어 있을 때만. 출처·지망 형식도 비어 있을 때만, 전형·마감일은 그대로
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v24_uni_research'").get() && db.prepare('SELECT 1 FROM universities LIMIT 1').get()) { // 새 DB는 대학 초기 자료가 들어간 다음 실행 때
    const RESEARCH = require('./uni-research');
    const ts = now();
    db.transaction(() => {
      for (const r of RESEARCH) {
        const u = db.prepare("SELECT id, name, aliases FROM universities WHERE deletedAt = ''").all()
          .find((x) => x.name === r.name || String(x.aliases || '').split(',').map((a) => a.trim()).includes(r.name));
        if (!u) continue;
        const cys = db.prepare("SELECT * FROM unicycles WHERE universityId = ? AND year = ? AND deletedAt = ''").all(u.id, r.year);
        const cy = cys.find((c) => c.term === r.term) || (cys.length === 1 ? cys[0] : null);
        if (!cy) continue;
        const set = {};
        let reqs = [];
        try { reqs = JSON.parse(cy.requirements || '[]'); } catch (e) { reqs = null; }
        if (Array.isArray(reqs) && !reqs.length) {
          const tracks = String(cy.tracks || '').split(',').map((x) => x.trim()).filter(Boolean);
          const tr = r.track && tracks.includes(r.track) ? r.track : '';
          set.requirements = JSON.stringify(r.requirements.map((x) => (tr && !x.common ? { item: x.item, content: x.content, track: tr } : { item: x.item, content: x.content })));
          set.memo = [cy.memo, RESEARCH.MEMO].filter(Boolean).join('\n');
        }
        if (!cy.sourceUrl && r.sourceUrl) set.sourceUrl = r.sourceUrl;
        if (r.choices && !(cy.choices && cy.choices !== '[]')) set.choices = JSON.stringify(r.choices);
        const keys = Object.keys(set);
        if (!keys.length) continue;
        db.prepare(`UPDATE unicycles SET ${keys.map((k) => k + ' = @' + k).join(', ')}, updatedAt = @t, updatedBy = 'system' WHERE id = @id`).run(Object.assign(set, { t: ts, id: cy.id }));
      }
      db.prepare("INSERT INTO meta VALUES ('v24_uni_research', ?)").run(ts);
    })();
  }
  // v25: 홍콩 5개 대학 공식 전공 목록(2026-10-25, lib/uni-majors-hk.json) — 같은 이름이 없는 전공만 추가.
  // 같은 이름이 이미 있으면 비어 있는 학부·코드·출처만 채움 (선생님이 넣은 값은 그대로)
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v25_hk_majors'").get() && db.prepare('SELECT 1 FROM universities LIMIT 1').get()) { // 새 DB는 대학 초기 자료가 들어간 다음 실행 때
    const LIST = require('./uni-majors-hk.json');
    const ts = now();
    db.transaction(() => {
      const unis = db.prepare("SELECT id, name, aliases FROM universities WHERE deletedAt = ''").all();
      for (const [uniName, majors] of Object.entries(LIST)) {
        const u = unis.find((x) => x.name === uniName || String(x.aliases || '').split(',').map((a) => a.trim()).includes(uniName));
        if (!u) continue;
        const have = {};
        db.prepare("SELECT * FROM unimajors WHERE universityId = ? AND deletedAt = ''").all(u.id).forEach((m) => { have[m.name.trim().toLowerCase()] = m; });
        for (const m of majors) {
          const cur = have[m.name.trim().toLowerCase()];
          if (cur) {
            const set = ['faculty', 'code', 'sourceUrl'].filter((k) => !cur[k] && m[k]);
            if (set.length) db.prepare(`UPDATE unimajors SET ${set.map((k) => k + ' = @' + k).join(', ')} WHERE id = @id`).run(Object.assign({ id: cur.id }, ...set.map((k) => ({ [k]: m[k] }))));
            continue;
          }
          db.prepare("INSERT INTO unimajors (id, universityId, name, faculty, code, detail, sourceUrl, createdAt, createdBy, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', ?, 'system')")
            .run(crypto.randomUUID(), u.id, m.name, m.faculty || '', m.code || '', m.detail || '', m.sourceUrl || '', ts, ts);
          have[m.name.trim().toLowerCase()] = m;
        }
      }
      db.prepare("INSERT INTO meta VALUES ('v25_hk_majors', ?)").run(ts);
    })();
  }
  // v26: HKU 전공을 원서 지원 단위(HKU International Admissions 2026 안내서의 57개 프로그램 + 예상 최저선)로.
  // v25가 넣은 웹 전공 소개 목록(“Bachelor of Arts (Major in …)” 등) 중 선생님이 고치지 않았고 학생 지원대학에 연결되지 않은 것만 휴지통으로
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v26_hku_programmes'").get() && db.prepare("SELECT 1 FROM meta WHERE key = 'v25_hk_majors'").get()) {
    const NEW = require('./hku-programmes-2026.json');
    const OLD = require('./uni-majors-hk.json').HKU || [];
    const key = (s) => String(s || '').trim().toLowerCase();
    const ts = now();
    db.transaction(() => {
      const u = db.prepare("SELECT id, name, aliases FROM universities WHERE deletedAt = ''").all()
        .find((x) => x.name === 'HKU' || String(x.aliases || '').split(',').map((a) => a.trim()).includes('HKU'));
      if (u) {
        const newNames = new Set(NEW.map((m) => key(m.name))), oldNames = new Set(OLD.map((m) => key(m.name)));
        const used = new Set(db.prepare("SELECT majorId FROM apps WHERE majorId != '' AND deletedAt = ''").all().map((r) => r.majorId));
        const have = {};
        for (const m of db.prepare("SELECT * FROM unimajors WHERE universityId = ? AND deletedAt = ''").all(u.id)) {
          const k = key(m.name);
          if (m.createdBy === 'system' && m.updatedBy === 'system' && oldNames.has(k) && !newNames.has(k) && !used.has(m.id)) {
            db.prepare("UPDATE unimajors SET deletedAt = ?, deletedBy = 'system' WHERE id = ?").run(ts, m.id);
          } else have[k] = m;
        }
        for (const m of NEW) {
          const cur = have[key(m.name)];
          if (cur) {
            // 이번 자동 입력으로 들어간 줄은 새 내용으로, 선생님이 만든·고친 줄은 빈 칸만 채움
            const set = cur.updatedBy === 'system' ? ['faculty', 'code', 'sourceUrl', 'detail'] : ['faculty', 'code', 'sourceUrl', 'detail'].filter((k) => !cur[k]);
            if (set.length) db.prepare(`UPDATE unimajors SET ${set.map((k) => k + ' = @' + k).join(', ')} WHERE id = @id`).run(Object.assign({ id: cur.id }, ...set.map((k) => ({ [k]: m[k] || '' }))));
            continue;
          }
          db.prepare("INSERT INTO unimajors (id, universityId, name, faculty, code, detail, sourceUrl, createdAt, createdBy, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', ?, 'system')")
            .run(crypto.randomUUID(), u.id, m.name, m.faculty, m.code, m.detail, m.sourceUrl, ts, ts);
        }
      }
      db.prepare("INSERT INTO meta VALUES ('v26_hku_programmes', ?)").run(ts);
    })();
  }
  // v27: HKU 전공 메모를 2027 입학 기준으로 (HKU International Admissions 2027 안내서·입학처 Admissions Standards).
  // 자동 입력된 줄은 새 내용으로, 선생님이 만든·고친 줄은 빈 칸만 채움. 새 프로그램 추가. 주요 정보의 "전공별 최저 기준 확인 못 함"도 고침(자동 입력 그대로일 때만)
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v27_hku_2027'").get() && db.prepare("SELECT 1 FROM meta WHERE key = 'v26_hku_programmes'").get()) {
    const NEW = require('./hku-programmes-2027.json');
    // 이름 비교는 영문·숫자만 (띄어쓰기·* 표시 차이 무시)
    const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const ts = now();
    db.transaction(() => {
      const u = db.prepare("SELECT id, name, aliases FROM universities WHERE deletedAt = ''").all()
        .find((x) => x.name === 'HKU' || String(x.aliases || '').split(',').map((a) => a.trim()).includes('HKU'));
      if (u) {
        const have = {};
        db.prepare("SELECT * FROM unimajors WHERE universityId = ? AND deletedAt = ''").all(u.id).forEach((m) => { have[key(m.name)] = m; });
        for (const m of NEW) {
          const cur = have[key(m.name)];
          if (cur) {
            const set = cur.updatedBy === 'system' ? ['faculty', 'code', 'sourceUrl', 'detail'] : ['faculty', 'code', 'sourceUrl', 'detail'].filter((k) => !cur[k]);
            if (set.length) db.prepare(`UPDATE unimajors SET ${set.map((k) => k + ' = @' + k).join(', ')}, updatedAt = @t WHERE id = @id`).run(Object.assign({ id: cur.id, t: ts }, ...set.map((k) => ({ [k]: m[k] || '' }))));
            continue;
          }
          db.prepare("INSERT INTO unimajors (id, universityId, name, faculty, code, detail, sourceUrl, createdAt, createdBy, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', ?, 'system')")
            .run(crypto.randomUUID(), u.id, m.name, m.faculty, m.code, m.detail, m.sourceUrl, ts, ts);
        }
        for (const cy of db.prepare("SELECT id, requirements FROM unicycles WHERE universityId = ? AND year = '2027' AND updatedBy = 'system' AND deletedAt = ''").all(u.id)) {
          let reqs; try { reqs = JSON.parse(cy.requirements || '[]'); } catch (e) { continue; }
          const i = reqs.findIndex((r) => r.item === '확인 못 함' && /^전공별 AP\/IB\/SAT 최저 기준/.test(r.content || ''));
          if (i < 0) continue;
          reqs[i] = { item: '전공별 최저 기준', content: '아래 전공 리스트의 각 프로그램 메모 (IB·A-level·SAT/AP, 과목 요건, 면접) — HKU International Admissions 2027 안내서: https://admissions.hku.hk/sites/default/files/2026-09/HKU-International-Admissions-Information-2027.pdf' };
          db.prepare('UPDATE unicycles SET requirements = ?, updatedAt = ? WHERE id = ?').run(JSON.stringify(reqs), ts, cy.id);
        }
      }
      db.prepare("INSERT INTO meta VALUES ('v27_hku_2027', ?)").run(ts);
    })();
  }
  // v28: 캐나다 3개 대학(2026-10-26 조사) — McGill·UBC 주요 정보(빈 연도에만), McGill·UBC·토론토대 전공(지원 단위) 목록.
  // v24·v25와 같은 규칙: 선생님이 넣은 주요 정보는 그대로, 같은 이름 전공은 빈 칸만 채움
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v28_canada'").get() && db.prepare('SELECT 1 FROM universities LIMIT 1').get()) {
    const RESEARCH = require('./uni-research-canada');
    const MAJORS = require('./uni-majors-canada.json');
    const ts = now();
    const unis = db.prepare("SELECT id, name, aliases FROM universities WHERE deletedAt = ''").all();
    const findUni = (n) => unis.find((x) => x.name === n || String(x.aliases || '').split(',').map((a) => a.trim()).includes(n));
    db.transaction(() => {
      for (const r of RESEARCH) {
        const u = findUni(r.name);
        if (!u) continue;
        const cys = db.prepare("SELECT * FROM unicycles WHERE universityId = ? AND year = ? AND deletedAt = ''").all(u.id, r.year);
        const cy = cys.find((c) => c.term === r.term) || (cys.length === 1 ? cys[0] : null);
        if (!cy) continue;
        const set = {};
        let reqs; try { reqs = JSON.parse(cy.requirements || '[]'); } catch (e) { reqs = null; }
        if (Array.isArray(reqs) && !reqs.length) {
          set.requirements = JSON.stringify(r.requirements);
          set.memo = [cy.memo, RESEARCH.MEMO].filter(Boolean).join('\n');
        }
        if (!cy.sourceUrl && r.sourceUrl) set.sourceUrl = r.sourceUrl;
        if (r.choices && !(cy.choices && cy.choices !== '[]')) set.choices = JSON.stringify(r.choices);
        const keys = Object.keys(set);
        if (keys.length) db.prepare(`UPDATE unicycles SET ${keys.map((k) => k + ' = @' + k).join(', ')}, updatedAt = @t, updatedBy = 'system' WHERE id = @id`).run(Object.assign(set, { t: ts, id: cy.id }));
      }
      const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const [uniName, majors] of Object.entries(MAJORS)) {
        const u = findUni(uniName);
        if (!u) continue;
        const have = {};
        db.prepare("SELECT * FROM unimajors WHERE universityId = ? AND deletedAt = ''").all(u.id).forEach((m) => { have[key(m.name)] = m; });
        for (const m of majors) {
          const cur = have[key(m.name)];
          if (cur) {
            const set = ['faculty', 'code', 'sourceUrl', 'detail'].filter((k) => !cur[k] && m[k]);
            if (set.length) db.prepare(`UPDATE unimajors SET ${set.map((k) => k + ' = @' + k).join(', ')} WHERE id = @id`).run(Object.assign({ id: cur.id }, ...set.map((k) => ({ [k]: m[k] }))));
            continue;
          }
          db.prepare("INSERT INTO unimajors (id, universityId, name, faculty, code, detail, sourceUrl, createdAt, createdBy, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', ?, 'system')")
            .run(crypto.randomUUID(), u.id, m.name, m.faculty || '', m.code || '', m.detail || '', m.sourceUrl || '', ts, ts);
          have[key(m.name)] = m;
        }
      }
      db.prepare("INSERT INTO meta VALUES ('v28_canada', ?)").run(ts);
    })();
  }
  // v29: 대학 지도 — 캠퍼스 위치가 비어 있는 대학에 대략 위치를 넣음(approx 표시, 대학 정보 수정에서 고침)
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v29_campuses'").get() && db.prepare('SELECT 1 FROM universities LIMIT 1').get()) {
    const POS = require('./campus-positions.json');
    const ts = now();
    db.transaction(() => {
      for (const u of db.prepare("SELECT id, name, aliases, campuses FROM universities WHERE deletedAt = ''").all()) {
        if (u.campuses && u.campuses !== '[]') continue;
        const names = [u.name].concat(String(u.aliases || '').split(',').map((a) => a.trim())).filter(Boolean);
        const hit = names.map((n) => POS[n]).find(Boolean);
        if (hit) db.prepare('UPDATE universities SET campuses = ? WHERE id = ?').run(JSON.stringify(hit.map((c) => Object.assign({}, c, { approx: true }))), u.id);
      }
      db.prepare("INSERT INTO meta VALUES ('v29_campuses', ?)").run(ts);
    })();
  }
  // v30: 지점(상해·압구정) — 지금까지 자료는 모두 상해. 미팅·상담 시간은 중국 시간으로 적은 것
  ensureColumns(db, 'teachers', ['branch', 'tz', 'viewTz']); // tz: 지점이 '전체'인 계정의 화면 시간, viewTz: My Page에서 직접 고른 화면 시간('' = 지점 기준)
  db.exec('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY)');
  ensureColumns(db, 'events', ['branch', 'shared', 'time', 'tz']); // shared: 'TRUE' = 전체 지점에 보임, time: 'HH:MM' (없으면 하루 종일)
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'v30_branches'").get()) {
    db.transaction(() => {
      for (const t of ['teachers', 'students', 'events']) db.prepare(`UPDATE ${t} SET branch = ? WHERE branch = ''`).run(BRANCHES[0]);
      for (const t of ['meetings', 'notes']) db.prepare(`UPDATE ${t} SET tz = ? WHERE tz = ''`).run(BRANCH_TZ[BRANCHES[0]]);
      db.prepare("INSERT INTO meta VALUES ('v30_branches', ?)").run(now());
    })();
  }
  // v9: 메인 화면 공용 달력 (SAT 시험일 등 모두가 함께 보는 일정)
  // 학교 방학 (목록 관리 › 학교) — 달력에는 "방학 n곳" 한 줄, 학생 화면·오늘 챙길 일·학생 목록 필터
  db.exec('CREATE TABLE IF NOT EXISTS schoolbreaks (id TEXT PRIMARY KEY)');
  ensureColumns(db, 'schoolbreaks', ['school', 'name', 'startDate', 'endDate', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']);
  db.exec('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY)');
  ensureColumns(db, 'events', ['date', 'endDate', 'title', 'category', 'memo', 'private', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']); // private: 'TRUE' = 등록한 사람만 보임
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

const SEED_NOTE_RE = /^Compass 초기 자료\(2026-10-16 조사\)\. 공식 사이트에서 확인한 뒤 "확인 완료"로 바꿔주세요\.\n?/;
function stripSeedNote(m) { return String(m || '').replace(SEED_NOTE_RE, ''); }
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
      // 지원 요건은 비워 둠 — 선생님이 공식 사이트를 보고 직접 채움 (마감일·출처는 처음 자료 그대로)
      ins('unicycles', Object.assign({ id: cid, universityId: uid, year: c.year, term: c.term, requirements: '[]',
        sourceUrl: c.sourceUrl || '', status: '', memo: stripSeedNote(c.memo) }, meta));
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
  /** 고를 수 있는 시간대 = 지점 시간대 + 목록 관리 › 시간대 */
  const refreshTz = () => {
    const list = Object.values(BRANCH_TZ).concat(db.prepare("SELECT category FROM options WHERE kind = 'tz' AND category != ''").all().map((r) => r.category));
    TZS.length = 0; [...new Set(list)].forEach((z) => TZS.push(z));
  };
  refreshTz();
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
  /** 학생 자료를 고칠 수 있는지: 관리자 = 전부, 관리팀 = 같은 지점 학생 (다른 지점은 팔로업·상담기록 추가와 내가 쓴·내 담당 것만), 컨설턴트 = 담당 학생 */
  function requireEdit(me, s, table, cur) {
    if (me.role !== 'staff' || me.branch === ALL_BRANCH || branchOf(me) === branchOf(s)) return;
    if (CROSS_BRANCH_TABLES.includes(table) && (!cur || cur.createdBy === me.email || cur.assignee === me.email)) return;
    throw new UserError(branchOf(s) + ' 지점 학생입니다. 다른 지점 학생은 보기와 팔로업·상담기록 추가만 할 수 있습니다 (수정은 ' + branchOf(s) + ' 관리팀·관리자).', 403);
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
  /** 개발자: 다른 계정으로 로그인 — 그 계정의 새 세션을 만들어 돌려줌 (변경 기록에는 남기지 않음) */
  function loginAs(me, email) {
    if (!me || !me.dev) throw new UserError('개발자만 다른 계정으로 로그인할 수 있습니다.', 403);
    const t = getTeacher(email);
    if (!t || !t.active) throw new UserError('활성 계정이 아닙니다.', 404);
    if (t.email === me.email) throw new UserError('지금 로그인한 계정입니다.');
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(sha256(token), t.email, now(), Date.now() + 86400000); // 하루만
    return token;
  }
  function logout(token) { if (token) db.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(sha256(token)); }

  /** 세션 토큰 → 로그인한 사용자 (없거나 비활성이면 null) */
  function authenticate(token) {
    if (!token) return null;
    const row = db.prepare(`SELECT t.*, s.expiresAt FROM sessions s JOIN teachers t ON t.email = s.email
      WHERE s.tokenHash = ?`).get(sha256(token));
    if (!row || !row.active || row.expiresAt < Date.now()) return null;
    return { email: row.email, name: row.name, role: row.role === 'developer' ? 'admin' : ROLES.includes(row.role) ? row.role : 'consultant', dev: row.role === 'developer', branch: accountBranch(row), tz: accountTz(row), branchTz: branchTz(row), viewTz: TZS.includes(row.viewTz) ? row.viewTz : '',
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
    const meRow = getTeacher(me.email) || me; // 화면 시간은 저장된 계정 정보로 (방금 바꾼 값 포함)
    const out = {
      me: { email: me.email, name: me.name, role: me.role, dev: !!me.dev, branch: accountBranch(me), tz: accountTz(meRow), branchTz: branchTz(meRow), viewTz: TZS.includes(meRow.viewTz) ? meRow.viewTz : '', mustChangePassword: !!me.mustChangePassword,
        homeLayout: parseLayout((db.prepare('SELECT homeLayout FROM teachers WHERE email = ?').get(me.email) || {}).homeLayout), viewPrefs: parseViewPrefs(meRow.viewPrefs), fuOrder: parseFuOrder(meRow.fuOrder), prefs: parsePrefs(meRow.uiPrefs) },
      homeDefault: parseLayout(getMeta('homeLayoutDefault')),
      studentCols: parseCols(getMeta('studentCols')),
      uploadMB: uploadMB(),
      site: siteSettings(),
      branches: BRANCHES, branchTz: BRANCH_TZ,
      teachers: db.prepare("SELECT email, name, role, active, notify, color, sortOrder, branch, tz FROM teachers ORDER BY CASE WHEN sortOrder = '' OR sortOrder IS NULL THEN 1 ELSE 0 END, CAST(sortOrder AS INTEGER), name").all()
        .map((t) => ({ email: t.email, name: t.name, role: t.role, active: !!t.active, notify: t.notify !== 'off', color: t.color || '', sortOrder: Number(t.sortOrder) || 0, branch: accountBranch(t), tz: accountTz(t) })),
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
        .filter((r) => ids.has(r.studentId) && !(t === 'files' && r.contractId && !isManager(me))).map((r) => publicRow(t, r, me)); // 계약서 파일은 관리자·관리팀만
    }
    out.prices = isManager(me) ? getPriceList() : null;
    out.appforms = appforms.formList();
    out.appdrafts = db.prepare('SELECT id, formId, studentId, title, done, createdBy, updatedAt, updatedBy FROM appdrafts ORDER BY updatedAt DESC').all()
      .filter((r) => (r.studentId ? ids.has(r.studentId) : r.createdBy === me.email));
    out.ctemplates = isManager(me) ? db.prepare("SELECT * FROM ctemplates WHERE deletedAt = '' ORDER BY CAST(sortOrder AS INTEGER), name").all() : [];
    out.options = db.prepare('SELECT id, kind, value, sortOrder, url, category, color, fullName, country, city, info FROM options').all();
    out.programs = db.prepare('SELECT * FROM programs ORDER BY name').all();
    out.breaks = db.prepare('SELECT id, school, name, startDate, endDate FROM schoolbreaks ORDER BY startDate').all();
    out.events = db.prepare("SELECT * FROM events WHERE private != 'TRUE' OR createdBy = ? ORDER BY date, title").all(me.email); // 나만 보기 일정은 등록한 사람에게만
    out.unifiles = db.prepare('SELECT id, universityId, cycleId, programId, category, name, memo, mime, size, createdAt, createdBy FROM unifiles ORDER BY createdAt DESC').all();
    // 원장님 상담 일정 (구글 시트) — 볼 수 있는 학생 것만, 최근 120일부터
    const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
    out.sched = db.prepare('SELECT key, studentId, startAt, endAt, title, detail, zone, sheetLabel FROM sched WHERE startAt >= ? ORDER BY startAt').all(since).filter((r) => ids.has(r.studentId));
    // 확인 요청: 관리자·관리팀은 전부, 컨설턴트는 나에게 온 것·내가 보낸 것 (볼 수 있는 학생만, 상담기록 건은 제외)
    out.reviews = db.prepare('SELECT * FROM reviews ORDER BY createdAt DESC').all()
      .filter((r) => ids.has(r.studentId) && (isManager(me) || ((r.toEmail === me.email || r.fromEmail === me.email) && r.refTable !== 'notes')));
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
      if (rec.packages) rec.packages = [...new Set(String(rec.packages).split(',').map((x) => x.trim()).filter(Boolean).map((x) => OLD_PACKAGES[x] || x))].join(', ');
      for (const k of ['startDate', 'endDate']) if (v(k) && !DATE_RE.test(v(k))) throw new UserError('계약 날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)');
      if (v('startDate') && v('endDate') && v('endDate') < v('startDate')) throw new UserError('계약 종료일이 시작일보다 빠릅니다.');
      if ('items' in rec) { // 가격표 패키지: 정해진 칸만, 정가 합계는 여기서 계산
        let a; try { a = JSON.parse(rec.items || '[]'); } catch (e) { a = null; }
        if (!Array.isArray(a) || a.length > 40) throw new UserError('패키지 선택이 올바르지 않습니다.');
        const items = a.map((x) => {
          const o = {}; ['pid', 'region', 'kind', 'name', 'sessions', 'schools', 'notice'].forEach((k) => { o[k] = clean(x && x[k]).slice(0, 500); });
          o.price = String(Number(String(x && x.price).replace(/[^\d.]/g, '')) || 0); o.qty = String(Math.max(1, Math.min(20, parseInt(x && x.qty, 10) || 1)));
          if (!o.name) throw new UserError('패키지 이름이 비어 있습니다.');
          return o;
        });
        rec.items = items.length ? JSON.stringify(items) : '';
        rec.listPrice = items.length ? String(items.reduce((t, x) => t + Number(x.price) * Number(x.qty), 0)) : '';
      }
    }
    if (table === 'meetings' && v('nextDate') && !DATE_RE.test(v('nextDate'))) throw new UserError('다음 미팅 날짜 형식이 올바르지 않습니다.');
    if (table === 'followups') {
      for (const [k, t] of [['meetingId', 'meetings'], ['noteId', 'notes']]) {
        if (!v(k)) continue;
        const r = getRow(t, v(k));
        if (!r || r.studentId !== v('studentId')) throw new UserError('팔로업을 연결할 기록을 찾을 수 없습니다.');
      }
    }
    if (table === 'apps') {
      need('university', '대학명은 필수입니다.');
      let mc;
      try { mc = JSON.parse(v('majorChoices') || '[]'); } catch (e) { mc = null; }
      if (!Array.isArray(mc) || mc.length > 20 || mc.some((x) => !x || typeof x.label !== 'string' || typeof x.major !== 'string' || x.label.length > 30 || x.major.length > 200)) {
        throw new UserError('추가 지망 전공 형식이 올바르지 않습니다.');
      }
    }
    if (table === 'contracts') need('kind', '계약 종류(연간/원서)를 선택하세요.');
    if (table === 'scores') need('kind', '시험 종류를 선택하세요.');
    if (table === 'activities') need('name', '활동 이름을 입력하세요.');
    if (table === 'docs') need('name', '서류 이름을 입력하세요.');
    if (table === 'links') { need('url', '링크 주소를 입력하세요.'); checkUrl(v('url')); }
    if (table === 'files') need('name', '파일 이름을 입력하세요.');
    if (table === 'appinfo') {
      need('item', '항목 이름을 입력하세요. (예: 추천인 1)');
      if (!['content', 'recName', 'recTitle', 'recSubject', 'recEmail'].some((k) => String(v(k) || '').trim())) throw new UserError('내용을 입력하세요.');
      if (v('recEmail') && !isEmail(String(v('recEmail')).trim())) throw new UserError('추천인 이메일 형식이 올바르지 않습니다.');
    }
    if (table === 'cdocs') {
      if (!v('contractId') || !getRow('contracts', v('contractId')) || getRow('contracts', v('contractId')).deletedAt || getRow('contracts', v('contractId')).studentId !== v('studentId')) throw new UserError('계약을 찾을 수 없습니다. 새로고침 해주세요.', 404);
      need('title', '계약서 제목을 입력하세요.');
      if (v('status') && !CDOC_STATUS.includes(v('status'))) throw new UserError('계약서 상태가 올바르지 않습니다.');
      if (v('signMethod') && !SIGN_METHODS.includes(v('signMethod'))) throw new UserError('서명 방식이 올바르지 않습니다.');
      for (const k of ['sentAt', 'signedAt']) if (v(k) && !DATE_RE.test(v(k))) throw new UserError('날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)');
      checkUrl(v('signUrl'), '전자서명 링크');
    }
    if (table === 'semesters') {
      for (const k of ['startDate', 'endDate']) if (v(k) && !DATE_RE.test(v(k))) throw new UserError('학기 날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)');
      if (v('startDate') && v('endDate') && v('endDate') < v('startDate')) throw new UserError('학기 종료일이 시작일보다 빠릅니다.');
      if (!String(v('grade') || '').trim() && !v('startDate')) throw new UserError('학년이나 학기 시작일을 입력하세요.');
    }
    if (table === 'followups') {
      need('title', '할 일을 입력하세요.');
      if (v('status') && !FOLLOWUP_STATUS.includes(v('status'))) throw new UserError('상태가 올바르지 않습니다.');
      if (v('due') && !/^\d{4}-\d{2}-\d{2}$/.test(v('due'))) throw new UserError('기한 형식이 올바르지 않습니다.');
      if (!FOLLOWUP_KINDS.includes(v('kind') || '')) throw new UserError('종류가 올바르지 않습니다.');
      if (v('fromWho') && !CONTACT_FROM.includes(v('fromWho'))) throw new UserError('보낸 사람이 올바르지 않습니다.');
      if (v('remindAt') && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v('remindAt'))) throw new UserError('알림 시각이 올바르지 않습니다.');
      if (v('remindTo')) for (const x of v('remindTo').split(',').map((y) => y.trim()).filter(Boolean)) {
        if (x !== '@assignee' && !(getTeacher(x) || {}).active) throw new UserError('알림 받을 선생님을 찾을 수 없습니다: ' + x);
      }
      if (v('channel') && !CONTACT_CHANNELS.includes(v('channel')) && !CONTACT_CHANNELS_OLD.includes(v('channel'))) throw new UserError('연락 경로가 올바르지 않습니다.');
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
    if (table === 'followups' && String(v('topic') || '').length > 60) throw new UserError('주제는 60자 이내로 적어주세요.');
    if (table === 'fureplies') {
      const f = getRow('followups', v('followupId'));
      if (!f || f.deletedAt || f.studentId !== v('studentId')) throw new UserError('팔로업을 찾을 수 없습니다. 새로고침 해주세요.', 404);
      if (!String(v('content') || '').trim()) throw new UserError('답변 내용을 입력하세요.');
      if (!String(v('who') || '').trim() || String(v('who')).length > 30) throw new UserError('답변한 사람을 고르세요.');
      if (v('date') && !DATE_RE.test(v('date'))) throw new UserError('답변 날짜 형식이 올바르지 않습니다.');
    }
    if (table === 'students') checkUrl(v('meetingUrl'), '미팅 회의록 링크');
    if (table === 'students' && v('branch') && !BRANCHES.includes(v('branch'))) throw new UserError('지점이 올바르지 않습니다.');
    if ((table === 'meetings' || table === 'notes') && v('tz') && !TZS.includes(v('tz'))) throw new UserError('시간 기준(나라)이 올바르지 않습니다.');
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
      // 서식 있는 글 (회의록·상담 내용, 팔로업 할 일·세부 내용): 허용한 서식만 남기고, 검색·메일용 일반 글은 여기서 다시 만듦
      for (const [hk, tk] of [['contentHtml', 'content'], ['titleHtml', 'title'], ['detailHtml', 'detail']]) {
        if (!TABLES[table].fields.includes(hk)) continue;
        if (hk in obj) {
          const raw = String(obj[hk] || '');
          if (raw.length > 400000) throw new UserError('내용이 너무 깁니다. 나눠서 기록해주세요.');
          const html = sanitizeRich(raw), text = richToText(html).replace(/\n+$/, '');
          if (hk !== 'contentHtml' && !text.trim() && String(obj[tk] || '').trim()) { rec[hk] = ''; continue; } // 서식 칸이 비었으면 보낸 일반 글 그대로
          rec[tk] = text;
          rec[hk] = hasFormatting(html) ? html : '';
        } else if (hk !== 'contentHtml' && tk in obj) rec[hk] = ''; // 일반 글만 고치면(빠른 추가·체크 등) 예전 서식은 버림
      }
      if (table === 'cdocs' && 'body' in obj) rec.body = sanitizeDoc(String(obj.body || '')); // 계약서 본문: 표·제목·정렬까지 허용 (clean 의 2만 자 제한 대신)
      if ('counselor' in rec) rec.counselor = lower(rec.counselor);
      // 컨설턴트에게 숨겨진 칸은 새로 쓰거나 고칠 수도 없음
      if (!isManager(me)) (HIDDEN_FOR_CONSULTANT[table] || []).forEach((k) => delete rec[k]);
      const t = now();
      if (obj.id) {
        const cur = getRow(table, obj.id);
        if (!cur || cur.deletedAt) throw new UserError('다른 선생님이 이미 삭제한 항목입니다. 새로고침 해주세요.', 409);
        if (table === 'students') {
          requireEdit(me, requireStudent(me, cur.id), table, cur);
          if (!isManager(me)) { delete rec.counselor; delete rec.manager; delete rec.branch; } // 컨설턴트는 담당자·지점 변경 불가
        } else {
          requireEdit(me, requireStudent(me, cur.studentId), table, cur);
          if (rec.studentId && rec.studentId !== cur.studentId) requireEdit(me, requireStudent(me, rec.studentId), table, null);
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
        if ((table === 'majorplans' || table === 'apps') && 'parentConfirmed' in rec && (rec.parentConfirmed === 'TRUE') !== (cur.parentConfirmed === 'TRUE')) {
          rec.parentConfirmedAt = rec.parentConfirmed === 'TRUE' ? t : '';
          rec.parentConfirmedBy = rec.parentConfirmed === 'TRUE' ? me.email : '';
        }
        if (table === 'apps' && 'status' in rec && rec.status !== cur.status) { // 제출완료로 바뀌면 날짜·사람, 준비 단계로 되돌리면 지움
          if (rec.status === '제출완료' && !cur.submittedAt) { rec.submittedAt = t.slice(0, 10); rec.submittedBy = me.email; }
          if (rec.status === '준비중' || rec.status === '작성중' || rec.status === '보류') { rec.submittedAt = ''; rec.submittedBy = ''; }
        }
        if (table === 'appinfo' && 'sent' in rec && (rec.sent === 'TRUE') !== (cur.sent === 'TRUE')) {
          rec.sentAt = rec.sent === 'TRUE' ? t : '';
          rec.sentBy = rec.sent === 'TRUE' ? me.email : '';
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
          if (!rec.branch) rec.branch = branchOf(me); // 전체 계정이면 첫 지점(상해) — 등록 창에서 고름
          if (me.role === 'staff' && me.branch !== ALL_BRANCH && rec.branch !== branchOf(me)) throw new UserError('다른 지점 학생은 그 지점 관리팀·관리자가 등록합니다.', 403);
        } else {
          if (!rec.studentId) throw new UserError('학생이 지정되지 않았습니다.');
          requireEdit(me, requireStudent(me, rec.studentId), table, null);
          if ((table === 'meetings' || table === 'notes') && !rec.tz) rec.tz = accountTz(me);
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
          if (!rec.universityId) throw new UserError('대학은 목록에서 선택하세요. 목록에 없으면 관리자·관리팀에게 대학 추가를 요청하세요.');
          if (rec.parentConfirmed === 'TRUE') { rec.parentConfirmedAt = t; rec.parentConfirmedBy = me.email; }
        }
        if (table === 'appinfo' && rec.sent === 'TRUE') { rec.sentAt = t; rec.sentBy = me.email; }
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
      if (arg.review && result) addReviews(me, table, result, arg.review);
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
      checkUrl(v('website'), '홈페이지'); checkUrl(v('portalUrl'), '원서 접수(포털) 주소');
      const dup = db.prepare("SELECT id FROM universities WHERE name = ? AND deletedAt = ''").get(v('name'));
      if (dup && (!cur || dup.id !== cur.id)) throw new UserError('같은 이름의 대학이 이미 있습니다.');
      let cps;
      try { cps = JSON.parse(v('campuses') || '[]'); } catch (e) { cps = null; }
      const num = (x, m) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= m;
      if (!Array.isArray(cps) || cps.length > 10 || cps.some((c) => !c || typeof c.name !== 'string' || c.name.length > 60 || !num(c.lat, 90) || !num(c.lng, 180))) {
        throw new UserError('캠퍼스 위치 형식이 올바르지 않습니다. (위도 -90~90, 경도 -180~180, 최대 10곳)');
      }
    }
    if (table === 'unicycles') {
      if (!/^\d{4}$/.test(v('year'))) throw new UserError('입학 연도를 4자리 숫자로 입력하세요. (예: 2027)');
      need('term', '입학 학기를 선택하세요.');
      if (v('status') && !CYCLE_STATUS.includes(v('status'))) throw new UserError('상태는 "확인 필요" 또는 "확인 완료"만 가능합니다.');
      checkUrl(v('sourceUrl'), '출처 링크');
      let reqs;
      try { reqs = JSON.parse(v('requirements') || '[]'); } catch (e) { reqs = null; }
      if (!Array.isArray(reqs) || reqs.some((x) => !x || typeof x !== 'object')) throw new UserError('주요 정보 형식이 올바르지 않습니다.');
      let ch;
      try { ch = JSON.parse(v('choices') || '[]'); } catch (e) { ch = null; }
      if (!Array.isArray(ch) || ch.length > 6 || ch.some((x) => !x || typeof x.label !== 'string' || !x.label.trim() || x.label.length > 30 || !Number.isInteger(x.n) || x.n < 1 || x.n > 5)) {
        throw new UserError('전공 지망 형식이 올바르지 않습니다. (칸 이름 30자 이내, 칸마다 1~5개, 최대 6칸)');
      }
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
          if (!isManager(me)) UNI_ADMIN_FIELDS.forEach((k) => delete rec[k]);
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
        if (table === 'universities') requireManager(me, '대학 추가');
        else requireUni(rec.universityId);
        if (table === 'unicycles') {
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

  /** 전공 여러 개 한 번에 추가 (붙여넣기) — 같은 이름(대소문자 무시)이 이미 있으면 건너뜀 */
  function addMajorsMany(me, arg) {
    arg = arg || {};
    const u = requireUni(arg.universityId);
    const rows = Array.isArray(arg.rows) ? arg.rows : [];
    if (!rows.length) throw new UserError('추가할 전공이 없습니다.');
    if (rows.length > 500) throw new UserError('한 번에 500개까지 추가할 수 있습니다.');
    const have = new Set(db.prepare("SELECT name FROM unimajors WHERE universityId = ? AND deletedAt = ''").all(u.id).map((r) => r.name.trim().toLowerCase()));
    const t = now();
    let added = 0, skipped = 0;
    tx(() => {
      for (const r of rows) {
        const name = clean(r && r.name).trim().slice(0, 200);
        if (!name || have.has(name.toLowerCase())) { skipped++; continue; }
        have.add(name.toLowerCase());
        insert('unimajors', { id: newId(), universityId: u.id, name, faculty: clean(r.faculty || '').trim().slice(0, 200), code: clean(r.code || '').trim().slice(0, 50),
          detail: '', sourceUrl: '', createdAt: t, createdBy: me.email, updatedAt: t, updatedBy: me.email });
        added++;
      }
      if (added) log(me.email, 'create', 'unimajors', u.id, u.name + ' · 전공 ' + added + '개 한 번에 추가');
    });
    return Object.assign(getAll(me), { added, skipped });
  }
  /** 학부 이름 한꺼번에 바꾸기 (그 대학에서 같은 학부로 적힌 전공 전체). to 가 이미 있는 학부면 합쳐짐 */
  function renameFaculty(me, arg) {
    arg = arg || {};
    const u = requireUni(arg.universityId);
    const from = String(arg.from == null ? '' : arg.from), to = clean(arg.to).trim().slice(0, 200);
    const n = db.prepare("UPDATE unimajors SET faculty = ?, updatedAt = ?, updatedBy = ? WHERE universityId = ? AND faculty = ? AND deletedAt = ''").run(to, now(), me.email, u.id, from).changes;
    if (n) log(me.email, 'update', 'unimajors', u.id, u.name + ' · 학부 이름 변경: ' + (from || '(학부 미지정)') + ' → ' + (to || '(학부 미지정)') + ' (' + n + '개)');
    return Object.assign(getAll(me), { changed: n });
  }

  /**
   * 백업 DB 로 지금 기록을 통째로 바꿈 (관리자, 복구 버튼). 같은 연결 안에서 표마다 지우고 백업 내용을 넣어서 전부 되거나 하나도 안 됨.
   * 로그인 상태(sessions)는 유지. 백업에 없는 표(그 뒤에 생긴 기능)는 비움. 끝나면 새 구조로 다시 맞춤(migrate)
   */
  function restoreFromDb(me, srcPath) {
    requireAdmin(me, '백업으로 복구');
    const tables = (schema) => db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name);
    const cols = (schema, t) => db.prepare(`PRAGMA ${schema}.table_info(${t})`).all().map((c) => c.name);
    db.pragma('foreign_keys = OFF');
    db.prepare('ATTACH DATABASE ? AS rs').run(srcPath);
    let counts;
    try {
      const have = new Set(tables('rs'));
      if (!have.has('students') || !have.has('teachers')) throw new UserError('Compass 백업 파일이 아닙니다 (compass.db 안에 학생·계정 표가 없음).');
      if (!db.prepare("SELECT 1 FROM rs.teachers WHERE role IN ('admin', 'developer') AND active = 1").get()) throw new UserError('백업 안에 활성 관리자 계정이 없어 복구하면 아무도 관리할 수 없습니다.');
      tx(() => {
        for (const t of tables('main')) {
          if (t === 'sessions') continue;
          db.prepare(`DELETE FROM main.${t}`).run();
          if (!have.has(t)) continue;
          const theirs = new Set(cols('rs', t));
          const c = cols('main', t).filter((x) => theirs.has(x)).map((x) => '"' + x + '"').join(', ');
          if (c) db.prepare(`INSERT INTO main.${t} (${c}) SELECT ${c} FROM rs.${t}`).run();
        }
      });
      counts = { students: db.prepare("SELECT COUNT(*) n FROM students WHERE deletedAt = ''").get().n, files: db.prepare('SELECT COUNT(*) n FROM files').get().n };
    } finally {
      db.prepare('DETACH DATABASE rs').run();
      db.pragma('foreign_keys = ON');
    }
    migrate(db); // 예전 백업이면 새 칸·기본 목록을 다시 채움
    refreshTz();
    log(me.email, 'restore', 'settings', 'backup', '백업으로 전체 복구 — 학생 ' + counts.students + '명, 파일 ' + counts.files + '개');
    return counts;
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
    // 과목은 커리큘럼마다 따로 (AP Biology · IB Biology)
    const subjCat = kind === 'subject' ? clean(arg.id ? (db.prepare('SELECT category FROM options WHERE id = ?').get(arg.id) || {}).category : arg.category).trim() : '';
    if (kind === 'subject' && !SUBJECTS[subjCat]) throw new UserError('커리큘럼을 고르세요.');
    const dup = kind === 'subject' ? db.prepare('SELECT id FROM options WHERE kind = ? AND category = ? AND value = ?').get(kind, subjCat, value)
      : db.prepare('SELECT id FROM options WHERE kind = ? AND value = ?').get(kind, value);
    if (dup && dup.id !== arg.id) throw new UserError('이미 있는 ' + OPTION_KINDS[kind] + '입니다.');
    const url = kind === 'site' ? clean(arg.url).trim() : '';
    let category = kind === 'site' ? clean(arg.category).trim() : kind === 'subject' ? subjCat : '';
    if (url) checkUrl(url, '사이트 주소');
    if (kind === 'site' && category && !ACCOUNT_CATS.includes(category)) throw new UserError('분류가 올바르지 않습니다.');
    if (kind === 'tz') { // 세계 시간대는 추가할 때만 정함 (이미 그 시간으로 적힌 기록이 있으니 나중에 바꾸지 않음)
      const cur = arg.id ? db.prepare("SELECT category FROM options WHERE id = ? AND kind = 'tz'").get(arg.id) : null;
      category = cur ? cur.category : clean(arg.zone).trim();
      if (!cur && !isRealTz(category)) throw new UserError('세계 시간대를 목록에서 고르세요. (예: Europe/Paris)');
      const same = db.prepare("SELECT id, value FROM options WHERE kind = 'tz' AND category = ?").get(category);
      if (same && same.id !== arg.id) throw new UserError('이미 “' + same.value + '”(으)로 들어 있는 시간대입니다.');
    }
    const color = kind === 'evcat' ? clean(arg.color).trim() || '#9ca3af' : '';
    if (color && !HEX_COLOR.test(color)) throw new UserError('색을 다시 골라주세요.');
    const t = now();
    let id = arg.id;
    // 학교 상세: 정식 이름·나라·도시 (보내지 않은 칸은 그대로)
    const detail = (cur) => ['fullName', 'country', 'city'].map((k) => (kind !== 'school' && !(kind === 'tz' && k === 'fullName') ? '' : k in arg ? clean(arg[k]).trim().slice(0, k === 'fullName' ? 200 : 60) : cur ? cur[k] || '' : '')); // 시간대는 fullName = 도시들
    tx(() => {
      if (id) {
        const cur = db.prepare('SELECT * FROM options WHERE id = ?').get(id);
        if (!cur || cur.kind !== kind) throw new UserError('항목을 찾을 수 없습니다. 새로고침 해주세요.', 404);
        db.prepare('UPDATE options SET value = ?, sortOrder = ?, url = ?, category = ?, color = ?, fullName = ?, country = ?, city = ?, updatedAt = ?, updatedBy = ? WHERE id = ?')
          .run(value, clean(arg.sortOrder !== undefined ? arg.sortOrder : cur.sortOrder), url, category, kind === 'evcat' ? (arg.color === undefined ? cur.color : color) : '', ...detail(cur), t, me.email, id);
        let n = 0;
        const [tbl, col] = OPTION_TARGET[kind] || []; // 시간대는 이름만 바뀜 (기록에는 세계 시간대로 저장)
        if (cur.value !== value && kind === 'track') {
          // 트랙은 학생마다 쉼표로 여러 개 → 그 이름만 바꿈
          for (const st of db.prepare("SELECT id, tracks FROM students WHERE ',' || REPLACE(tracks, ', ', ',') || ',' LIKE ?").all('%,' + cur.value + ',%')) {
            const list = String(st.tracks).split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x === cur.value ? value : x));
            db.prepare('UPDATE students SET tracks = ? WHERE id = ?').run([...new Set(list)].join(', '), st.id);
            n++;
          }
          // 계약의 포함 국가·패키지도 같은 트랙 목록을 씀
          for (const c of db.prepare("SELECT id, packages FROM contracts WHERE ',' || REPLACE(packages, ', ', ',') || ',' LIKE ?").all('%,' + cur.value + ',%')) {
            const list = String(c.packages).split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x === cur.value ? value : x));
            db.prepare('UPDATE contracts SET packages = ? WHERE id = ?').run([...new Set(list)].join(', '), c.id);
            n++;
          }
        } else if (cur.value !== value && kind === 'subject') { // 그 커리큘럼으로 입력된 점수·수강 과목만 함께
          n = renameSubject(cur.category, cur.value, value);
        } else if (cur.value !== value && tbl) {
          n = db.prepare(`UPDATE ${tbl} SET ${col} = ? WHERE ${col} = ?`).run(value, cur.value).changes;
          if (kind === 'school') db.prepare('UPDATE schoolbreaks SET school = ? WHERE school = ?').run(value, cur.value); // 방학도 함께
          if (kind === 'doccat') n += db.prepare('UPDATE docs SET category = ? WHERE category = ?').run(value, cur.value).changes;
        }
        log(me.email, 'update', 'options', id, OPTION_KINDS[kind] + ' ' + cur.value + (cur.value !== value ? ' → ' + value + (n ? ' (' + n + '건 함께 변경)' : '') : ''));
      } else {
        id = newId();
        const so = arg.sortOrder !== undefined ? clean(arg.sortOrder)
          : String((db.prepare('SELECT MAX(CAST(sortOrder AS INTEGER)) n FROM options WHERE kind = ?').get(kind).n || 0) + 1);
        db.prepare('INSERT INTO options (id, kind, value, sortOrder, url, category, color, fullName, country, city, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, kind, value, so, url, category, color, ...detail(null), t, me.email, t, me.email);
        log(me.email, 'create', 'options', id, OPTION_KINDS[kind] + ' ' + value);
      }
      if (kind === 'school' && arg.info !== undefined) { // 학교 상세: 정해진 칸만, 글자 수 제한
        const src = arg.info && typeof arg.info === 'object' ? arg.info : {}, info = {};
        SCHOOL_INFO.forEach((k) => { const x = clean(src[k]).trim().slice(0, 500); if (x) info[k] = x; });
        db.prepare('UPDATE options SET info = ? WHERE id = ?').run(Object.keys(info).length ? JSON.stringify(info) : '', id);
      }
    });
    if (kind === 'tz') refreshTz();
    return Object.assign(getAll(me), { savedId: id });
  }
  /** 자동 표시 항목: 색·보이기만 (이름 고정, 추가·삭제 없음) */
  function saveAutoCat(me, arg) {
    requireManager(me, '목록 관리');
    const cur = db.prepare("SELECT * FROM options WHERE id = ? AND kind = 'evauto'").get(arg && arg.id);
    if (!cur) throw new UserError('항목을 찾을 수 없습니다. 새로고침 해주세요.', 404);
    const color = arg.color === undefined ? cur.color : clean(arg.color).trim().toLowerCase();
    if (!HEX_COLOR.test(color)) throw new UserError('색을 다시 골라주세요.');
    const hidden = arg.hidden === undefined ? cur.category === 'off' : !!arg.hidden;
    db.prepare('UPDATE options SET color = ?, category = ?, updatedAt = ?, updatedBy = ? WHERE id = ?').run(color, hidden ? 'off' : '', now(), me.email, cur.id);
    log(me.email, 'update', 'options', cur.id, '달력 자동 표시 ' + cur.value + ' — 색 ' + color + (hidden ? ', 숨김' : ''));
    return getAll(me);
  }
  /** 커리큘럼(목록 분류)의 과목 이름 바꾸기 → 점수(종류)·수강 과목(레벨)에서 그 과목 */
  function renameSubject(cat, from, to) {
    const kinds = Object.keys(KIND_CATS).filter((k) => KIND_CATS[k].includes(cat)), levels = Object.keys(LEVEL_CATS).filter((k) => LEVEL_CATS[k].includes(cat));
    const ph = (a) => a.map(() => '?').join(',') || "''";
    return db.prepare(`UPDATE scores SET subject = ? WHERE subject = ? AND kind IN (${ph(kinds)})`).run(to, from, ...kinds).changes +
      db.prepare(`UPDATE courses SET subject = ? WHERE subject = ? AND level IN (${ph(levels)})`).run(to, from, ...levels).changes;
  }
  /** 과목 정리: 목록에 없는 과목 글(예: Calc BC)을 목록 과목으로 한꺼번에 — table: scores·courses, group: 종류·레벨 */
  function fixSubjects(me, arg) {
    requireManager(me, '과목 정리');
    arg = arg || {};
    const table = arg.table === 'courses' ? 'courses' : arg.table === 'scores' ? 'scores' : '';
    if (!table) throw new UserError('알 수 없는 항목입니다.');
    const col = table === 'scores' ? 'kind' : 'level', group = clean(arg.group).trim(), from = clean(arg.from), to = clean(arg.to).trim();
    if (!to) throw new UserError('바꿀 과목을 고르세요.');
    const set = ['subject = ?'], vals = [to];
    if (table === 'scores' && arg.level !== undefined) { set.push('level = ?'); vals.push(['HL', 'SL'].includes(arg.level) ? arg.level : ''); }
    const t = now();
    const n = db.prepare(`UPDATE ${table} SET ${set.join(', ')}, updatedAt = ?, updatedBy = ? WHERE subject = ? AND ${col} = ? AND (deletedAt = '' OR deletedAt IS NULL)`)
      .run(...vals, t, me.email, from, group).changes;
    log(me.email, 'update', table, '', '과목 정리: ' + group + ' “' + from + '” → “' + to + '”' + (arg.level ? ' ' + arg.level : '') + ' (' + n + '건)');
    return Object.assign(getAll(me), { fixed: n });
  }
  function removeOption(me, arg) {
    requireManager(me, '목록 관리');
    const cur = db.prepare('SELECT * FROM options WHERE id = ?').get(arg && arg.id);
    if (!cur) throw new UserError('이미 삭제된 항목입니다.', 404);
    if (cur.kind === 'evauto') throw new UserError('자동 표시 항목은 지울 수 없습니다. 숨기려면 “달력에 보이기”를 끄세요.');
    if (cur.kind === 'tz') { // 지점 시간대와, 그 시간으로 적힌 기록·계정이 있는 시간대는 지우지 않음
      if (Object.values(BRANCH_TZ).includes(cur.category)) throw new UserError('“' + cur.value + '”은(는) 지점 시간대라 지울 수 없습니다. 이름만 바꿀 수 있습니다.');
      const n = ['meetings', 'notes'].reduce((a, t) => a + db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE deletedAt = '' AND tz = ?`).get(cur.category).n, 0) +
        db.prepare('SELECT COUNT(*) n FROM events WHERE tz = ?').get(cur.category).n;
      const who = db.prepare('SELECT name FROM teachers WHERE viewTz = ? OR (branch = ? AND tz = ?)').all(cur.category, ALL_BRANCH, cur.category).map((r) => r.name);
      if (n || who.length) throw new UserError('“' + cur.value + '” 시간대를 ' + [n ? '기록 ' + n + '건' : '', who.length ? who.join(', ') + ' 님 화면 시간' : ''].filter(Boolean).join('·') + '이 쓰고 있어 지울 수 없습니다.');
    }
    if (cur.kind === 'doccat') { // 쓰고 있는 서류 분류를 지우면 목록 밖으로 흩어지므로 막음
      const n = db.prepare("SELECT COUNT(*) n FROM docs WHERE deletedAt = '' AND category = ?").get(cur.value).n + db.prepare("SELECT COUNT(*) n FROM files WHERE deletedAt = '' AND category = ? AND meetingId = '' AND followupId = '' AND docId = ''").get(cur.value).n;
      if (n) throw new UserError('“' + cur.value + '” 분류를 파일·서류 ' + n + '건이 쓰고 있어 지울 수 없습니다. 이름을 바꾸거나, 그 파일·서류의 분류를 먼저 옮겨주세요.');
    }
    db.prepare('DELETE FROM options WHERE id = ?').run(cur.id);
    if (cur.kind === 'tz') refreshTz();
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
    for (const f of db.prepare('SELECT id, storedName FROM unifiles WHERE programId = ?').all(cur.id)) { // 첨부 파일도 함께
      db.prepare('DELETE FROM unifiles WHERE id = ?').run(f.id);
      fs.rm(path.join(filesDir, f.storedName), { force: true }, () => {});
    }
    log(me.email, 'delete', 'programs', cur.id, cur.name + [cur.category, cur.url, cur.schedule, cur.memo].filter(Boolean).map((x) => ' · ' + x.slice(0, 200)).join(''));
    return getAll(me);
  }

  /** 공용 달력 일정: 누구나 추가, 수정·삭제는 등록한 사람 또는 관리자·관리팀 */
  function eventLabel(r) { return r.date + (r.endDate && r.endDate !== r.date ? '~' + r.endDate : '') + ' ' + (r.private === 'TRUE' ? '(나만 보기 일정)' : r.title); } // 나만 보기 일정은 변경 기록에도 제목을 남기지 않음
  function saveEvent(me, arg) {
    arg = arg || {};
    const rec = {
      date: clean(arg.date).trim(), endDate: clean(arg.endDate).trim(), title: clean(arg.title).trim().slice(0, 200),
      category: clean(arg.category).trim(), memo: clean(arg.memo).trim(), private: arg.private === true || arg.private === 'TRUE' || arg.private === 'on' ? 'TRUE' : '',
      shared: arg.shared === true || arg.shared === 'TRUE' || arg.shared === 'on' ? 'TRUE' : '', time: clean(arg.time).trim(),
    };
    if (rec.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(rec.time)) throw new UserError('시간은 HH:MM 형식으로 입력하세요. (예: 15:00)');
    if (rec.private) rec.shared = '';
    rec.tz = TZS.includes(arg.tz) ? arg.tz : accountTz(me); // 시간을 어느 나라 기준으로 적었는지 (화면은 보는 사람 시간으로 바꿔 보여줌)
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
        if (cur.createdBy !== me.email && (!isManager(me) || cur.private === 'TRUE')) throw new UserError(cur.private === 'TRUE' ? '일정을 찾을 수 없습니다.' : '일정은 등록한 사람이나 관리자·관리팀만 고칠 수 있습니다.', cur.private === 'TRUE' ? 404 : 403);
        if (cur.createdBy !== me.email) rec.private = cur.private; // 다른 사람 일정을 나만 보기로 바꿀 수 없음
        if (arg.updatedAt && arg.updatedAt !== cur.updatedAt) {
          const who = getTeacher(cur.updatedBy);
          throw new UserError('그 사이 ' + (who ? who.name : cur.updatedBy) + ' 님이 먼저 수정했습니다. 새로고침 후 다시 입력해주세요.', 409);
        }
        db.prepare('UPDATE events SET date=?, endDate=?, title=?, category=?, memo=?, private=?, shared=?, time=?, tz=?, updatedAt=?, updatedBy=? WHERE id=?')
          .run(rec.date, rec.endDate, rec.title, rec.category, rec.memo, rec.private, rec.shared, rec.time, rec.time ? rec.tz : '', t, me.email, id);
        log(me.email, 'update', 'events', id, eventLabel(rec));
      } else {
        id = newId();
        db.prepare('INSERT INTO events (id, date, endDate, title, category, memo, private, branch, shared, time, tz, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, rec.date, rec.endDate, rec.title, rec.category, rec.memo, rec.private, accountBranch(me), rec.shared, rec.time, rec.time ? rec.tz : '', t, me.email, t, me.email);
        log(me.email, 'create', 'events', id, eventLabel(rec));
      }
    });
    return Object.assign(getAll(me), { savedId: id });
  }
  /** 학교 방학 추가·수정 (관리자·관리팀, 목록 관리 › 학교) */
  function saveBreak(me, arg) {
    requireManager(me, '학교 방학');
    arg = arg || {};
    const rec = { school: clean(arg.school).trim(), name: clean(arg.name).trim().slice(0, 50) || '방학', startDate: clean(arg.startDate).trim(), endDate: clean(arg.endDate).trim() };
    if (!rec.school || !db.prepare("SELECT 1 FROM options WHERE kind = 'school' AND value = ?").get(rec.school)) throw new UserError('목록에 있는 학교를 고르세요.');
    if (!DATE_RE.test(rec.startDate) || !DATE_RE.test(rec.endDate)) throw new UserError('방학 시작일과 끝나는 날을 입력하세요.');
    if (rec.endDate < rec.startDate) throw new UserError('끝나는 날이 시작일보다 빠릅니다.');
    const t = now();
    let id = arg.id;
    if (id) {
      if (!getRow('schoolbreaks', id)) throw new UserError('방학 정보를 찾을 수 없습니다. 새로고침 해주세요.', 404);
      db.prepare('UPDATE schoolbreaks SET school=?, name=?, startDate=?, endDate=?, updatedAt=?, updatedBy=? WHERE id=?').run(rec.school, rec.name, rec.startDate, rec.endDate, t, me.email, id);
      log(me.email, 'update', 'schoolbreaks', id, rec.school + ' ' + rec.name + ' ' + rec.startDate + '~' + rec.endDate);
    } else {
      id = newId();
      db.prepare('INSERT INTO schoolbreaks (id, school, name, startDate, endDate, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?)').run(id, rec.school, rec.name, rec.startDate, rec.endDate, t, me.email, t, me.email);
      log(me.email, 'create', 'schoolbreaks', id, rec.school + ' ' + rec.name + ' ' + rec.startDate + '~' + rec.endDate);
    }
    return Object.assign(getAll(me), { savedId: id });
  }
  function removeBreak(me, arg) {
    requireManager(me, '학교 방학');
    const cur = getRow('schoolbreaks', arg && arg.id);
    if (!cur) throw new UserError('이미 삭제되었습니다.', 404);
    db.prepare('DELETE FROM schoolbreaks WHERE id = ?').run(cur.id);
    log(me.email, 'delete', 'schoolbreaks', cur.id, cur.school + ' ' + cur.name + ' ' + cur.startDate + '~' + cur.endDate);
    return getAll(me);
  }
  function removeEvent(me, arg) {
    const cur = getRow('events', arg && arg.id);
    if (!cur) throw new UserError('이미 삭제된 일정입니다.', 404);
    if (cur.createdBy !== me.email && (!isManager(me) || cur.private === 'TRUE')) throw new UserError(cur.private === 'TRUE' ? '이미 삭제된 일정입니다.' : '일정은 등록한 사람이나 관리자·관리팀만 지울 수 있습니다.', cur.private === 'TRUE' ? 404 : 403);
    db.prepare('DELETE FROM events WHERE id = ?').run(cur.id);
    log(me.email, 'delete', 'events', cur.id, eventLabel(cur) + (cur.memo && cur.private !== 'TRUE' ? ' — ' + cur.memo.slice(0, 200) : ''));
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
      id = save(me, { table, obj: arg.obj || {}, noData: true, hasFollowups: fus.length > 0, review: arg.review }).savedId;
      const rec = getRow(table, id);
      for (const f of fus) {
        save(me, { table: 'followups', noData: true, obj: { studentId: rec.studentId, title: f.title, assignee: f.assignee === undefined ? me.email : f.assignee, due: f.due || '',
          category: f.category || '', status: '할 일', [table === 'meetings' ? 'meetingId' : 'noteId']: id } });
      }
    });
    return Object.assign(getAll(me), { savedId: id });
  }

  /** 공통 팔로업: 여러 학생에게 같은 할 일 — 학생마다 하나씩 만들고 groupId 로 묶음. 담당: 'manager'(각 학생 관리팀) 또는 선생님 이메일 */
  function addFollowupMany(me, arg) {
    arg = arg || {};
    const ids = [...new Set((arg.studentIds || []).map(String))];
    if (!ids.length) throw new UserError('학생을 한 명 이상 고르세요.');
    if (ids.length > 300) throw new UserError('한 번에 300명까지 가능합니다.');
    const title = clean(arg.title).trim();
    if (!title) throw new UserError('할 일을 입력하세요.');
    if (arg.due && !DATE_RE.test(arg.due)) throw new UserError('기한 형식이 올바르지 않습니다.');
    const mode = arg.assignee === 'manager' ? 'manager' : lower(arg.assignee || '');
    if (mode !== 'manager' && mode && !getTeacher(mode)) throw new UserError('담당 선생님을 찾을 수 없습니다.');
    const groupId = newId();
    tx(() => {
      for (const sid of ids) {
        const st = requireStudent(me, sid);
        save(me, { table: 'followups', noData: true, obj: { studentId: st.id, title, detail: clean(arg.detail || ''), due: arg.due || '', status: '할 일', groupId,
          assignee: mode === 'manager' ? lower(st.manager || '') : mode } });
      }
    });
    return Object.assign(getAll(me), { count: ids.length, groupId });
  }

  /* ----- 원장님 상담 스케줄 (구글 시트 → Compass, 읽기만) ----- */
  /** 가져온 탭들의 일정을 통째로 바꿈. 학생과 연결된 것만, "우리 학생 아님"으로 뺀 것은 제외 → { saved, unmatched, excluded } */
  function replaceSchedule(tabs, events) {
    const students = db.prepare("SELECT id, name FROM students WHERE deletedAt = ''").all();
    const ex = new Set(db.prepare('SELECT key FROM schedex').all().map((r) => r.key));
    const t = now();
    let saved = 0, unmatched = 0, excluded = 0;
    tx(() => {
      for (const tab of tabs) db.prepare('DELETE FROM sched WHERE tab = ?').run(tab);
      for (const e of events) {
        const st = schedule.matchStudent(e, students);
        if (!st) { unmatched++; continue; }
        if (ex.has(e.key)) { excluded++; continue; }
        const r = db.prepare('INSERT OR IGNORE INTO sched (key, tab, studentId, startAt, endAt, title, detail, zone, sheetLabel, syncedAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(e.key, e.tab, st.id, e.startAt, e.endAt, e.title.slice(0, 200), String(e.detail || '').slice(0, 500), e.zone, e.sheetLabel, t);
        saved += r.changes;
      }
    });
    return { saved, unmatched, excluded };
  }
  /** "우리 학생 아님" — 그 일정을 지우고 다음 가져오기에서도 뺌 (같은 이름의 다른 학생 등) */
  function excludeSched(me, arg) {
    const r = db.prepare('SELECT * FROM sched WHERE key = ?').get(String(arg && arg.key || ''));
    if (!r) throw new UserError('일정을 찾을 수 없습니다. 새로고침 해주세요.', 404);
    const st = requireStudent(me, r.studentId);
    tx(() => {
      db.prepare('INSERT OR REPLACE INTO schedex (key, studentId, title, startAt, by, at) VALUES (?,?,?,?,?,?)').run(r.key, r.studentId, r.title, r.startAt, me.email, now());
      db.prepare('DELETE FROM sched WHERE key = ?').run(r.key);
      log(me.email, 'update', 'students', st.id, st.name + ' · 원장님 일정 "' + r.title + '" (' + r.startAt.replace('T', ' ') + ') 우리 학생 아님으로 뺌');
    });
    return getAll(me);
  }
  /** 뺀 일정 되돌리기 (관리자) — 다음 가져오기 때 다시 들어옴 */
  function unexcludeSched(me, arg) {
    requireAdmin(me, '뺀 일정 되돌리기');
    db.prepare('DELETE FROM schedex WHERE key = ?').run(String(arg && arg.key || ''));
    return getAutomation(me);
  }

  /* ----- 확인 요청: 기록을 다른 선생님이 확인하도록 ----- */
  const REVIEW_TABLES = ['notes', 'meetings', 'followups'];
  /** review = { to: [이메일], note }. 받는 사람이 그 학생·기록을 볼 수 있어야 함 (상담기록은 관리자·관리팀만) */
  function addReviews(me, table, refId, review) {
    const to = [...new Set(((review && review.to) || []).map(lower).filter(Boolean))];
    if (!to.length) return 0;
    if (!REVIEW_TABLES.includes(table)) throw new UserError('확인 요청을 할 수 없는 항목입니다.');
    if (to.length > 20) throw new UserError('확인 요청은 한 번에 20명까지입니다.');
    const rec = getRow(table, refId);
    if (!rec || rec.deletedAt) throw new UserError('기록을 찾을 수 없습니다. 새로고침 해주세요.', 404);
    const st = requireStudent(me, rec.studentId);
    if (table === 'notes') requireManager(me, '상담기록 확인 요청');
    const note = clean(review.note).trim().slice(0, 300);
    let n = 0;
    for (const email of to) {
      const t = getTeacher(email);
      if (!t || !t.active) throw new UserError('확인 요청을 받을 선생님을 찾을 수 없습니다: ' + email);
      const who = { email: t.email, role: t.role };
      if (!canSeeStudent(who, st)) throw new UserError(t.name + ' 님은 ' + st.name + ' 학생을 볼 수 없어 확인 요청을 보낼 수 없습니다.');
      if (table === 'notes' && !isManager(who)) throw new UserError('상담기록은 관리자·관리팀만 볼 수 있어 ' + t.name + ' 님에게는 확인 요청을 보낼 수 없습니다.');
      if (db.prepare("SELECT 1 FROM reviews WHERE refTable = ? AND refId = ? AND toEmail = ? AND doneAt = ''").get(table, rec.id, t.email)) continue; // 이미 요청 중
      const rid = newId();
      db.prepare('INSERT INTO reviews (id, studentId, refTable, refId, toEmail, fromEmail, note, createdAt) VALUES (?,?,?,?,?,?,?,?)')
        .run(rid, st.id, table, rec.id, t.email, me.email, note, now());
      addNotice({ ukey: 'review|' + rid, email: t.email, kind: 'review', refTable: table, refId: rec.id, studentId: st.id,
        title: (TABLES[table].summary(rec) || TABLES[table].label).slice(0, 120), body: note, fromEmail: me.email });
      n++;
    }
    if (n) log(me.email, 'review', table, rec.id, st.name + ' · 확인 요청 → ' + to.map((e) => (getTeacher(e) || {}).name || e).join(', ') + (note ? ' — ' + note : ''));
    return n;
  }
  function requestReview(me, arg) {
    arg = arg || {};
    tx(() => addReviews(me, arg.refTable, arg.refId, { to: arg.to, note: arg.note }));
    return getAll(me);
  }
  /** 받은 사람이 "확인함" (다시 누르면 취소) */
  function doneReview(me, arg) {
    const r = db.prepare('SELECT * FROM reviews WHERE id = ?').get(String(arg && arg.id || ''));
    if (!r) throw new UserError('확인 요청을 찾을 수 없습니다. 새로고침 해주세요.', 404);
    if (r.toEmail !== me.email) throw new UserError('나에게 온 확인 요청만 확인 처리할 수 있습니다.', 403);
    db.prepare('UPDATE reviews SET doneAt = ? WHERE id = ?').run(arg.undo ? '' : now(), r.id);
    return getAll(me);
  }
  /** 보낸 사람(또는 관리자)이 요청 취소 */
  function cancelReview(me, arg) {
    const r = db.prepare('SELECT * FROM reviews WHERE id = ?').get(String(arg && arg.id || ''));
    if (!r) throw new UserError('이미 취소된 요청입니다.', 404);
    if (r.fromEmail !== me.email && me.role !== 'admin') throw new UserError('요청한 사람이나 관리자만 취소할 수 있습니다.', 403);
    db.prepare('DELETE FROM reviews WHERE id = ?').run(r.id);
    return getAll(me);
  }

  /* ----- 알림 (리마인드 팝업 · 알림함) ----- */
  function addNotice(n) {
    db.prepare(`INSERT OR IGNORE INTO notices (id, ukey, email, kind, refTable, refId, studentId, title, body, fromEmail, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(newId(), n.ukey, lower(n.email), n.kind, n.refTable || '', n.refId || '', n.studentId || '', String(n.title || '').slice(0, 200), String(n.body || '').slice(0, 500), n.fromEmail || '', n.at || now());
  }
  /** 알림 시각이 된 팔로업 → 받는 사람마다 알림 (같은 시각 알림은 한 번만) */
  function syncReminders() {
    const t = now().slice(0, 16);
    const due = db.prepare("SELECT * FROM followups WHERE remindAt != '' AND remindAt IS NOT NULL AND remindAt <= ? AND status != '완료' AND (deletedAt = '' OR deletedAt IS NULL)").all(t);
    for (const f of due) {
      const to = new Set(String(f.remindTo || '@assignee').split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x === '@assignee' ? lower(f.assignee) : lower(x))).filter(Boolean));
      if (!to.size && f.updatedBy) to.add(lower(f.updatedBy)); // 담당자가 미정이면 마지막으로 고친 사람에게
      for (const email of to) addNotice({ ukey: ['remind', f.id, f.remindAt, email].join('|'), email, kind: 'remind', refTable: 'followups', refId: f.id, studentId: f.studentId, title: f.title, body: f.detail, at: f.remindAt });
    }
  }
  /** 내 알림 (최근 30일, 50개) — 완료된 팔로업의 알림 카드는 자동으로 닫힘 */
  function getNotices(me) {
    syncReminders();
    db.prepare(`UPDATE notices SET closedAt = ? WHERE email = ? AND closedAt = '' AND refTable = 'followups'
      AND refId IN (SELECT id FROM followups WHERE status = '완료' OR (deletedAt != '' AND deletedAt IS NOT NULL))`).run(now(), me.email);
    const since = new Date(Date.now() + 9 * 3600000 - 30 * 86400000).toISOString().slice(0, 16);
    const list = db.prepare('SELECT * FROM notices WHERE email = ? AND at >= ? ORDER BY at DESC LIMIT 50').all(me.email, since)
      .filter((n) => { const st = getRow('students', n.studentId); return !n.studentId || canSeeStudent(me, st); });
    return { now: now().slice(0, 16), notices: list };
  }
  /** read: 읽음 · close: 카드 닫기 · snooze: until(한국 시간)까지 미루기 · readAll: 모두 읽음 */
  function noticeAct(me, arg) {
    arg = arg || {};
    const t = now();
    if (arg.act === 'readAll') { db.prepare("UPDATE notices SET readAt = ? WHERE email = ? AND readAt = ''").run(t, me.email); return getNotices(me); }
    const n = db.prepare('SELECT * FROM notices WHERE id = ? AND email = ?').get(String(arg.id || ''), me.email);
    if (!n) throw new UserError('알림을 찾을 수 없습니다.', 404);
    if (arg.act === 'read') db.prepare("UPDATE notices SET readAt = ? WHERE id = ? AND readAt = ''").run(t, n.id);
    else if (arg.act === 'close') db.prepare('UPDATE notices SET closedAt = ?, readAt = CASE WHEN readAt = \'\' THEN ? ELSE readAt END WHERE id = ?').run(t, t, n.id);
    else if (arg.act === 'snooze') {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(arg.until || ''))) throw new UserError('미룰 시각이 올바르지 않습니다.');
      db.prepare('UPDATE notices SET snoozeUntil = ?, readAt = CASE WHEN readAt = \'\' THEN ? ELSE readAt END WHERE id = ?').run(arg.until, t, n.id);
    } else throw new UserError('알 수 없는 동작입니다.');
    return getNotices(me);
  }

  /** 팔로업을 다른 선생님에게 요청(담당자 변경 + 누가 왜 요청했는지 기록) → 메일은 server.js 에서 */
  function requestFollowup(me, arg) {
    const f = getRow('followups', arg && arg.id);
    if (!f || f.deletedAt) throw new UserError('팔로업을 찾을 수 없습니다. 새로고침 해주세요.', 404);
    const s = requireStudent(me, f.studentId);
    requireEdit(me, s, 'followups', f);
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
    addNotice({ ukey: 'handover|' + f.id + '|' + t, email: to.email, kind: 'handover', refTable: 'followups', refId: f.id, studentId: s.id, title: f.title, body: note, fromEmail: me.email });
    return Object.assign(getAll(me), { request: { to: to.email, toName: to.name, notify: to.notify !== 'off', from: me.name, student: s.name, studentId: s.id,
      title: f.title, due: f.due, note } });
  }

  /** 목록 순서 저장 (드래그): 학교·커리큘럼·사이트 = 관리자·관리팀, 대학 = 관리자 */
  function saveOrder(me, arg) {
    const ids = (arg && arg.ids) || [];
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000) throw new UserError('순서를 저장할 항목이 없습니다.');
    const t = now();
    if (arg.kind === 'teachers') {
      requireAdmin(me, '계정 순서 변경');
      tx(() => ids.forEach((email, i) => db.prepare('UPDATE teachers SET sortOrder = ? WHERE email = ?').run(String(i + 1), lower(email))));
      log(me.email, 'update', 'teachers', '', '계정 순서 변경');
    } else if (arg.kind === 'evauto') {
      requireManager(me, '목록 관리');
      tx(() => ids.forEach((id, i) => db.prepare("UPDATE options SET sortOrder = ?, updatedAt = ?, updatedBy = ? WHERE id = ? AND kind = 'evauto'").run(String(i + 1), t, me.email, String(id))));
      log(me.email, 'update', 'options', '', '달력 자동 표시 순서 변경');
    } else if (arg.kind === 'followups') { // 메인 위젯의 팔로업 순서 — 계정마다 따로 (끈 화면의 순서를 앞에, 예전에 정한 다른 팔로업은 그 뒤에 그대로)
      const rows = ids.map((id) => getRow('followups', id));
      rows.forEach((r) => { if (!r || r.deletedAt) throw new UserError('팔로업을 찾을 수 없습니다. 새로고침 해주세요.', 404); requireStudent(me, r.studentId); });
      const now_ = rows.map((r) => r.id), prev = parseFuOrder((db.prepare('SELECT fuOrder FROM teachers WHERE email = ?').get(me.email) || {}).fuOrder);
      const open = new Set(db.prepare("SELECT id FROM followups WHERE deletedAt = '' AND status != '완료'").all().map((r) => r.id)); // 끝난 팔로업은 순서에서 정리
      const next = now_.concat(prev.filter((id) => !now_.includes(id) && open.has(id))).slice(0, 1000);
      db.prepare('UPDATE teachers SET fuOrder = ? WHERE email = ?').run(JSON.stringify(next), me.email);
    } else if (arg.kind === 'universities') {
      requireManager(me, '대학 순서 변경');
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
    const pg = info.programId ? getRow('programs', info.programId) : null;
    if (info.programId && !pg) throw new UserError('대회·프로그램을 찾을 수 없습니다. 새로고침 해주세요.', 404);
    const c = pg ? null : getRow('unicycles', info.cycleId);
    if (!pg && (!c || c.deletedAt)) throw new UserError('입학 연도 정보를 찾을 수 없습니다. 새로고침 해주세요.', 404);
    const u = pg ? null : requireUni(c.universityId);
    const name = String(info.name || '').replace(/[\\/\r\n]/g, '_').trim().slice(0, 200);
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1];
    const type = ext && UPLOAD_TYPES[ext.toLowerCase()];
    if (!type) throw new UserError('올릴 수 없는 파일 형식입니다. (PDF, 이미지, 워드, 엑셀, 한글 파일만 가능)');
    if (!info.buffer || !info.buffer.length) throw new UserError('빈 파일입니다.');
    if (info.buffer.length > uploadLimit()) throw new UserError('파일은 ' + uploadMB() + 'MB 이하만 올릴 수 있습니다.', 413);
    const category = pg ? '대회·프로그램' : UNIFILE_CATS.includes(info.category) ? info.category : (u.country === '한국' ? '모집요강' : '기타 자료');
    const id = newId(), storedName = id + '.' + ext.toLowerCase(), t = now();
    const full = path.join(filesDir, storedName);
    fs.writeFileSync(full, info.buffer);
    try {
      db.prepare('INSERT INTO unifiles (id, universityId, cycleId, programId, category, name, memo, mime, size, storedName, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, u ? u.id : '', c ? c.id : '', pg ? pg.id : '', category, name, '', type, String(info.buffer.length), storedName, t, me.email, t, me.email);
      log(me.email, 'upload', 'unifiles', id, (pg ? pg.name : u.name + ' · ' + cycleLabel(c)) + ' · ' + category + ' · ' + name);
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
    if (!['courses', 'semesters'].includes(table)) throw new UserError('여러 건 저장을 지원하지 않는 항목입니다.');
    if (!Array.isArray(objs) || !objs.length) throw new UserError('저장할 항목이 없습니다.');
    if (objs.length > 60) throw new UserError('한 번에 60건까지만 저장할 수 있습니다.');
    const ids = [];
    tx(() => { for (const obj of objs) ids.push(save(me, { table, obj, noData: true }).savedId); });
    return Object.assign(getAll(me), { savedIds: ids });
  }

  /** 내 정보: 이름 변경 */
  function updateMe(me, arg) {
    arg = arg || {};
    if ('viewTz' in arg) { // 화면 시간 (출장 등) — '' = 지점 기준으로 되돌림
      const z = clean(arg.viewTz).trim();
      if (z && !TZS.includes(z)) throw new UserError('화면 시간이 올바르지 않습니다.');
      db.prepare('UPDATE teachers SET viewTz = ? WHERE email = ?').run(z, me.email);
      log(me.email, 'update', 'teachers', me.email, '내 화면 시간 변경: ' + (z || '지점 기준'));
      return getAll(Object.assign({}, me, { viewTz: z }));
    }
    if ('color' in arg) { // 내 색 (학생 목록에서 내가 관리하는 학생 줄의 배경색)
      const color = String(arg.color || '').toLowerCase();
      if (color && !/^#[0-9a-f]{6}$/.test(color)) throw new UserError('색상 형식이 올바르지 않습니다.');
      db.prepare('UPDATE teachers SET color = ? WHERE email = ?').run(color, me.email);
      log(me.email, 'update', 'teachers', me.email, '내 색 변경: ' + (color || '없음'));
      return getAll(me);
    }
    const name = clean(arg && arg.name).trim();
    if (!name) throw new UserError('이름을 입력하세요.');
    if (name.length > 40) throw new UserError('이름이 너무 깁니다.');
    db.prepare('UPDATE teachers SET name = ?, updatedAt = ? WHERE email = ?').run(name, now(), me.email);
    log(me.email, 'update', 'teachers', me.email, '내 이름 변경: ' + name);
    return getAll(Object.assign({}, me, { name }));
  }

  /* ----- 메인 화면 배치 (계정별, 관리자는 모두의 기본 배치) ----- */
  /** 계정별 화면 보기 선택 — 정해 둔 키·값만 받음 */
  const VIEW_PREFS = { dashFuView: ['s', 'd'], dlView: ['student', 'date', 'uni'], dashDlView: ['list', 'student', 'uni'], stuFuView: ['list', 'topic'] };
  function parseViewPrefs(v) {
    let o; try { o = JSON.parse(v || '{}'); } catch (e) { o = {}; }
    const out = {};
    Object.keys(VIEW_PREFS).forEach((k) => { if (o && VIEW_PREFS[k].includes(o[k])) out[k] = o[k]; });
    return out;
  }
  function saveViewPref(me, arg) {
    const k = String(arg && arg.key || ''), v = String(arg && arg.value || '');
    if (!VIEW_PREFS[k] || !VIEW_PREFS[k].includes(v)) throw new UserError('보기 설정이 올바르지 않습니다.');
    const row = db.prepare('SELECT viewPrefs FROM teachers WHERE email = ?').get(me.email);
    const o = parseViewPrefs(row && row.viewPrefs); o[k] = v;
    db.prepare('UPDATE teachers SET viewPrefs = ? WHERE email = ?').run(JSON.stringify(o), me.email);
    return { ok: true, viewPrefs: o };
  }
  /** 개인 화면 설정: 정해진 이름의 칸만, 값은 JSON (칸 하나 20KB, 합쳐서 300KB까지) */
  const PREF_KEY = /^(colw:[^\n]{1,400}|(scFold|dlFold|majFold|uniFold|exportFields|alertsOff|sumDay|studentCols)|view\.[A-Za-z]{1,30}|atlas\.view)$/;
  function parsePrefs(v) { try { const o = JSON.parse(v || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; } }
  function savePref(me, arg) {
    const k = String(arg && arg.key || '');
    if (!PREF_KEY.test(k)) throw new UserError('화면 설정 이름이 올바르지 않습니다.');
    const v = arg.value === undefined ? null : arg.value;
    if (v !== null && JSON.stringify(v).length > 20000) throw new UserError('화면 설정이 너무 큽니다.');
    if (k === 'studentCols' && v !== null && (!Array.isArray(v) || v.some((x) => !STUDENT_COLS.includes(x)))) throw new UserError('학생 목록 칸이 올바르지 않습니다.');
    const row = db.prepare('SELECT uiPrefs FROM teachers WHERE email = ?').get(me.email);
    if (!row) throw new UserError('계정을 찾을 수 없습니다.', 404);
    const o = parsePrefs(row.uiPrefs);
    if (v === null) delete o[k]; else o[k] = v;
    const json = JSON.stringify(o);
    if (json.length > 300000) throw new UserError('저장한 화면 설정이 너무 많습니다. 표 칸 너비를 몇 개 처음 상태로 되돌려 주세요.');
    db.prepare('UPDATE teachers SET uiPrefs = ? WHERE email = ?').run(json, me.email);
    return { ok: true };
  }
  /** 원서 연습: 학생에 연결된 연습은 그 학생을 볼 수 있으면, 개인 연습은 만든 사람만 */
  function appDraftRow(me, id) {
    const r = db.prepare('SELECT * FROM appdrafts WHERE id = ?').get(String(id || ''));
    if (!r) throw new UserError('원서 연습을 찾을 수 없습니다.', 404);
    if (r.studentId) requireStudent(me, r.studentId);
    else if (r.createdBy !== me.email) throw new UserError('다른 선생님의 개인 연습입니다.', 403);
    return r;
  }
  function appDraftEditable(me, r) {
    if (r.studentId) requireEdit(me, requireStudent(me, r.studentId), 'apps', null);
  }
  function getAppDraft(me, arg) {
    const r = appDraftRow(me, arg && arg.id);
    return { form: appforms.getForm(r.formId), draft: r };
  }
  /** 원서 연습 저장 (id 없으면 새로 만듦): 다른 사람이 먼저 고쳤으면 거부 (updatedAt), 칸 값은 JSON 객체만 */
  function saveAppDraft(me, arg) {
    arg = arg || {};
    const cur = arg.id ? appDraftRow(me, arg.id) : null, form = appforms.getForm(cur ? cur.formId : arg.formId);
    if (!form) throw new UserError('원서 양식을 찾을 수 없습니다.', 404);
    if (cur) appDraftEditable(me, cur);
    let sid = cur ? cur.studentId : '';
    if (arg.studentId !== undefined && String(arg.studentId || '') !== sid) {
      if (cur && cur.createdBy !== me.email && !isManager(me)) throw new UserError('연결 학생은 만든 사람이나 관리자·관리팀만 바꿀 수 있습니다.', 403);
      sid = String(arg.studentId || '');
      if (sid) requireEdit(me, requireStudent(me, sid), 'apps', null);
    }
    const data = arg.data === undefined && cur ? JSON.parse(cur.data) : arg.data === undefined ? {} : arg.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new UserError('원서 내용 형식이 올바르지 않습니다.');
    const json = JSON.stringify(data);
    if (json.length > 300000) throw new UserError('원서 내용이 너무 깁니다.');
    const tabs = form.tabs.map((t) => t.key);
    const done = arg.done === undefined && cur ? cur.done : JSON.stringify((Array.isArray(arg.done) ? arg.done : []).filter((k) => tabs.includes(k)));
    const title = arg.title === undefined && cur ? cur.title : clean(arg.title).trim().slice(0, 100), t = now();
    if (cur) {
      if (arg.updatedAt !== undefined && arg.updatedAt !== cur.updatedAt) {
        const who = getTeacher(cur.updatedBy);
        throw new UserError('그 사이 ' + (who ? who.name : cur.updatedBy) + ' 님이 이 원서를 먼저 고쳤습니다. 새로고침 후 다시 입력해주세요.', 409);
      }
      db.prepare('UPDATE appdrafts SET studentId = ?, title = ?, data = ?, done = ?, updatedAt = ?, updatedBy = ? WHERE id = ?').run(sid, title, json, done, t, me.email, cur.id);
      return { id: cur.id, studentId: sid, title, updatedAt: t };
    }
    const id = newId(), s = sid ? getRow('students', sid) : null;
    db.prepare('INSERT INTO appdrafts (id, formId, studentId, title, data, done, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, form.id, sid, title, json, done, t, me.email, t, me.email);
    log(me.email, 'create', 'appdrafts', id, '원서 연습 ' + form.uni + ' ' + form.intake + (s ? ' · ' + s.name : '') + (title ? ' · ' + title : ''));
    return { id, studentId: sid, title, updatedAt: t };
  }
  function removeAppDraft(me, arg) {
    const r = appDraftRow(me, arg && arg.id);
    appDraftEditable(me, r);
    if (r.createdBy !== me.email && !isManager(me)) throw new UserError('만든 사람이나 관리자·관리팀만 지울 수 있습니다.', 403);
    db.prepare('DELETE FROM appdrafts WHERE id = ?').run(r.id);
    log(me.email, 'delete', 'appdrafts', r.id, '원서 연습 삭제' + (r.title ? ' · ' + r.title : ''));
    return { ok: true };
  }
  /** 가격표 (관리자·관리팀이 고침, 처음엔 기본 가격표) */
  function getPriceList() {
    try { const o = JSON.parse(getMeta('site.prices') || 'null'); if (o && Array.isArray(o.rows)) return o; } catch (e) { /* 기본값 */ }
    return DEFAULT_PRICES;
  }
  function savePriceList(me, arg) {
    requireManager(me, '가격표');
    const src = arg || {};
    if (!Array.isArray(src.rows) || src.rows.length > 200) throw new UserError('가격표 형식이 올바르지 않습니다.');
    const s = (v, n) => clean(v).trim().slice(0, n || 200);
    const rows = src.rows.map((r) => ({ id: s(r.id, 40) || newId(), region: s(r.region, 40), kind: s(r.kind, 40), name: s(r.name), sessions: s(r.sessions, 60), schools: s(r.schools, 40),
      price: String(Number(String(r.price || '').replace(/[^\d.]/g, '')) || 0), notice: s(r.notice, 1000) })).filter((r) => r.name);
    const notes = (Array.isArray(src.notes) ? src.notes : []).map((x) => s(x, 500)).filter(Boolean).slice(0, 30);
    setMeta('site.prices', JSON.stringify({ rows, notes, limitedNotice: s(src.limitedNotice, 500) }));
    log(me.email, 'update', 'settings', 'prices', '가격표 수정 (' + rows.length + '개 항목)');
    return getAll(me);
  }
  /** 계약서 양식: 추가·고치기 (관리자·관리팀), 지우기는 숨김 처리 */
  function saveCTemplate(me, arg) {
    requireManager(me, '계약서 양식');
    arg = arg || {};
    const name = clean(arg.name).trim().slice(0, 100);
    if (!name) throw new UserError('양식 이름을 입력하세요.');
    const kind = clean(arg.kind).trim().slice(0, 40), body = sanitizeDoc(String(arg.body || ''));
    if (!body.trim()) throw new UserError('양식 내용을 입력하세요.');
    const t = now();
    let id = arg.id;
    if (id) {
      const cur = db.prepare("SELECT * FROM ctemplates WHERE id = ? AND deletedAt = ''").get(id);
      if (!cur) throw new UserError('양식을 찾을 수 없습니다. 새로고침 해주세요.', 404);
      if (arg.updatedAt && arg.updatedAt !== cur.updatedAt) throw new UserError('그 사이 다른 분이 이 양식을 고쳤습니다. 새로고침 후 다시 입력해주세요.', 409);
      db.prepare('UPDATE ctemplates SET name = ?, kind = ?, body = ?, updatedAt = ?, updatedBy = ? WHERE id = ?').run(name, kind, body, t, me.email, id);
      log(me.email, 'update', 'ctemplates', id, '계약서 양식 ' + name);
    } else {
      id = newId();
      const so = String((db.prepare('SELECT MAX(CAST(sortOrder AS INTEGER)) n FROM ctemplates').get().n || 0) + 1);
      db.prepare('INSERT INTO ctemplates (id, name, kind, body, sortOrder, createdAt, createdBy, updatedAt, updatedBy) VALUES (?,?,?,?,?,?,?,?,?)').run(id, name, kind, body, so, t, me.email, t, me.email);
      log(me.email, 'create', 'ctemplates', id, '계약서 양식 ' + name);
    }
    return Object.assign(getAll(me), { savedId: id });
  }
  function removeCTemplate(me, arg) {
    requireManager(me, '계약서 양식');
    const cur = db.prepare("SELECT * FROM ctemplates WHERE id = ? AND deletedAt = ''").get(String(arg && arg.id || ''));
    if (!cur) throw new UserError('양식을 찾을 수 없습니다.', 404);
    db.prepare('UPDATE ctemplates SET deletedAt = ?, updatedBy = ? WHERE id = ?').run(now(), me.email, cur.id);
    log(me.email, 'delete', 'ctemplates', cur.id, '계약서 양식 ' + cur.name);
    return getAll(me);
  }
  /** 원서용 학생 정보 엑셀에 들어갈 한 학생의 기록 (볼 수 있는 학생만) */
  function studentSheetData(me, id) {
    const st = requireStudent(me, id);
    const rows = (t) => db.prepare(`SELECT * FROM ${t} WHERE studentId = ? AND deletedAt = ''`).all(st.id).map((r) => publicRow(t, r, me));
    const schoolOpts = {};
    db.prepare("SELECT value, fullName, country, city, info FROM options WHERE kind = 'school'").all().forEach((o) => { schoolOpts[o.value] = o; });
    return { student: publicRow('students', st, me), schools: rows('schools'), semesters: rows('semesters'), courses: rows('courses'), scores: rows('scores'),
      appinfo: rows('appinfo'), accounts: rows('accounts'), apps: rows('apps'), schoolOpts };
  }
  const getPrefs = (me) => parsePrefs((db.prepare('SELECT uiPrefs FROM teachers WHERE email = ?').get(me.email) || {}).uiPrefs);
  function parseFuOrder(v) { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 1000) : []; } catch (e) { return []; } }
  function parseLayout(v) { try { const x = JSON.parse(v || 'null'); return Array.isArray(x) ? x : null; } catch (e) { return null; } }
  /** [{ id, s: '가로칸x세로칸'(예: 2x3), hide, ts: 제목 크기 ''|'l'|'xl', tc: 제목 색, bg: 배경색 }] 만 받음. 빈칸은 id 가 gap1, gap2 … */
  function cleanLayout(list) {
    if (!Array.isArray(list) || list.length > 40) throw new UserError('화면 배치 형식이 올바르지 않습니다.');
    const seen = new Set();
    return list.map((x) => {
      const id = String(x && x.id || '');
      if (!/^[a-z][a-z0-9]{0,29}$/.test(id) || seen.has(id)) throw new UserError('화면 배치 형식이 올바르지 않습니다.');
      seen.add(id);
      const hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : '');
      return { id, s: /^[1-4]x[1-6]$/.test(String(x.s)) ? String(x.s) : '', hide: !!x.hide, ts: ['l', 'xl'].includes(x.ts) ? x.ts : '', tc: hex(x.tc), bg: hex(x.bg) };
    });
  }
  /** 학생 목록 칸: 보일 칸과 순서 (관리자·관리팀이 정하면 모두에게 같게). 이름 칸은 항상 맨 앞 */
  function parseCols(v) { try { const a = JSON.parse(v || 'null'); return Array.isArray(a) ? a.filter((k) => STUDENT_COLS.includes(k)) : null; } catch (e) { return null; } }
  function saveStudentCols(me, arg) {
    requireManager(me, '학생 목록 칸 정하기');
    const cols = arg && arg.cols == null ? null : [...new Set(((arg && arg.cols) || []).filter((k) => STUDENT_COLS.includes(k)))];
    setMeta('studentCols', cols ? JSON.stringify(cols) : '');
    log(me.email, 'update', 'settings', 'studentCols', cols ? '학생 목록 칸 변경: ' + cols.join(', ') : '학생 목록 칸을 처음 상태로');
    return getAll(me);
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
      const rec = { universityId: src.universityId, year, term, tracks: src.tracks || '', requirements: src.requirements, choices: src.choices || '', sourceUrl: src.sourceUrl,
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
        requireEdit(me, cur, table, cur);
      } else {
        requireTableAccess(me, table);
        requireEdit(me, requireStudent(me, cur.studentId), table, cur);
      }
      db.prepare(`UPDATE ${table} SET deletedAt = ?, deletedBy = ? WHERE id = ?`).run(now(), me.email, cur.id);
      log(me.email, 'delete', table, cur.id, describe(table, cur));
    });
    return arg.noData ? null : getAll(me);
  }
  /** 여러 개 한꺼번에: items = [{ table, id }] (최대 200개). 삭제·복구는 모두 되거나 하나도 안 됨 */
  function manyItems(arg) {
    const items = (arg && arg.items) || [];
    if (!Array.isArray(items) || !items.length || items.length > 200) throw new UserError('선택한 항목이 없습니다.');
    return items;
  }
  function removeMany(me, arg) {
    const items = manyItems(arg);
    tx(() => items.forEach((x) => remove(me, { table: x && x.table, id: x && x.id, noData: true })));
    return Object.assign(getAll(me), { count: items.length });
  }
  function restoreMany(me, arg) {
    const items = manyItems(arg);
    tx(() => items.forEach((x) => restore(me, { table: x && x.table, id: x && x.id, noData: true })));
    return Object.assign(getAll(me), { count: items.length });
  }
  /** 영구 삭제 여러 개 (하나씩 — 실패한 것은 남기고 이유를 알려줌) */
  function purgeMany(me, arg) {
    requireAdmin(me, '영구 삭제');
    const items = manyItems(arg), failed = [];
    let n = 0;
    items.forEach((x) => { try { purge(me, { table: x && x.table, id: x && x.id, noData: true }); n++; } catch (e) { failed.push(e.message); } });
    return Object.assign(getTrash(me), { count: n, failed });
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
        requireEdit(me, s, table, cur);
      } else if (table === 'students') requireEdit(me, cur, table, cur);
      db.prepare(`UPDATE ${table} SET deletedAt = '', deletedBy = '' WHERE id = ?`).run(cur.id);
      log(me.email, 'restore', table, cur.id, describe(table, cur));
    });
    return arg.noData ? null : getAll(me);
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
    return arg.noData ? null : getTrash(me);
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
  function legacyLabel(t) { return { teachers: '선생님 계정', options: '목록(학교·커리큘럼·사이트)', settings: '설정', events: '달력 일정', unifiles: '대학 자료 파일', programs: '대회·프로그램', schoolbreaks: '학교 방학' }[t] || t; }

  /* ----- 파일 ----- */

  /** 성적·학력 탭 파일 분류: 서류 분류 목록에 있는 것만 (없으면 기타) */
  function fileCat(c) {
    c = clean(c).trim();
    if (c === '성적표') c = DEFAULT_DOCCATS[1];
    if (db.prepare("SELECT 1 FROM options WHERE kind = 'doccat' AND value = ?").get(c)) return c;
    const etc = db.prepare("SELECT value FROM options WHERE kind = 'doccat' AND value LIKE '기타%' ORDER BY CAST(sortOrder AS INTEGER) LIMIT 1").get();
    return etc ? etc.value : DC.etc;
  }
  function addFile(me, info) {
    const s = requireStudent(me, info.studentId);
    requireEdit(me, s, 'files', null);
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
    let doc = null, meeting = null, fu = null, score = null, reply = null, contract = null;
    if (info.contractId) { // 계약서 서명본·스캔
      requireManager(me, '계약서 올리기');
      contract = getRow('contracts', info.contractId);
      if (!contract || contract.deletedAt || contract.studentId !== s.id) throw new UserError('계약을 찾을 수 없습니다. 새로고침 해주세요.', 404);
    }
    if (info.replyId) { // 답변 말풍선에 붙이는 파일 → 그 답변의 팔로업에도 묶임
      reply = getRow('fureplies', info.replyId);
      if (!reply || reply.deletedAt || reply.studentId !== s.id) throw new UserError('답변을 찾을 수 없습니다. 새로고침 해주세요.', 404);
      info.followupId = reply.followupId;
    }
    if (info.scoreId) {
      score = getRow('scores', info.scoreId);
      if (!score || score.deletedAt || score.studentId !== s.id) throw new UserError('점수 기록을 찾을 수 없습니다. 새로고침 해주세요.', 404);
    }
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
    if (info.buffer.length > uploadLimit()) throw new UserError('파일은 ' + uploadMB() + 'MB 이하만 올릴 수 있습니다.', 413);
    const id = newId();
    const storedName = id + '.' + ext.toLowerCase();
    fs.writeFileSync(path.join(filesDir, storedName), info.buffer);
    stored.push(path.join(filesDir, storedName));
    const t = now();
    const rec = { id, studentId: s.id, category: contract ? '계약서' : doc ? doc.category || guessDocCat(doc.name) : meeting ? '미팅' : fu ? '연락' : score ? scoreDocCat(score.kind) : fileCat(info.category), name, memo: clean(info.memo || ''), mime: type,
      size: String(info.buffer.length), storedName, docId: doc ? doc.id : '', meetingId: meeting ? meeting.id : '', followupId: fu ? fu.id : '', scoreId: score ? score.id : '', replyId: reply ? reply.id : '', contractId: contract ? contract.id : '',
      createdAt: t, createdBy: me.email, updatedAt: t, updatedBy: me.email };
    const keys = Object.keys(rec);
    db.prepare(`INSERT INTO files (${keys.join(', ')}) VALUES (${keys.map((k) => '@' + k).join(', ')})`).run(rec);
    if (doc) {
      // 서류 파일을 올리면 자동으로 수합 완료 + 받은 날짜/사람 기록
      db.prepare("UPDATE docs SET status = '수합 완료', receivedAt = ?, receivedBy = ?, updatedAt = ?, updatedBy = ? WHERE id = ?")
        .run(t, me.email, t, me.email, doc.id);
    }
    log(me.email, 'upload', 'files', id, s.name + ' · ' + (contract ? '계약서 · ' : doc ? doc.name + ' · ' : meeting ? '미팅 ' + meeting.date + ' · ' : fu ? '연락 ' + fu.title.slice(0, 30) + ' · ' : '') + name);
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
    if (f.contractId) requireManager(me, '계약서 파일 보기');
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
    if (email === me.email && (!['admin', 'developer'].includes(role) || !active)) throw new UserError('본인의 관리자 권한은 해제할 수 없습니다.');
    const before = getTeacher(email);
    if (!me.dev && (role === 'developer' || (before && before.role === 'developer'))) throw new UserError('개발자 계정은 개발자만 정하거나 바꿀 수 있습니다.', 403);
    const password = obj.password ? String(obj.password) : '';
    if (password) checkPasswordRule(password);
    const color = String(obj.color || '').toLowerCase();
    if (color && !/^#[0-9a-f]{6}$/.test(color)) throw new UserError('색상 형식이 올바르지 않습니다.');
    if (obj.branch && !ACCOUNT_BRANCHES.includes(obj.branch)) throw new UserError('지점이 올바르지 않습니다.');
    if (obj.tz && !TZS.includes(obj.tz)) throw new UserError('화면 시간이 올바르지 않습니다.');
    tx(() => {
      const found = getTeacher(email);
      const name = String(obj.name || '').trim() || (found ? found.name : email.split('@')[0]);
      const t = now();
      if (found) {
        db.prepare('UPDATE teachers SET name=?, role=?, active=?, updatedAt=? WHERE email=?').run(name, role, active, t, email);
        if ('notify' in obj) db.prepare('UPDATE teachers SET notify=? WHERE email=?').run(obj.notify === false ? 'off' : '', email);
        if ('color' in obj) db.prepare('UPDATE teachers SET color=? WHERE email=?').run(color, email);
        if (obj.branch) db.prepare('UPDATE teachers SET branch=? WHERE email=?').run(obj.branch, email);
        if (obj.tz) db.prepare('UPDATE teachers SET tz=? WHERE email=?').run(obj.tz, email);
        if (password) {
          db.prepare('UPDATE teachers SET passwordHash=?, mustChangePassword=0 WHERE email=?').run(hashPassword(password), email);
        }
        // 비활성화·비밀번호 초기화·역할 변경 시 기존 로그인 즉시 해제
        if (!active || password || role !== found.role) db.prepare('DELETE FROM sessions WHERE email = ?').run(email);
      } else {
        if (!password) throw new UserError('새 계정의 비밀번호를 입력하세요 (6자 이상).');
        db.prepare('INSERT INTO teachers (email, name, role, active, passwordHash, mustChangePassword, createdAt, updatedAt, notify, color, branch, tz) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(email, name, role, active, hashPassword(password), 0, t, t, obj.notify === false ? 'off' : '', color, obj.branch || BRANCHES[0], obj.tz || '');
      }
      const roleLabel = { admin: '관리자', staff: '관리팀', consultant: '컨설턴트', developer: '개발자' }[role];
      log(me.email, found ? 'update' : 'create', 'teachers', email,
        [name, email, roleLabel, obj.branch || '', active ? '활성' : '비활성', password ? (found ? '비밀번호 초기화' : '임시 비밀번호 설정') : '']
          .filter(Boolean).join(' · '));
    });
    return getAll(me);
  }

  async function backup(destPath) { await db.backup(destPath); }

  /* ----- 자동 백업·이메일 알림 설정 (관리자) ----- */
  const CONFIG_KEYS = { scriptUrl: '', secret: '', siteUrl: '', backupOn: '', backupHour: '3', mailOn: '', mailHour: '8', volumeGB: '5', uploadMB: String(UPLOAD_MB_DEFAULT), schedSheet: '', schedOn: '' };
  function getConfig() {
    const out = Object.assign({}, CONFIG_KEYS);
    db.prepare("SELECT key, value FROM meta WHERE key LIKE 'cfg.%'").all().forEach((r) => { out[r.key.slice(4)] = r.value; });
    return out;
  }
  /** 모든 계정에 보이는 사이트 설정: 버그·요청 링크, 지점별 숨긴 메뉴 */
  function siteSettings() {
    let hide = {};
    try { hide = JSON.parse(getMeta('site.hideMenus') || '{}') || {}; } catch (e) { hide = {}; }
    const hideMenus = {};
    BRANCHES.forEach((b) => { hideMenus[b] = Array.isArray(hide[b]) ? hide[b].filter((m) => HIDEABLE_MENUS.includes(m)) : []; });
    const bug = db.prepare("SELECT value FROM meta WHERE key = 'site.bugUrl'").get(); // 한 번도 정하지 않았으면 처음 링크
    return { bugUrl: bug ? bug.value : DEFAULT_BUG_URL, hideMenus, hideable: HIDEABLE_MENUS };
  }
  function saveSite(me, arg) {
    requireAdmin(me, '사이트 설정');
    arg = arg || {};
    if ('bugUrl' in arg) {
      const u = clean(arg.bugUrl).trim();
      if (u && !/^https:\/\/\S+$/.test(u)) throw new UserError('링크는 https:// 로 시작해야 합니다.');
      setMeta('site.bugUrl', u);
    }
    if ('hideMenus' in arg) {
      const src = arg.hideMenus || {}, out = {};
      BRANCHES.forEach((b) => { out[b] = [...new Set((Array.isArray(src[b]) ? src[b] : []).map(String))].filter((m) => HIDEABLE_MENUS.includes(m)); });
      setMeta('site.hideMenus', JSON.stringify(out));
    }
    return getAll(me);
  }
  /** 팔로업 추가 창에서 여러 줄을 "줄마다 따로" 만들 때: 같은 담당·기한·분류로 줄마다 팔로업 하나씩 */
  function addFollowupLines(me, arg) {
    arg = arg || {};
    const base = arg.obj || {}, lines = Array.isArray(arg.lines) ? arg.lines : [];
    if (base.id) throw new UserError('새 팔로업에서만 여러 개로 나눌 수 있습니다.');
    if (lines.length < 2) throw new UserError('두 줄 이상일 때 여러 개로 나눌 수 있습니다.');
    if (lines.length > 30) throw new UserError('한 번에 30개까지 만들 수 있습니다.');
    const ids = [];
    tx(() => {
      for (const l of lines) {
        const obj = Object.assign({}, base, { title: clean(l && l.title).trim(), titleHtml: clean(l && l.titleHtml) });
        if (!obj.title) continue;
        ids.push(save(me, { table: 'followups', obj, noData: true }).savedId);
      }
    });
    if (!ids.length) throw new UserError('할 일을 입력하세요.');
    return Object.assign(getAll(me), { savedIds: ids });
  }
  function uploadMB() { const n = Number(getConfig().uploadMB); return Number.isFinite(n) && n >= 1 && n <= UPLOAD_MB_MAX ? n : UPLOAD_MB_DEFAULT; }
  function uploadLimit() { return Math.round(uploadMB() * 1024 * 1024); }
  function setMeta(key, value) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }
  function getMeta(key) { const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key); return r ? r.value : ''; }
  function getAutomation(me) {
    requireAdmin(me, '자동 백업·알림 설정');
    const status = {};
    ['backup', 'digest', 'filesync', 'schedule'].forEach((k) => { status[k] = { at: getMeta('run.' + k + '.at'), result: getMeta('run.' + k + '.result'), date: getMeta('run.' + k + '.date') }; });
    return { config: getConfig(), status, schedEx: db.prepare('SELECT * FROM schedex ORDER BY at DESC').all(),
      schedCount: db.prepare('SELECT COUNT(*) AS n FROM sched').get().n };
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
    if ('schedSheet' in arg) {
      const v = clean(arg.schedSheet).trim();
      const m = /\/spreadsheets\/d\/([\w-]{20,})/.exec(v) || /^([\w-]{20,})$/.exec(v);
      if (v && !m) throw new UserError('구글 시트 주소(https://docs.google.com/spreadsheets/d/…)를 붙여넣으세요.');
      next.schedSheet = m ? m[1] : '';
    }
    if ('schedOn' in arg) next.schedOn = arg.schedOn ? 'on' : '';
    if ('volumeGB' in arg) {
      const g = Number(arg.volumeGB);
      if (!Number.isFinite(g) || g < 0.5 || g > 10000) throw new UserError('저장 공간 크기는 0.5~10000 GB 사이 숫자로 입력하세요.');
      next.volumeGB = String(g);
    }
    if ('uploadMB' in arg) {
      const n = Number(arg.uploadMB);
      if (!Number.isFinite(n) || n < 1 || n > UPLOAD_MB_MAX) throw new UserError('파일 한 개 최대 크기는 1~' + UPLOAD_MB_MAX + ' MB 사이 숫자로 입력하세요.');
      next.uploadMB = String(n);
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
      UNION ALL SELECT u.storedName, u.name, u.category, u.createdAt, '' AS deletedAt,
        CASE WHEN u.programId != '' THEN IFNULL(p.name, '') || ' (대회·프로그램 자료)' ELSE IFNULL(v.name, '') || ' (대학 자료)' END AS studentName, '' AS studentId, CAST(u.size AS INTEGER) AS size, u.mime, 'uni' AS kind
      FROM unifiles u LEFT JOIN universities v ON v.id = u.universityId LEFT JOIN programs p ON p.id = u.programId ORDER BY 4`).all();
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
      summary: storageSummary(), volumeGB: getConfig().volumeGB, uploadMB: uploadMB(),
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
    db, filesDir, dbPath, listFiles, pendingSync, markSync, replaceSchedule, restoreFromDb, countTeachers, upsertAdmin, login, loginAs, logout, authenticate, addFile, getFile, addUniFile, getUniFile,
    rpc: { getAll: (me) => getAll(me), save, remove, restore, purge, getTrash, getLog, saveTeacher, changePassword, importData, copyCycle, getActivity, saveMany, updateMe,
      saveOption, removeOption, deleteTeacher, getAutomation, saveAutomation, saveEvent, removeEvent,
      saveWithFollowups, requestFollowup, saveOrder, saveUniFile, removeUniFile, saveProgram, removeProgram, getStorage, retrySync, saveHomeLayout, saveStudentCols, saveBreak, removeBreak, requestReview, doneReview, cancelReview, excludeSched, unexcludeSched, saveAutoCat, getNotices, noticeAct, fixSubjects, saveViewPref, savePref, getPrefs, saveCTemplate, removeCTemplate, savePriceList, getAppDraft, saveAppDraft, removeAppDraft, removeMany, restoreMany, purgeMany, addFollowupMany, addFollowupLines, saveSite, addMajorsMany, renameFaculty },
    studentSheetData, backup, getConfig, getMeta, recordRun, listTeachers, close: () => db.close(),
  };
}

module.exports = { openStore, UserError, MAX_UPLOAD };
