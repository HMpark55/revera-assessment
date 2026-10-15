// 서버 로직(Code.gs) 테스트: node dev/test-server.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const MockGAS = require('./mock-gas.js');

const ctx = {};
vm.createContext(ctx);
const state = MockGAS.install(ctx, { user: 'Admin@Revera.test' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), ctx);
const call = (fn, ...a) => ctx[fn](...a);
const throws = (f, re) => assert.throws(f, (e) => re.test(e.message), 'expected error ' + re);

// 1. setup — 관리자 등록
assert.match(call('setup'), /관리자/);
call('setup'); // 두 번 실행해도 중복 등록 안 됨
let d = call('getAll');
assert.strictEqual(d.teachers.length, 1);
assert.strictEqual(d.me.role, 'admin');
assert.strictEqual(d.me.email, 'admin@revera.test');

// 2. 학생 등록/검증
throws(() => call('saveStudent', { name: '  ' }), /필수/);
d = call('saveStudent', { name: '김학생', school: 'SIS', parentPhone: '010-1234-5678', memo: '=HYPERLINK("x")', bogus: 'x', createdBy: 'hacker' });
const s = d.students[0];
assert.strictEqual(s.name, '김학생');
assert.strictEqual(s.memo, '=HYPERLINK("x")', '수식 문자열은 텍스트로 보존');
assert.strictEqual(s.createdBy, 'admin@revera.test', '서버 관리 필드는 클라이언트가 못 바꿈');
assert.ok(!('bogus' in s));

// 3. 동시 수정 충돌 감지
const stale = s.updatedAt;
d = call('saveStudent', { id: s.id, updatedAt: stale, name: '김학생', grade: 'G11' });
assert.strictEqual(d.students[0].grade, 'G11');
assert.strictEqual(d.students[0].school, 'SIS', '보내지 않은 필드는 유지');
// mock 시간 해상도가 ms라서 같을 수 있으니 강제로 다르게
ctx.SpreadsheetApp.openById().getSheetByName('학생').rows[1][16] = '2099-01-01T00:00:00.000';
throws(() => call('saveStudent', { id: s.id, updatedAt: stale, name: '덮어쓰기' }), /먼저 수정/);

// 4. 상담기록·지원대학
throws(() => call('saveNote', { studentId: 'nope', content: 'x' }), /존재하지 않는/);
throws(() => call('saveNote', { studentId: s.id }), /입력하세요/);
d = call('saveNote', { studentId: s.id, date: '2026-10-15', type: '대면상담', content: '첫 상담\n여러 줄', nextAction: '에세이 초안', nextDue: '2026-10-20' });
const n = d.notes[0];
assert.strictEqual(n.author, 'admin@revera.test');
assert.strictEqual(n.content, '첫 상담\n여러 줄');
d = call('saveNote', Object.assign({}, n, { done: true }));
assert.strictEqual(d.notes[0].done, 'TRUE');
d = call('saveApp', { studentId: s.id, university: 'Stanford', round: 'REA', deadline: '2026-11-01', status: '준비중' });
assert.strictEqual(d.apps.length, 1);
d = call('saveApp', { studentId: s.id, university: 'MIT', round: 'EA', deadline: '2026-11-01' });
d = call('deleteApp', d.apps.find((a) => a.university === 'MIT').id);
assert.strictEqual(d.apps.length, 1);
throws(() => call('deleteApp', 'nope'), /이미 삭제/);

// 5. 선생님 관리 + 권한
d = call('saveTeacher', { email: 'T1@revera.test', name: '박선생', role: 'teacher' });
assert.strictEqual(d.teachers.length, 2);
assert.deepStrictEqual(state.ss.editors, ['t1@revera.test']);
throws(() => call('saveTeacher', { email: 'admin@revera.test', role: 'teacher' }), /본인/);
throws(() => call('saveTeacher', { email: 'bad' }), /형식/);

state.user = 't1@revera.test';
d = call('getAll');
assert.strictEqual(d.me.role, 'teacher');
throws(() => call('deleteStudent', s.id), /관리자만/);
throws(() => call('saveTeacher', { email: 'x@y.z' }), /관리자만/);
d = call('saveNote', { studentId: s.id, date: '2026-10-16', type: '전화', content: '학부모 통화' });
assert.strictEqual(d.notes.length, 2);

state.user = 'stranger@gmail.com';
throws(() => call('getAll'), /등록되지 않은/);
state.user = '';
throws(() => call('getAll'), /로그인 정보/);

// 비활성화하면 접근 불가
state.user = 'admin@revera.test';
call('saveTeacher', { email: 't1@revera.test', name: '박선생', role: 'teacher', active: false });
state.user = 't1@revera.test';
throws(() => call('getAll'), /등록되지 않은/);

// 6. 학생 삭제 시 연쇄 삭제
state.user = 'admin@revera.test';
call('saveStudent', { name: '이학생' });
d = call('deleteStudent', s.id);
assert.strictEqual(d.students.length, 1);
assert.strictEqual(d.notes.length, 0);
assert.strictEqual(d.apps.length, 0);

// 7. 시트가 Date 객체를 돌려줘도 문자열로 정규화
const sh = state.ss.getSheetByName('학생');
sh.rows[1][2] = new Date('2010-03-04T00:00:00+09:00');
assert.strictEqual(call('getAll').students[0].dob, '2010-03-04');

// 8. 변경로그 기록
assert.ok(state.ss.getSheetByName('변경로그').rows.length > 10);

console.log('모든 서버 테스트 통과');
