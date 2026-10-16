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
const month = d(0).slice(0, 7);

const a = save('students', { name: '샘플 학생A', school: 'CISS', grade: 'G12', curriculum: 'AP', counselor: 'kim@demo.test',
  status: '진행중', tracks: ['3년특례', '홍콩'], motherName: '학부모A', motherPhone: '010-0000-0000', motherWechat: 'wx_sample',
  driveUrl: 'https://drive.google.com/drive/folders/sample', resumeUrl: 'https://docs.google.com/document/d/sample',
  storyStatus: '검토 중', storyTrigger: '치료견 프로그램 봉사에서 학생들의 스트레스가 줄어드는 것을 관찰',
  storyProcess: '인간-동물 상호작용(HAI) 논문 리뷰, 교내 설문 진행', storyLink: 'HKU 심리학과 BPsych — 웰빙 연구실',
  storyConclusion: '' });
const b = save('students', { name: '샘플 학생B', school: 'SAS', grade: 'G12', curriculum: 'AP', counselor: 'lee@demo.test',
  status: '진행중', tracks: ['3년특례', '홍콩', '싱가폴'] });
const c = save('students', { name: '샘플 학생C', school: 'HIS', grade: 'G11', curriculum: 'IB', counselor: 'kim@demo.test',
  status: '상담중', tracks: ['12년특례'] });

const ca = save('contracts', { studentId: a, kind: '원서', tier: 'Standard', packages: ['홍콩 패키지', '한국 3특'], startMonth: month,
  signedDate: d(-30), currency: 'RMB', amount: '30000', payDue: d(-3), scope: 'HKU + HKUST + 한국 3특. 미국 에세이 미포함' });
save('payments', { studentId: a, contractId: ca, date: d(-30), amount: '15000', currency: 'RMB', method: '위챗페이', memo: '1차 분할' });
const ccA = save('contracts', { studentId: c, kind: '연간', tier: 'Standard', term: '1학기', startMonth: d(-150).slice(0, 7), currency: 'KRW', amount: '5000000' });
save('payments', { studentId: c, contractId: ccA, date: d(-140), amount: '5000000', currency: 'KRW', method: '계좌이체' });
const cb = save('contracts', { studentId: b, kind: '원서', tier: 'Standard', packages: ['홍콩 패키지', '싱가폴'], startMonth: month, currency: 'RMB', amount: '40000' });
save('contracts', { studentId: b, kind: '연간', tier: 'Standard', term: '1년', startMonth: d(-300).slice(0, 7), currency: 'RMB', amount: '20000' });
save('payments', { studentId: b, contractId: cb, date: d(-10), amount: '40000', currency: 'RMB', method: '알리페이' });

save('notes', { studentId: a, date: d(-5), time: 'PM 1:00', place: '상담실', attendees: '원장님, 학생, 어머님, 김컨설턴트',
  type: '대면상담', content: '1. HKU 심리학 단독 지원 확정\n2. 추천서 3인 확정', nextAction: '출입국사실증명서 수합 안내', nextDue: d(-1) });
save('notes', { studentId: b, date: d(-2), type: '위챗·문자', content: '어머님 일정 문의 대응', nextAction: '에세이 타임라인 공유', nextDue: d(5) });

save('scores', { studentId: a, kind: 'SAT', score: '1400', detail: 'RW 700 · Math 700', date: d(-60), memo: '목표 1450' });
save('scores', { studentId: a, kind: 'TOEFL', score: '118', detail: 'R30 L30 S29 W29', date: d(-90) });
save('scores', { studentId: a, kind: 'AP', subject: 'Calculus AB', score: '4', date: d(-120) });
save('scores', { studentId: c, kind: 'IB', subject: 'Biology HL', score: '7' });

save('apps', { studentId: a, country: '홍콩', university: 'HKU', major: 'Psychology (BPsych)', round: '홍콩 얼리', deadline: d(12), status: '작성중', essay: '수정중' });
save('apps', { studentId: b, country: '홍콩', university: 'HKUST', major: 'Electronic Engineering', round: '홍콩 얼리', deadline: d(6), status: '준비중', essay: '초안' });
save('apps', { studentId: a, country: '한국', university: '성균관대', major: '심리학', round: '3년특례', deadline: d(40), status: '준비중' });
save('apps', { studentId: b, country: '싱가폴', university: 'NUS', major: 'Computer Engineering', round: 'RD', deadline: d(-200), status: '합격' });
save('apps', { studentId: b, country: '홍콩', university: 'HKU', major: 'Engineering', round: '홍콩 얼리', deadline: d(-190), status: '불합격' });
save('docs', { studentId: a, name: '출입국사실증명서(학생)', status: '요청함' });
save('docs', { studentId: a, name: '재학증명서', status: '수합 완료' });
save('links', { studentId: a, label: '회의록', url: 'https://docs.google.com/spreadsheets/d/sample' });

store.close();
console.log('데모 DB 생성: ' + dbPath + '\n실행: DB_PATH=' + dbPath + ' npm start\n' +
  '로그인(비밀번호 demo-pass-1): admin@demo.test 관리자 / staff@demo.test 관리팀 / kim@demo.test 컨설턴트');
