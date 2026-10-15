'use strict';
// npm test — 실제 HTTP로 서버 기능 검증 (임시 DB 사용)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../lib/store');
const { createApp } = require('../server');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-test-'));
let store, server, base;

before(async () => {
  store = openStore(path.join(dir, 'test.db'));
  store.upsertAdmin('Admin@Revera.test', '박원장', 'admin-pass-1');
  server = createApp(store).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { server.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** 쿠키를 기억하는 간단한 클라이언트 */
function client() {
  let cookie = '';
  async function req(method, url, body, headers, raw) {
    const res = await fetch(base + url, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-Requested-With': 'revera', Cookie: cookie }, headers || {}),
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const buf = Buffer.from(await res.arrayBuffer());
    let data; try { data = JSON.parse(buf.toString()); } catch (e) { data = buf; }
    return { status: res.status, data, headers: res.headers };
  }
  return {
    req,
    login: (email, password) => req('POST', '/api/login', { email, password }),
    rpc: (fn, arg) => req('POST', '/api/rpc/' + fn, { arg }),
    async ok(fn, arg) { const r = await this.rpc(fn, arg); assert.strictEqual(r.status, 200, fn + ': ' + JSON.stringify(r.data)); return r.data; },
    save(table, obj) { return this.rpc('save', { table, obj }); },
    async saveOk(table, obj) { const r = await this.save(table, obj); assert.strictEqual(r.status, 200, table + ': ' + JSON.stringify(r.data)); return r.data; },
    upload: (studentId, name, buf, category) => req('POST', '/api/files/upload?studentId=' + studentId + '&category=' + encodeURIComponent(category || '성적표'),
      undefined, { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) }, buf),
  };
}
async function newUser(admin, email, role) {
  await admin.ok('saveTeacher', { email, name: email.split('@')[0], role, password: 'temp-pass-1' });
  const c = client();
  assert.strictEqual((await c.login(email, 'temp-pass-1')).status, 200);
  await c.ok('changePassword', { current: 'temp-pass-1', next: 'mine-pass-1' });
  return c;
}

test('로그인·CSRF·로그인 잠금·상태 확인', async () => {
  const c = client();
  assert.strictEqual((await c.req('GET', '/healthz')).status, 200);
  assert.strictEqual((await c.rpc('getAll')).status, 401);
  assert.strictEqual((await c.login('admin@revera.test', 'wrong')).status, 401);
  assert.strictEqual((await c.login('ADMIN@revera.test', 'admin-pass-1')).status, 200);
  const d = await c.ok('getAll');
  assert.strictEqual(d.me.role, 'admin');
  assert.ok(!JSON.stringify(d).includes('passwordHash'));
  assert.strictEqual((await c.req('POST', '/api/rpc/getAll', {}, { 'X-Requested-With': '' })).status, 403);
  const x = client();
  for (let i = 0; i < 5; i++) await x.login('lock@revera.test', 'bad-password');
  assert.strictEqual((await x.login('lock@revera.test', 'bad-password')).status, 429);
});

test('역할별 권한: 컨설턴트는 담당 학생만, 상담기록·계약금액 불가', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  const staff = await newUser(admin, 'staff@revera.test', 'staff');
  const kim = await newUser(admin, 'kim@revera.test', 'consultant');
  const lee = await newUser(admin, 'lee@revera.test', 'consultant');

  // 학생 등록은 관리자·관리팀만
  assert.strictEqual((await kim.save('students', { name: '몰래 등록' })).status, 403);
  let d = await staff.saveOk('students', { name: '김학생', counselor: 'KIM@revera.test', tracks: ['3년특례', '홍콩'],
    memo: '=HYPERLINK("x") <script>', createdBy: 'hacker', driveUrl: 'https://drive.google.com/x' });
  const sA = d.students.find((s) => s.id === d.savedId);
  assert.strictEqual(sA.tracks, '3년특례, 홍콩');
  assert.strictEqual(sA.counselor, 'kim@revera.test');
  assert.strictEqual(sA.createdBy, 'staff@revera.test');
  assert.strictEqual(sA.memo, '=HYPERLINK("x") <script>');
  d = await staff.saveOk('students', { name: '이학생', counselor: 'lee@revera.test' });
  const sB = d.students.find((s) => s.id === d.savedId);
  assert.strictEqual((await staff.save('students', { id: sA.id, driveUrl: 'javascript:alert(1)' })).status, 400);

  await staff.saveOk('contracts', { studentId: sA.id, kind: '원서', tier: 'Standard', packages: ['홍콩 패키지'], amount: '30000', paid: '납부 완료' });
  await staff.saveOk('notes', { studentId: sA.id, date: '2026-10-15', content: '어머님과의 민감한 대화' });
  await staff.saveOk('scores', { studentId: sA.id, kind: 'SAT', score: '1400' });

  // 컨설턴트 kim: 김학생만 보이고, 상담기록 없음, 계약 금액 없음
  d = await kim.ok('getAll');
  assert.deepStrictEqual(d.students.map((s) => s.name), ['김학생']);
  assert.strictEqual(d.notes.length, 0);
  assert.strictEqual(d.contracts.length, 1);
  assert.ok(!('amount' in d.contracts[0]) && !('paid' in d.contracts[0]));
  assert.ok(!JSON.stringify(d).includes('30000') && !JSON.stringify(d).includes('민감한'));
  assert.strictEqual(d.scores.length, 1);
  // 컨설턴트 lee: 이학생만
  d = await lee.ok('getAll');
  assert.deepStrictEqual(d.students.map((s) => s.name), ['이학생']);
  assert.strictEqual(d.scores.length, 0);

  // 컨설턴트 쓰기 권한
  assert.strictEqual((await kim.save('notes', { studentId: sA.id, content: 'x' })).status, 403);
  assert.strictEqual((await kim.save('contracts', { studentId: sA.id, kind: '연간' })).status, 403);
  assert.strictEqual((await kim.save('scores', { studentId: sB.id, kind: 'SAT' })).status, 403);
  await kim.saveOk('scores', { studentId: sA.id, kind: 'TOEFL', score: '110' });
  await kim.saveOk('activities', { studentId: sA.id, name: 'Immerse', deadline: '2026-10-25' });
  await kim.saveOk('docs', { studentId: sA.id, name: '재학증명서' });
  await kim.saveOk('links', { studentId: sA.id, label: '회의록', url: 'https://docs.google.com/x' });
  assert.strictEqual((await kim.save('links', { studentId: sA.id, url: 'javascript:alert(1)' })).status, 400);
  d = await kim.ok('getAll');
  const me = d.students[0];
  d = await kim.saveOk('students', { id: me.id, updatedAt: me.updatedAt, storyTrigger: '계기', counselor: 'kim2@x.com' });
  assert.strictEqual(d.students[0].storyTrigger, '계기');
  assert.strictEqual(d.students[0].counselor, 'kim@revera.test', '컨설턴트는 담당자 변경 불가');
  assert.strictEqual((await kim.rpc('remove', { table: 'students', id: sA.id })).status, 403);
  assert.strictEqual((await kim.rpc('getTrash')).status, 403);
  assert.strictEqual((await kim.rpc('getLog')).status, 403);
  assert.strictEqual((await staff.rpc('getLog')).status, 403);
  assert.strictEqual((await kim.rpc('saveTeacher', { email: 'x@y.z', password: '12345678' })).status, 403);
  assert.strictEqual((await kim.req('GET', '/api/backup')).status, 403);

  // 담당자를 바꾸면 컨설턴트 화면에서 사라짐
  d = await staff.ok('getAll');
  const cur = d.students.find((s) => s.id === sA.id);
  await staff.saveOk('students', { id: sA.id, updatedAt: cur.updatedAt, counselor: 'lee@revera.test' });
  assert.strictEqual((await kim.ok('getAll')).students.length, 0);
  assert.strictEqual((await lee.ok('getAll')).students.length, 2);
});

test('삭제 → 휴지통 → 복구 / 영구 삭제 + 변경 기록', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  const staff = client();
  await staff.login('staff@revera.test', 'mine-pass-1');

  let d = await staff.saveOk('students', { name: '삭제테스트' });
  const sid = d.savedId;
  d = await staff.saveOk('apps', { studentId: sid, university: 'HKU' });
  const appId = d.savedId;
  await staff.saveOk('notes', { studentId: sid, date: '2026-10-15', content: '기록' });

  // 항목 하나 삭제 후 복구
  d = await staff.ok('remove', { table: 'apps', id: appId });
  assert.ok(!d.apps.some((a) => a.id === appId));
  let t = await staff.ok('getTrash');
  assert.ok(t.items.some((i) => i.id === appId && i.label === '지원대학' && i.deletedBy === 'staff@revera.test'));
  d = await staff.ok('restore', { table: 'apps', id: appId });
  assert.ok(d.apps.some((a) => a.id === appId));

  // 관리팀이 학생 삭제 → 학생과 기록 모두 화면에서 사라짐 → 복구하면 모두 돌아옴
  d = await staff.ok('remove', { table: 'students', id: sid });
  assert.ok(!d.students.some((s) => s.id === sid));
  assert.ok(!d.apps.some((a) => a.studentId === sid) && !d.notes.some((n) => n.studentId === sid));
  assert.strictEqual((await staff.save('apps', { studentId: sid, university: 'X' })).status, 404);
  d = await staff.ok('restore', { table: 'students', id: sid });
  assert.ok(d.students.some((s) => s.id === sid));
  assert.ok(d.apps.some((a) => a.id === appId) && d.notes.some((n) => n.studentId === sid));

  // 학생이 휴지통에 있으면 하위 항목만 먼저 복구할 수 없음
  await staff.ok('remove', { table: 'apps', id: appId });
  await staff.ok('remove', { table: 'students', id: sid });
  assert.match((await staff.rpc('restore', { table: 'apps', id: appId })).data.error, /학생을 먼저 복구/);

  // 영구 삭제는 관리자만, 휴지통에 있는 것만
  assert.strictEqual((await staff.rpc('purge', { table: 'students', id: sid })).status, 403);
  t = await admin.ok('purge', { table: 'students', id: sid });
  assert.ok(!t.items.some((i) => i.id === sid || i.id === appId));
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM apps WHERE studentId = ?').get(sid).n, 0);

  // 변경 기록: 누가 등록·삭제·복구했는지
  const log = (await admin.ok('getLog')).rows;
  const mine = log.filter((r) => r.summary.includes('삭제테스트'));
  const acts = mine.map((r) => r.email + ':' + r.action);
  for (const a of ['staff@revera.test:create', 'staff@revera.test:delete', 'staff@revera.test:restore', 'admin@revera.test:purge']) {
    assert.ok(acts.includes(a), a + ' 기록 없음: ' + acts.join(','));
  }
  assert.ok(mine.some((r) => r.tblLabel === '지원대학' && r.summary === '삭제테스트 · HKU'));
});

test('성적표 파일 업로드·다운로드 권한', async () => {
  const staff = client();
  await staff.login('staff@revera.test', 'mine-pass-1');
  const lee = client();
  await lee.login('lee@revera.test', 'mine-pass-1');
  const kim = client();
  await kim.login('kim@revera.test', 'mine-pass-1');

  const leeStudent = (await lee.ok('getAll')).students[0];
  const pdf = Buffer.from('%PDF-1.4 test transcript');
  let r = await lee.upload(leeStudent.id, '성적표 G11.pdf', pdf);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const f = r.data.files.find((x) => x.name === '성적표 G11.pdf');
  assert.ok(f && f.category === '성적표' && f.size === String(pdf.length));
  assert.ok(!('storedName' in f));

  r = await lee.req('GET', '/api/files/' + f.id);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'application/pdf');
  assert.strictEqual(r.headers.get('content-security-policy'), 'sandbox');
  assert.ok(Buffer.compare(r.data, pdf) === 0);
  assert.strictEqual((await kim.req('GET', '/api/files/' + f.id)).status, 403, '담당 아닌 컨설턴트는 못 받음');
  assert.strictEqual((await client().req('GET', '/api/files/' + f.id)).status, 401);

  assert.strictEqual((await lee.upload(leeStudent.id, 'evil.html', Buffer.from('<script>'))).status, 400);
  assert.strictEqual((await kim.upload(leeStudent.id, 'a.pdf', pdf)).status, 403);
  assert.strictEqual((await lee.upload(leeStudent.id, 'big.pdf', Buffer.alloc(21 * 1024 * 1024))).status, 413);

  // 파일도 휴지통 → 영구 삭제 시 디스크에서 제거
  await staff.ok('remove', { table: 'files', id: f.id });
  assert.strictEqual((await lee.req('GET', '/api/files/' + f.id)).status, 404);
  const stored = store.db.prepare('SELECT storedName FROM files WHERE id = ?').get(f.id).storedName;
  assert.ok(fs.existsSync(path.join(store.filesDir, stored)));
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  await admin.ok('purge', { table: 'files', id: f.id });
  await new Promise((res) => setTimeout(res, 50));
  assert.ok(!fs.existsSync(path.join(store.filesDir, stored)));
});

