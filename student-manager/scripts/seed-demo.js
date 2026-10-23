'use strict';
/**
 * 화면 확인용 샘플 데이터가 들어간 데모 DB 생성 (실제 운영 DB와 별개)
 *   npm run demo  →  DB_PATH=data/demo.db npm start
 *   로그인: admin@demo.test(관리자) / staff@demo.test(관리팀) / kim@demo.test(컨설턴트), 비밀번호 모두 demo-pass-1
 */
const fs = require('fs');
const path = require('path');
const { openStore } = require('../lib/store');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'demo.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) fs.rmSync(f, { force: true });
fs.rmSync(path.join(path.dirname(dbPath), 'files'), { recursive: true, force: true });
const store = openStore(dbPath);
store.upsertAdmin('admin@demo.test', '박원장', 'demo-pass-1');
const me = { email: 'admin@demo.test', name: '박원장', role: 'admin' };
const r = store.rpc;
const save = (table, obj) => r.save(me, { table, obj }).savedId;

r.saveTeacher(me, { email: 'staff@demo.test', name: '최관리', role: 'staff', password: 'demo-pass-1' });
r.saveTeacher(me, { email: 'kim@demo.test', name: '김컨설턴트', role: 'consultant', password: 'demo-pass-1' });
r.saveTeacher(me, { email: 'lee@demo.test', name: '이컨설턴트', role: 'consultant', password: 'demo-pass-1' });
// 데모에서는 바로 쓸 수 있게 비밀번호 변경 요구 해제
store.db.prepare('UPDATE teachers SET mustChangePassword = 0').run();

