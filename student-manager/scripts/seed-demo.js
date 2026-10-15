'use strict';
/**
 * 화면 확인용 샘플 데이터가 들어간 데모 DB 생성 (실제 운영 DB와 별개)
 *   npm run demo  →  DB_PATH=data/demo.db npm start  →  admin@demo.test / demo-pass-1 로그인
 */
const fs = require('fs');
const path = require('path');
const { openStore } = require('../lib/store');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'demo.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) fs.rmSync(f, { force: true });
const store = openStore(dbPath);
store.upsertAdmin('admin@demo.test', '박원장', 'demo-pass-1');
const me = { email: 'admin@demo.test', name: '박원장', role: 'admin' };
const r = store.rpc;

r.saveTeacher(me, { email: 'kim@demo.test', name: '김선생', password: 'demo-pass-1' });
r.saveTeacher(me, { email: 'lee@demo.test', name: '이선생', password: 'demo-pass-1' });
// 데모에서는 바로 쓸 수 있게 비밀번호 변경 요구 해제
store.db.prepare('UPDATE teachers SET mustChangePassword = 0').run();

const d = (n) => { const x = new Date(Date.now() + 9 * 3600000); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const people = [
  ['샘플 학생A', 'SIS', 'G12', 'IB', 'admin@demo.test', '진행중', '미대,장학금'],
  ['샘플 학생B', 'KIS', 'G11', 'AP', 'kim@demo.test', '상담중', '신규'],
  ['샘플 학생C', 'Dwight', 'G12', 'IB', 'lee@demo.test', '진행중', ''],
  ['샘플 학생D', '대원외고', '고3', '국내 특목고', 'kim@demo.test', '보류', ''],
  ['샘플 학생E', 'SFS', 'G12', 'AP', 'admin@demo.test', '완료', ''],
];
for (const p of people) {
  r.saveStudent(me, { name: p[0], school: p[1], grade: p[2], curriculum: p[3], counselor: p[4], status: p[5], tags: p[6],
    parentName: '학부모', parentPhone: '010-0000-0000' });
}
const all = r.getAll(me).students;
const id = (i) => all.find((s) => s.name === people[i][0]).id;

r.saveNote(me, { studentId: id(0), date: d(-7), type: '대면상담', content: '지원 리스트 확정. Early 1곳, 나머지 RD.\n에세이 주제 3개 중 2번으로 결정.', nextAction: 'Common App 에세이 초안 받기', nextDue: d(-1) });
r.saveNote(me, { studentId: id(0), date: d(-1), type: '학부모상담', content: '학부모님께 일정 공유.' });
r.saveNote(me, { studentId: id(1), date: d(-3), type: '전화', content: '첫 상담 예약 확인.', nextAction: '성적표 사본 받기', nextDue: d(4) });
r.saveNote(me, { studentId: id(2), date: d(-2), type: '카톡·문자', content: '활동 리스트 정리본 받음.', nextAction: '추천서 요청 메일 확인', nextDue: d(10) });
r.saveApp(me, { studentId: id(0), university: 'Stanford', major: 'Art Practice', round: 'REA', deadline: d(2), status: '작성중', essay: '수정중' });
r.saveApp(me, { studentId: id(0), university: 'RISD', round: 'EA', deadline: d(17), status: '준비중', essay: '초안' });
r.saveApp(me, { studentId: id(0), university: 'Cornell', round: 'RD', deadline: d(80), status: '준비중' });
r.saveApp(me, { studentId: id(2), university: 'University of Toronto', round: 'Rolling', deadline: d(9), status: '준비중', essay: '미착수' });
r.saveApp(me, { studentId: id(2), university: 'NYU', round: 'ED', deadline: d(-2), status: '제출완료', essay: '완료' });
r.saveApp(me, { studentId: id(3), university: '연세대', major: '경영', round: '수시', deadline: d(-1), status: '작성중' });

store.close();
console.log('데모 DB 생성: ' + dbPath + '\n실행: DB_PATH=' + dbPath + ' npm start\n로그인: admin@demo.test / demo-pass-1');