test('동시 수정 충돌 감지 + 계정 비활성화', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  let d = await admin.saveOk('students', { name: '충돌학생' });
  const s = d.students.find((x) => x.id === d.savedId);
  await admin.saveOk('students', { id: s.id, updatedAt: s.updatedAt, grade: 'G11' });
  const r = await admin.save('students', { id: s.id, updatedAt: s.updatedAt, grade: 'G12' });
  assert.strictEqual(r.status, 409);
  assert.match(r.data.error, /박원장 님이 먼저 수정/);

  const kim = client();
  await kim.login('kim@revera.test', 'mine-pass-1');
  await admin.ok('saveTeacher', { email: 'kim@revera.test', role: 'consultant', active: false });
  assert.strictEqual((await kim.rpc('getAll')).status, 401);
  assert.strictEqual((await kim.login('kim@revera.test', 'mine-pass-1')).status, 401);
});

test('이전 버전 DB를 데이터 손실 없이 새 구조로 업그레이드', () => {
  const oldPath = path.join(dir, 'old.db');
  const { openStore: openV1 } = require('./fixtures/store-v1');
  const v1 = openV1(oldPath);
  v1.upsertAdmin('boss@revera.test', '원장', 'boss-pass-1');
  const boss = { email: 'boss@revera.test', name: '원장', role: 'admin' };
  v1.rpc.saveTeacher(boss, { email: 't@revera.test', name: '선생', role: 'teacher', password: 'temp-pass-1' });
  let d = v1.rpc.saveStudent(boss, { name: '옛학생', school: 'SIS', counselor: 't@revera.test' });
  const sid = d.students[0].id;
  v1.rpc.saveNote(boss, { studentId: sid, date: '2026-01-01', type: '전화', content: '옛 기록' });
  v1.rpc.saveApp(boss, { studentId: sid, university: 'HKU', deadline: '2026-11-26' });
  v1.close();

  const v2 = openStore(oldPath);
  const me = { email: 'boss@revera.test', name: '원장', role: 'admin' };
  d = v2.rpc.getAll(me);
  assert.strictEqual(d.students[0].name, '옛학생');
  assert.strictEqual(d.students[0].deletedAt, '');
  assert.strictEqual(d.notes[0].content, '옛 기록');
  assert.strictEqual(d.notes[0].createdBy, 'boss@revera.test');
  assert.strictEqual(d.apps[0].university, 'HKU');
  assert.strictEqual(d.teachers.find((t) => t.email === 't@revera.test').role, 'consultant');
  // 업그레이드된 DB에서 새 기능 동작
  d = v2.rpc.save(me, { table: 'scores', obj: { studentId: sid, kind: 'SAT', score: '1500' } });
  assert.strictEqual(d.scores.length, 1);
  d = v2.rpc.save(me, { table: 'notes', obj: { studentId: sid, date: '2026-10-15', attendees: '원장님, 학생', content: '새 기록' } });
  assert.strictEqual(d.notes.length, 2);
  v2.rpc.remove(me, { table: 'notes', id: d.notes.find((n) => n.content === '옛 기록').id });
  assert.strictEqual(v2.rpc.getAll(me).notes.length, 1);
  v2.close();
  // 두 번 열어도 문제 없음
  openStore(oldPath).close();
});