const d = (n) => { const x = new Date(Date.now() + 9 * 3600000); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

const a = save('students', { name: '샘플 학생A', school: 'CISS', grade: 'G12', curriculum: 'AP', counselor: 'kim@demo.test',
  manager: 'staff@demo.test', status: '진행중', tracks: ['3년특례', '홍콩'], motherName: '학부모A', motherPhone: '010-0000-0000',
  driveUrl: 'https://drive.google.com/drive/folders/sample', resumeUrl: 'https://docs.google.com/document/d/sample',
  progress: 'HKU 심리학 에세이 2차 수정 중. 추천서 3인 확정, 출입국사실증명서 대기' });
const b = save('students', { name: '샘플 학생B', school: 'SAS', grade: 'G12', curriculum: 'AP', counselor: 'lee@demo.test',
  manager: 'staff@demo.test', status: '진행중', progress: 'HKUST 얼리 원서 작성 시작', tracks: ['3년특례', '홍콩', '싱가폴'] });
const c = save('students', { name: '샘플 학생C', school: 'HIS', grade: 'G11', curriculum: 'IB', counselor: '', manager: 'staff@demo.test',
  status: '상담중', tracks: ['12년특례'] });

['CISS', 'SAS', 'HIS'].forEach((v) => r.saveOption(me, { kind: 'school', value: v }));
const ca = save('contracts', { studentId: a, kind: '원서', tier: 'Standard', packages: ['홍콩 패키지', '한국 3특'], startDate: d(-20),
  signedDate: d(-30), currency: 'RMB', amount: '30000', payDue: d(-3), scope: 'HKU + HKUST + 한국 3특. 미국 에세이 미포함' });
save('payments', { studentId: a, contractId: ca, date: d(-30), amount: '15000', currency: 'RMB', method: '위챗페이', memo: '1차 분할' });
const ccA = save('contracts', { studentId: c, kind: '연간', tier: 'Standard', term: '1학기', startMonth: d(-150).slice(0, 7), currency: 'KRW', amount: '5000000' });
save('payments', { studentId: c, contractId: ccA, date: d(-140), amount: '5000000', currency: 'KRW', method: '계좌이체' });
const cb = save('contracts', { studentId: b, kind: '원서', tier: 'Standard', packages: ['홍콩 패키지', '싱가폴'], startDate: d(-20), currency: 'RMB', amount: '40000' });
save('contracts', { studentId: b, kind: '연간', tier: 'Standard', term: '1년', startMonth: d(-300).slice(0, 7), currency: 'RMB', amount: '20000' });
save('payments', { studentId: b, contractId: cb, date: d(-10), amount: '40000', currency: 'RMB', method: '알리페이' });

save('notes', { studentId: a, date: d(-5), time: 'PM 1:00', place: '상담실', attendees: '원장님, 학생, 어머님, 김컨설턴트',
  type: '대면상담', content: '1. HKU 심리학 단독 지원 확정\n2. 추천서 3인 확정', nextAction: '출입국사실증명서 수합 안내', nextDue: d(-1) });
save('notes', { studentId: b, date: d(-2), type: '위챗·문자', content: '어머님 일정 문의 대응', nextAction: '에세이 타임라인 공유', nextDue: d(5) });

const fuDoc = save('followups', { studentId: a, title: '출입국사실증명서 받기', assignee: 'staff@demo.test', due: d(-1), category: '서류', detail: '위챗: 출입국사실증명서 이번 주 안에 받아서 스캔해 줄래?' });
save('fureplies', { studentId: a, followupId: fuDoc, who: '학생', date: d(0), content: '금요일에 어머니가 발급받아 주신대요' });
save('followups', { studentId: a, title: '에세이 2차 피드백 전달', assignee: 'kim@demo.test', due: d(3), status: '진행 중', category: '에세이' });
save('followups', { studentId: a, title: '추천서 요청 메일 발송', assignee: 'kim@demo.test', status: '완료' });
save('followups', { studentId: b, title: '어머님께 에세이 타임라인 공유', assignee: 'lee@demo.test', due: d(5) });
save('followups', { studentId: c, title: '담당 컨설턴트 배정', assignee: 'admin@demo.test', due: d(7), status: '대기' });

save('majorplans', { studentId: a, date: d(-200), major: 'Biology', field: '자연과학', status: '제외', source: '학부모 의견', reason: '화학 성적이 기대보다 낮아 제외' });
save('majorplans', { studentId: a, date: d(-90), major: 'Psychology', field: '사회과학', status: '최종', source: '학생 희망', reason: '치료견 봉사·HAI 리서치와 연결', parentConfirmed: true });
const hkust = r.getAll(me).universities.find((u) => u.name === 'HKUST').id;
save('majorplans', { studentId: a, date: d(-60), universityId: hkust, major: 'Neuroscience', field: '자연과학', status: '후보', source: '컨설턴트 제안', reason: 'HKUST 지원 시 대안' });
save('schools', { studentId: a, school: '서울 OO초등학교', country: '한국', city: '서울', gradeFrom: 'G1', gradeTo: 'G4', startDate: '2015-03-02', endDate: '2019-02-15' });
save('schools', { studentId: a, school: 'Shanghai Community International School', country: '중국', city: '상하이', gradeFrom: 'G5', gradeTo: 'G8', startDate: '2019-08-20', endDate: '2023-06-10', memo: '아버지 주재원 발령으로 전학' });
save('schools', { studentId: a, school: 'Concordia International School Shanghai', country: '중국', city: '상하이', gradeFrom: 'G9', gradeTo: 'G12', startDate: '2023-08-16' });
r.saveMany(me, { table: 'courses', objs: [
  { studentId: a, grade: 'G11', schoolYear: '2025-2026', subject: 'AP Psychology', level: 'AP', termType: '1년(2학기)', g1: 'A', g2: 'A', final: 'A' },
  { studentId: a, grade: 'G11', schoolYear: '2025-2026', subject: 'AP Calculus AB', level: 'AP', termType: '1년(2학기)', g1: 'A-', g2: 'A' },
  { studentId: a, grade: 'G11', schoolYear: '2025-2026', subject: 'Health', level: 'Regular', termType: '1학기만', g1: 'A' },
  { studentId: a, grade: 'G12', schoolYear: '2026-2027', subject: 'AP Biology', level: 'AP', termType: '1년(2학기)' },
  { studentId: a, grade: 'G12', schoolYear: '2026-2027', subject: 'English 12', level: 'Honors', termType: '1년(2학기)' },
  { studentId: a, grade: 'G12', schoolYear: '2026-2027', subject: 'Statistics', level: 'Regular', termType: 'Trimester', g1: 'B+' },
] });

save('accounts', { studentId: a, category: '시험', site: 'College Board (SAT·AP)', url: 'https://www.collegeboard.org', loginId: 'sample.a@example.com', password: 'demo-College1' });
save('accounts', { studentId: a, category: '원서 포털', site: 'HKU 원서 포털', universityId: r.getAll(me).universities.find((u) => u.name === 'HKU').id, loginId: 'sampleA2027', password: 'demo-Hku-22', memo: '등록 완료' });
save('accounts', { studentId: a, category: '학교 LMS', site: 'Schoology', url: 'https://app.schoology.com', loginId: 'a.sample' });
store.db.prepare("UPDATE students SET hopeUnis = ?, focusArea = ?, englishName = ?, address = ?, addressEn = ? WHERE id = ?")
  .run('1순위 홍콩 HKU 심리 / 3년특례: 성균관대', 'G12 AP Psychology·Biology 유지, 에세이 집중', 'SAMPLE STUDENT A', '(예시) 상하이시 푸둥신구 ○○로 100', '(Example) 100 ○○ Road, Pudong, Shanghai', a);
save('meetings', { studentId: a, date: d(-5), time: 'PM 1:00', type: '대면', place: '상담실', attendees: '원장님, 학생, 어머님, 김컨설턴트', writer: '김컨설턴트',
  topic: 'HKU 심리학 단독 지원 확정', content: '1. HKU 심리학 단독 지원 확정\n2. 추천서 3인 확정\n3. Science Fair 주제: 치료견 프로그램 효과', nextStep: '다음 미팅에서 PS 2차본 검토', status: '완료' });
save('meetings', { studentId: a, date: d(-30), time: 'AM 11:00', type: 'ZOOM', place: 'ZOOM', attendees: '원장님, 학생', writer: '최관리', topic: '첫 미팅 — Resume 시작',
  content: '첫 미팅이라 Resume 작성을 시작하고 전공 방향 논의', status: '완료', needsReview: true, sourceUrl: 'https://docs.google.com/spreadsheets/d/sample' });
save('scores', { studentId: a, kind: 'SAT', score: '1350', detail: 'RW 660 · Math 690', date: d(-200), memo: '1차 응시' });
save('scores', { studentId: c, kind: 'IB Predicted', subject: 'Biology HL', score: '6' });
save('scores', { studentId: a, kind: 'SAT', score: '1400', detail: 'RW 700 · Math 700', date: d(-60), memo: '목표 1450' });
save('scores', { studentId: a, kind: 'TOEFL', score: '118', detail: 'R30 L30 S29 W29', date: d(-90) });
save('scores', { studentId: a, kind: 'AP', subject: 'Calculus AB', score: '4', date: d(-120) });
save('scores', { studentId: c, kind: 'IB', subject: 'Biology HL', score: '7' });

save('apps', { studentId: a, country: '홍콩', university: 'HKU', major: 'Psychology (BPsych)', round: '홍콩 얼리', deadline: d(12), status: '작성중', essay: '수정중', parentConfirmed: 'TRUE' });
save('apps', { studentId: b, country: '홍콩', university: 'HKUST', major: 'Electronic Engineering', round: '홍콩 얼리', deadline: d(6), status: '준비중', essay: '초안' });
save('universities', { name: '성균관대', country: '한국', fullName: '성균관대학교' });
save('apps', { studentId: a, country: '한국', university: '성균관대', major: '심리학', round: '3년특례', deadline: d(40), status: '준비중' });
save('apps', { studentId: b, country: '싱가폴', university: 'NUS', major: 'Computer Engineering', round: 'RD', deadline: d(-200), status: '합격' });
save('apps', { studentId: b, country: '홍콩', university: 'HKU', major: 'Engineering', round: '홍콩 얼리', deadline: d(-190), status: '불합격' });
save('docs', { studentId: a, name: '출입국사실증명서(학생)', category: '지원자격증빙(출입국·여권 등)', status: '요청함' });
save('docs', { studentId: a, name: '재학증명서', category: '재학증명서', status: '수합 완료' });
save('links', { studentId: a, label: '회의록', url: 'https://docs.google.com/spreadsheets/d/sample' });
// 회의록에서 나온 팔로업 + 다음 미팅 날짜, 다른 선생님에게 요청한 팔로업
const kimMe = { email: 'kim@demo.test', name: '김컨설턴트', role: 'consultant' };
const m3 = r.saveWithFollowups(kimMe, { table: 'meetings', obj: { studentId: a, date: d(-1), time: 'PM 4:00', type: 'ZOOM', attendees: '학생, 김컨설턴트', writer: '김컨설턴트',
  topic: 'PS 2차본 검토', content: '1. PS 2차본 검토 — 도입부 수정\n2. 추천서 진행 상황 확인', nextDate: d(6), status: '완료' },
  followups: [{ title: 'PS 3차본 받기', assignee: 'kim@demo.test', due: d(3) }, { title: '추천서 제출 여부 학교에 확인', assignee: 'kim@demo.test', due: d(2) }] });
const reqFu = m3.followups.find((f) => f.meetingId === m3.savedId && f.title.startsWith('추천서'));
r.requestFollowup(kimMe, { id: reqFu.id, to: 'staff@demo.test', note: '저 이번 주 휴무라 대신 챙겨주세요' });
// 대학 자료 (예시 파일)
const hku = store.db.prepare("SELECT id FROM universities WHERE name = 'HKU'").get();
const hkuCycle = hku && store.db.prepare('SELECT id FROM unicycles WHERE universityId = ? ORDER BY year DESC').get(hku.id);
if (hkuCycle) store.addUniFile(me, { cycleId: hkuCycle.id, category: '공식 안내', name: 'HKU 입학 안내 (예시).pdf', buffer: Buffer.from('%PDF-1.4\n% demo\n') });
// 원서 정보 (예시 — 실제 인물 아님)
const hkuId = store.db.prepare("SELECT id FROM universities WHERE name = 'HKU'").get();
save('appinfo', { studentId: a, item: '추천인 1', universityId: hkuId ? hkuId.id : '', content: '이름: (예시) Teacher A\n직책: Teacher\n과목: Economics / Mathematics\n이메일: teacher.a@example.org' });
save('appinfo', { studentId: a, item: '추천인 2', content: '이름: (예시) Teacher C\n과목: Biology\n이메일: teacher.c@example.org', sent: 'TRUE' });
save('appinfo', { studentId: a, item: '카운슬러', content: '이름: (예시) Counselor B\n이메일: counselor.b@example.org' });
save('appinfo', { studentId: a, item: '졸업 예정일', content: '2027-06' });
// 메인 화면 공용 달력 (날짜는 예시)
r.saveEvent(me, { date: d(9), title: 'SAT 시험 (예시)', category: '시험', memo: '시험장·준비물 학생들에게 안내' });
r.saveEvent(me, { date: d(2), title: 'SAT 접수 마감 (예시)', category: '시험' });
r.saveEvent(me, { date: d(20), endDate: d(22), title: '홍콩 대학 설명회 (예시)', category: '설명회·행사' });
r.saveEvent(me, { date: d(30), endDate: d(36), title: '학원 휴무 (예시)', category: '휴무' });
r.saveEvent(me, { date: d(14), title: 'CISS 중간고사 시작 (예시)', category: '학교' });
r.saveEvent(me, { date: d(8), title: 'Immerse essay 마감 (예시)', category: '원서·입시' });
// 대회·프로그램 (예시 — 일정·조건은 실제와 다를 수 있음)
r.saveProgram(me, { name: 'Immerse Education Essay Competition (예시)', category: '에세이 대회', target: '13–18세', schedule: '마감·주제는 해마다 홈페이지 확인',
  deadline: d(8), url: 'https://example.org/immerse', memo: '주제 중 하나를 골라 에세이 제출 (예시 메모)' });
r.saveProgram(me, { name: '예시 서머 리서치 프로그램', category: '서머 프로그램', target: 'G10–G11', schedule: '봄 지원, 여름 진행', url: 'https://example.org/summer', memo: '추천서 1부 필요 (예시)' });

store.close();
console.log('데모 DB 생성: ' + dbPath + '\n실행: DB_PATH=' + dbPath + ' npm start\n' +
  '로그인(비밀번호 demo-pass-1): admin@demo.test 관리자 / staff@demo.test 관리팀 / kim@demo.test 컨설턴트');
