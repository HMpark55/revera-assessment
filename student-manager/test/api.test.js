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

test('매출: 계약 금액·분할 입금·통화, 컨설턴트에게는 숨김', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  const staff = client();
  await staff.login('staff@revera.test', 'mine-pass-1');
  const lee = client();
  await lee.login('lee@revera.test', 'mine-pass-1');
  const sid = (await lee.ok('getAll')).students[0].id;

  let d = await staff.saveOk('contracts', { studentId: sid, kind: '연간', term: '1년', currency: 'KRW', amount: '6,000,000', payDue: '2026-11-01' });
  const cid = d.savedId;
  assert.strictEqual(d.contracts.find((c) => c.id === cid).currency, 'KRW');
  assert.strictEqual((await staff.save('contracts', { studentId: sid, kind: '연간', currency: 'USD' })).status, 400);
  // 분할 입금: 통화는 계약 통화를 따라감, 금액은 숫자로 정리
  d = await staff.saveOk('payments', { studentId: sid, contractId: cid, date: '2026-10-01', amount: '2,000,000', method: '계좌이체' });
  const p1 = d.payments.find((p) => p.id === d.savedId);
  assert.strictEqual(p1.currency, 'KRW');
  assert.strictEqual(p1.amount, '2000000');
  await staff.saveOk('payments', { studentId: sid, contractId: cid, date: '2026-10-10', amount: '1000000' });
  assert.strictEqual((await staff.save('payments', { studentId: sid, contractId: cid, date: '2026-10-11', amount: '0' })).status, 400);
  assert.strictEqual((await staff.save('payments', { studentId: sid, contractId: cid, amount: '10' })).status, 400);
  assert.strictEqual((await staff.save('payments', { studentId: sid, contractId: 'nope', date: '2026-10-11', amount: '10' })).status, 400);

  // 컨설턴트: 입금·금액·통화·납부기한 모두 안 내려감, 입금 기록 불가
  d = await lee.ok('getAll');
  assert.strictEqual(d.payments.length, 0);
  const c = d.contracts.find((x) => x.id === cid);
  for (const k of ['amount', 'currency', 'payDue', 'paid']) assert.ok(!(k in c), k);
  assert.ok(!JSON.stringify(d).includes('6,000,000') && !JSON.stringify(d).includes('2000000'));
  assert.strictEqual((await lee.save('payments', { studentId: sid, contractId: cid, date: '2026-10-11', amount: '10' })).status, 403);

  // 계약을 영구 삭제하면 입금 기록도 함께 정리
  await staff.ok('remove', { table: 'contracts', id: cid });
  await admin.ok('purge', { table: 'contracts', id: cid });
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM payments WHERE contractId = ?').get(cid).n, 0);
});

test('서류에 파일을 올리면 자동 수합 완료 + 받은 날짜/사람 기록', async () => {
  const lee = client();
  await lee.login('lee@revera.test', 'mine-pass-1');
  const sid = (await lee.ok('getAll')).students[0].id;
  let d = await lee.saveOk('docs', { studentId: sid, name: '출입국사실증명서(학생)', status: '요청함' });
  const docId = d.savedId;
  const r = await lee.req('POST', '/api/files/upload?studentId=' + sid + '&docId=' + docId, undefined,
    { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('출입국.pdf') }, Buffer.from('%PDF-1.4'));
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const doc = r.data.docs.find((x) => x.id === docId);
  assert.strictEqual(doc.status, '수합 완료');
  assert.strictEqual(doc.receivedBy, 'lee@revera.test');
  assert.ok(doc.receivedAt);
  const f = r.data.files.find((x) => x.docId === docId);
  assert.ok(f && f.category === '서류' && f.name === '출입국.pdf');
  // 다른 학생의 서류 id로는 올릴 수 없음
  const other = await client();
  await other.login('admin@revera.test', 'admin-pass-1');
  d = await other.saveOk('students', { name: '서류다른학생' });
  assert.strictEqual((await other.req('POST', '/api/files/upload?studentId=' + d.savedId + '&docId=' + docId, undefined,
    { 'Content-Type': 'application/pdf', 'X-File-Name': 'a.pdf' }, Buffer.from('%PDF'))).status, 404);
});

test('기존 데이터 가져오기 (관리자 전용, 같은 이름은 건너뜀)', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  const staff = client();
  await staff.login('staff@revera.test', 'mine-pass-1');
  const data = { format: 'compass-import-v1', students: [
    { name: '가져온학생', school: 'CISS', grade: 'G12', tracks: ['3년특례', '홍콩'], counselorName: 'lee', resumeUrl: 'https://docs.google.com/document/d/x',
      contracts: [{ kind: '원서', tier: 'Standard', packages: ['홍콩 패키지'], startMonth: '2026-09' }],
      apps: [{ country: '홍콩', university: 'HKU', deadline: '2026-11-26', status: '준비중' }],
      scores: [{ kind: 'SAT', score: '1400', detail: 'RW 700 · Math 700' }],
      notes: [{ date: '2026-09-19', type: '기타', content: '기존 트래커 요약' }] },
    { name: '김학생' }, // 이미 있음
  ] };
  assert.strictEqual((await staff.rpc('importData', data)).status, 403);
  assert.strictEqual((await admin.rpc('importData', { students: [] })).status, 400);
  const d = await admin.ok('importData', data);
  assert.deepStrictEqual(d.importResult, { created: ['가져온학생'], skipped: ['김학생'] });
  const s = d.students.find((x) => x.name === '가져온학생');
  assert.strictEqual(s.counselor, 'lee@revera.test', '이름으로 담당자 연결');
  assert.strictEqual(s.tracks, '3년특례, 홍콩');
  assert.strictEqual(d.contracts.find((c) => c.studentId === s.id).currency, 'RMB');
  assert.strictEqual(d.apps.find((a) => a.studentId === s.id).country, '홍콩');
  assert.strictEqual(d.notes.filter((n) => n.studentId === s.id).length, 1);
  // 다시 가져오면 모두 건너뜀
  assert.deepStrictEqual((await admin.ok('importData', data)).importResult.created, []);
  // 잘못된 링크가 있으면 전체 취소
  const bad = { format: 'compass-import-v1', students: [{ name: '정상' }, { name: '나쁜링크', resumeUrl: 'javascript:x' }] };
  assert.strictEqual((await admin.rpc('importData', bad)).status, 400);
  assert.ok(!(await admin.ok('getAll')).students.some((x) => x.name === '정상'));
});

test('백업 ZIP에 DB와 업로드 파일이 모두 들어감', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  const r = await admin.req('GET', '/api/backup');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /compass-backup-\d+\.zip/);
  const zipPath = path.join(dir, 'b.zip');
  fs.writeFileSync(zipPath, r.data);
  const { execFileSync } = require('child_process');
  const out = execFileSync('python3', ['-I', '-c', `
import zipfile,sys,sqlite3,tempfile,os
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
names=z.namelist(); print('\\n'.join(names))
p=os.path.join(tempfile.mkdtemp(),'c.db'); open(p,'wb').write(z.read('compass.db'))
print('STUDENTS', sqlite3.connect(p).execute('select count(*) from students').fetchone()[0])
print('CSV', z.read('파일목록.csv').decode('utf-8-sig').splitlines()[0])
`, zipPath]).toString();
  assert.ok(out.includes('compass.db') && out.includes('복구방법.txt'));
  const stored = store.db.prepare("SELECT storedName FROM files WHERE deletedAt = '' LIMIT 1").get().storedName;
  assert.ok(out.includes('files/' + stored), out);
  assert.match(out, /STUDENTS [1-9]/);
  assert.match(out, /CSV "저장 이름","학생"/);
  assert.strictEqual((await (async () => { const c = client(); await c.login('staff@revera.test', 'mine-pass-1'); return c.req('GET', '/api/backup'); })()).status, 403);
});

test('v2 DB(납부 완료 표시)를 v3로 업그레이드하면 입금 기록이 한 번만 생성됨', () => {
  const p2 = path.join(dir, 'v2.db');
  const { openStore: openV2 } = require('./fixtures/store-v2');
  const v2 = openV2(p2, { filesDir: path.join(dir, 'v2files') });
  v2.upsertAdmin('boss@revera.test', '원장', 'boss-pass-1');
  const boss = { email: 'boss@revera.test', name: '원장', role: 'admin' };
  let d = v2.rpc.save(boss, { table: 'students', obj: { name: '옛계약학생', parentName: '엄마', parentPhone: '010' } });
  const sid = d.savedId;
  v2.rpc.save(boss, { table: 'contracts', obj: { studentId: sid, kind: '원서', amount: '30,000', paid: '납부 완료', signedDate: '2026-09-01' } });
  v2.rpc.save(boss, { table: 'contracts', obj: { studentId: sid, kind: '연간', amount: '10000', paid: '미납' } });
  v2.close();

  let v3 = openStore(p2, { filesDir: path.join(dir, 'v2files') });
  d = v3.rpc.getAll(boss);
  assert.strictEqual(d.payments.length, 1);
  assert.strictEqual(d.payments[0].amount, '30000');
  assert.strictEqual(d.payments[0].date, '2026-09-01');
  assert.strictEqual(d.payments[0].currency, 'RMB');
  assert.ok(d.contracts.every((c) => c.currency === 'RMB'));
  assert.strictEqual(d.students[0].parentName, '엄마', '기존 학부모 정보 유지');
  // 자동 생성된 입금을 지워도 다시 열 때 또 생기지 않음
  v3.rpc.remove(boss, { table: 'payments', id: d.payments[0].id });
  v3.close();
  v3 = openStore(p2, { filesDir: path.join(dir, 'v2files') });
  assert.strictEqual(v3.rpc.getAll(boss).payments.length, 0);
  v3.close();
});

test('대학 정보: 초기 자료, 권한, 전형 마감일 자동 반영', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  const staff = client();
  await staff.login('staff@revera.test', 'mine-pass-1');
  const lee = client();
  await lee.login('lee@revera.test', 'mine-pass-1');

  let d = await lee.ok('getAll');
  const names = d.universities.map((u) => u.name);
  for (const n of ['HKU', 'HKUST', 'CUHK', 'CityU', 'PolyU', 'NUS', 'NTU', 'SUTD', 'SMU', 'McGill', 'UBC', 'University of Toronto', '서울대', 'KAIST']) {
    assert.ok(names.includes(n), n + ' 없음');
  }
  const hku = d.universities.find((u) => u.name === 'HKU');
  const cyc = d.unicycles.find((c) => c.universityId === hku.id && c.year === '2027');
  assert.strictEqual(cyc.status, '확인 필요');
  assert.ok(JSON.parse(cyc.requirements).some((r) => r.item === 'Personal Statement'));
  const early = d.unirounds.find((r) => r.cycleId === cyc.id && r.deadline === '2026-11-25');
  assert.ok(early);

  // 대학 추가·삭제·이름 변경은 관리자만
  assert.strictEqual((await lee.save('universities', { name: 'Test U', country: '기타' })).status, 403);
  assert.strictEqual((await staff.save('universities', { name: 'Test U', country: '기타' })).status, 403);
  assert.strictEqual((await lee.rpc('remove', { table: 'universities', id: hku.id })).status, 403);
  d = await lee.saveOk('universities', { id: hku.id, updatedAt: hku.updatedAt, name: '바뀐이름', website: 'https://x.hku.hk', tips: '컨설턴트 메모' });
  const hku2 = d.universities.find((u) => u.id === hku.id);
  assert.strictEqual(hku2.name, 'HKU', '컨설턴트는 이름 변경 불가');
  assert.strictEqual(hku2.tips, '컨설턴트 메모');
  assert.strictEqual((await lee.save('universities', { id: hku.id, website: 'javascript:x' })).status, 400);

  // 컨설턴트도 연도 정보·전형·전공 수정 가능
  d = await lee.saveOk('unicycles', { id: cyc.id, updatedAt: cyc.updatedAt, requirements: JSON.stringify([{ item: 'Essay', content: '영어 500 words' }]), status: '확인 완료' });
  const cyc2 = d.unicycles.find((c) => c.id === cyc.id);
  assert.strictEqual(cyc2.verifiedBy, 'lee@revera.test');
  assert.ok(cyc2.verifiedAt);
  assert.strictEqual((await lee.save('unicycles', { id: cyc.id, requirements: '{bad' })).status, 400);
  assert.strictEqual((await lee.save('unicycles', { universityId: hku.id, year: '2027', term: '9월' })).status, 400, '같은 연도 중복');
  d = await lee.saveOk('unimajors', { universityId: hku.id, name: 'Computer Science', detail: '수학 필수' });
  const major = d.unimajors.find((m) => m.id === d.savedId);

  // 학생 지원대학을 대학·전형에 연결하면 마감일 자동
  const sid = d.students[0].id;
  d = await lee.saveOk('apps', { studentId: sid, universityId: hku.id, roundId: early.id, majorId: major.id, university: '무시됨', deadline: '2000-01-01' });
  let app = d.apps.find((a) => a.id === d.savedId);
  assert.strictEqual(app.university, 'HKU');
  assert.strictEqual(app.country, '홍콩');
  assert.strictEqual(app.deadline, '2026-11-25');
  assert.strictEqual(app.round, '1차 라운드 (Early)');
  assert.strictEqual(app.major, 'Computer Science');
  // 직접 지정한 학생
  d = await lee.saveOk('apps', { studentId: sid, universityId: hku.id, roundId: early.id, deadlineManual: true, deadline: '2026-11-20' });
  const manual = d.apps.find((a) => a.id === d.savedId);
  assert.strictEqual(manual.deadline, '2026-11-20');
  // 대학 정보에서 마감일을 고치면 연결된 학생에게 반영 (직접 지정은 그대로)
  const r = d.unirounds.find((x) => x.id === early.id);
  d = await lee.saveOk('unirounds', { id: r.id, updatedAt: r.updatedAt, deadline: '2026-11-26' });
  assert.strictEqual(d.apps.find((a) => a.id === app.id).deadline, '2026-11-26');
  assert.strictEqual(d.apps.find((a) => a.id === manual.id).deadline, '2026-11-20');
  // 다른 대학의 전형은 연결 불가 → 무시
  const cuhkRound = d.unirounds.find((x) => x.universityId === d.universities.find((u) => u.name === 'CUHK').id);
  d = await lee.saveOk('apps', { id: app.id, roundId: cuhkRound.id });
  assert.strictEqual(d.apps.find((a) => a.id === app.id).roundId, '');
  // 이름만 입력해도 목록과 같으면 자동 연결
  d = await lee.saveOk('apps', { studentId: sid, university: 'hong kong polytechnic university' });
  app = d.apps.find((a) => a.id === d.savedId);
  assert.strictEqual(app.university, 'PolyU');
  assert.ok(app.universityId);

  // 연도 복사: 요건 복사 + 마감일 1년 뒤 추정
  d = await lee.ok('copyCycle', { cycleId: cyc.id });
  const c28 = d.unicycles.find((c) => c.id === d.savedId);
  assert.strictEqual(c28.year, '2028');
  assert.strictEqual(c28.status, '확인 필요');
  assert.ok(d.unirounds.some((x) => x.cycleId === c28.id && x.deadline === '2027-11-26'));

  // 전형 삭제 → 휴지통 → 영구 삭제 시 학생 연결 해제
  await lee.ok('remove', { table: 'unirounds', id: early.id });
  const t = await staff.ok('getTrash');
  assert.ok(t.items.some((i) => i.id === early.id && i.label === '전형·마감'));
  await admin.ok('purge', { table: 'unirounds', id: early.id });
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM apps WHERE roundId = ?').get(early.id).n, 0);

  // 관리자는 대학 추가 가능 + 같은 이름 지원대학 자동 연결
  // 새 지원대학은 목록에 있는 대학만 (예전 자료·가져오기는 이름 그대로 두었다가 대학 추가 시 연결)
  assert.match((await staff.save('apps', { studentId: sid, university: 'Waseda' })).data.error, /목록에서 선택/);
  await admin.ok('importData', { format: 'compass-import-v1', students: [{ name: '와세다지망생', apps: [{ university: 'Waseda' }] }] });
  d = await admin.saveOk('universities', { name: '와세다', country: '일본', aliases: 'Waseda, Waseda University' });
  assert.ok(d.apps.some((a) => a.university === '와세다' && a.universityId === d.savedId));
  const log = (await admin.ok('getLog')).rows;
  assert.ok(log.some((x) => x.tblLabel === '대학' && x.summary.includes('자동 연결')));
  assert.ok(log.some((x) => x.tblLabel === '전형·마감' && x.summary.includes('마감일 자동 반영')));
});

test('v3 DB 업그레이드 시 대학 초기 자료가 들어가고 기존 지원대학이 연결됨', () => {
  const p3 = path.join(dir, 'v3.db');
  const { openStore: openV3 } = require('./fixtures/store-v3');
  const v3 = openV3(p3, { filesDir: path.join(dir, 'v3files') });
  v3.upsertAdmin('boss@revera.test', '원장', 'boss-pass-1');
  const boss = { email: 'boss@revera.test', name: '원장', role: 'admin' };
  const sid = v3.rpc.save(boss, { table: 'students', obj: { name: '옛지원학생' } }).savedId;
  v3.rpc.save(boss, { table: 'apps', obj: { studentId: sid, country: '홍콩', university: 'HKU', deadline: '2026-11-26' } });
  v3.rpc.save(boss, { table: 'apps', obj: { studentId: sid, university: '모르는대학' } });
  v3.close();
  const v4 = openStore(p3, { filesDir: path.join(dir, 'v3files') });
  const d = v4.rpc.getAll(boss);
  assert.strictEqual(d.universities.length, 14);
  const hku = d.apps.find((a) => a.university === 'HKU');
  assert.strictEqual(hku.universityId, d.universities.find((u) => u.name === 'HKU').id);
  assert.strictEqual(hku.deadline, '2026-11-26', '연결만 하고 기존 마감일은 그대로');
  assert.strictEqual(d.apps.find((a) => a.university === '모르는대학').universityId, '');
  v4.close();
  // 다시 열어도 중복 생성 없음
  const again = openStore(p3, { filesDir: path.join(dir, 'v3files') });
  assert.strictEqual(again.rpc.getAll(boss).universities.length, 14);
  again.close();
});

test('v2: 비밀번호 6자·첫 로그인 변경 없음, 담당 관리팀, 팔로업, 학생별 최근 활동', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  assert.strictEqual((await admin.rpc('saveTeacher', { email: 'short@revera.test', name: 's', role: 'staff', password: '12345' })).status, 400);
  await admin.ok('saveTeacher', { email: 'mgr6@revera.test', name: '관리', role: 'staff', password: '123456' });
  await admin.ok('saveTeacher', { email: 'con6@revera.test', name: '컨설', role: 'consultant', password: '123456' });
  const mgr = client(); assert.strictEqual((await mgr.login('mgr6@revera.test', '123456')).status, 200);
  const con = client(); await con.login('con6@revera.test', '123456');
  let d = await mgr.ok('getAll');
  assert.strictEqual(d.me.mustChangePassword, false, '첫 로그인 비밀번호 변경 강제 없음');

  // 담당 관리팀 + 컨설턴트(미정 가능)
  assert.strictEqual((await mgr.save('students', { name: 'x', manager: 'nobody@revera.test' })).status, 400);
  d = await mgr.saveOk('students', { name: '팔로업학생', manager: 'MGR6@revera.test', counselor: '', progress: '에세이 초안 작업 중' });
  const sid = d.savedId;
  let s = d.students.find((x) => x.id === sid);
  assert.strictEqual(s.manager, 'mgr6@revera.test');
  assert.strictEqual(s.counselor, '');
  d = await mgr.saveOk('students', { id: sid, updatedAt: s.updatedAt, counselor: 'con6@revera.test' });
  s = d.students.find((x) => x.id === sid);

  // 팔로업
  assert.strictEqual((await mgr.save('followups', { studentId: sid })).status, 400);
  assert.strictEqual((await mgr.save('followups', { studentId: sid, title: 'x', status: '이상함' })).status, 400);
  assert.strictEqual((await mgr.save('followups', { studentId: sid, title: 'x', due: '10/20' })).status, 400);
  d = await mgr.saveOk('followups', { studentId: sid, title: '재학증명서 받기', assignee: 'CON6@revera.test', due: '2026-10-20' });
  let f = d.followups.find((x) => x.id === d.savedId);
  assert.strictEqual(f.status, '할 일');
  assert.strictEqual(f.assignee, 'con6@revera.test');
  await mgr.saveOk('notes', { studentId: sid, content: '어머님 비밀 상담' });

  // 컨설턴트도 담당 학생 팔로업 완료 처리 가능, 담당자 변경은 불가
  d = await con.ok('getAll');
  f = d.followups.find((x) => x.id === f.id);
  d = await con.saveOk('followups', { id: f.id, updatedAt: f.updatedAt, status: '완료' });
  f = d.followups.find((x) => x.id === f.id);
  assert.strictEqual(f.doneBy, 'con6@revera.test');
  assert.ok(f.doneAt);
  s = d.students.find((x) => x.id === sid);
  d = await con.saveOk('students', { id: sid, updatedAt: s.updatedAt, manager: 'admin@revera.test', progress: '최종 제출 준비' });
  s = d.students.find((x) => x.id === sid);
  assert.strictEqual(s.manager, 'mgr6@revera.test', '컨설턴트는 담당 관리팀 변경 불가');
  assert.strictEqual(s.progress, '최종 제출 준비');
  d = await con.saveOk('followups', { id: f.id, updatedAt: f.updatedAt, status: '진행 중' });
  f = d.followups.find((x) => x.id === f.id);
  assert.strictEqual(f.doneAt, '');

  // 최근 활동: 관리팀은 상담기록 포함, 컨설턴트는 제외
  const all = (await mgr.ok('getActivity', { studentId: sid })).rows;
  assert.ok(all.some((r) => r.tbl === 'followups' && r.tblLabel === '팔로업'));
  assert.ok(all.some((r) => r.tbl === 'notes'));
  const mine = (await con.ok('getActivity', { studentId: sid })).rows;
  assert.ok(mine.some((r) => r.tbl === 'followups'));
  assert.ok(!mine.some((r) => r.tbl === 'notes'));
  const other = await mgr.saveOk('students', { name: '다른학생' });
  assert.strictEqual((await con.rpc('getActivity', { studentId: other.savedId })).status, 403);
});

test('v4 DB 업그레이드: 비밀번호 변경 강제 해제 + 기존 데이터 유지', () => {
  const p4 = path.join(dir, 'v4.db');
  const { openStore: openV4 } = require('./fixtures/store-v4');
  const v4 = openV4(p4, { filesDir: path.join(dir, 'v4files') });
  v4.upsertAdmin('boss4@revera.test', '원장', 'boss-pass-1');
  const boss = { email: 'boss4@revera.test', name: '원장', role: 'admin' };
  v4.rpc.saveTeacher(boss, { email: 'new4@revera.test', name: '신입', role: 'staff', password: 'temp-pass-1' });
  const sid = v4.rpc.save(boss, { table: 'students', obj: { name: '옛학생', fatherWechat: 'wx1' } }).savedId;
  v4.close();
  const v5 = openStore(p4, { filesDir: path.join(dir, 'v4files') });
  assert.strictEqual(v5.db.prepare("SELECT mustChangePassword m FROM teachers WHERE email='new4@revera.test'").get().m, 0);
  const d = v5.rpc.getAll(boss);
  const s = d.students.find((x) => x.id === sid);
  assert.strictEqual(s.fatherWechat, 'wx1', '숨긴 칸의 기존 값은 지우지 않음');
  assert.deepStrictEqual(d.followups, []);
  v5.rpc.save(boss, { table: 'followups', obj: { studentId: sid, title: '확인' } });
  assert.ok(v5.rpc.getActivity(boss, { studentId: sid }).rows.length >= 1);
  v5.close();
});

test('v3: 전공 선정·부모님 확정, 학력, 학년별 수강 과목 일괄 저장, 내 이름 변경', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  await admin.ok('saveTeacher', { email: 'con7@revera.test', name: '컨설7', role: 'consultant', password: '123456' });
  const con = client(); await con.login('con7@revera.test', '123456');
  let d = await admin.saveOk('students', { name: '전공학생', counselor: 'con7@revera.test' });
  const sid = d.savedId;
  const other = (await admin.saveOk('students', { name: '남의학생' })).savedId;

  // 전공 후보 → 최종 + 부모님 확정 (시각·기록자 자동)
  assert.strictEqual((await con.save('majorplans', { studentId: sid, major: 'x', status: '이상' })).status, 400);
  d = await con.saveOk('majorplans', { studentId: sid, major: 'Psychology' });
  let m = d.majorplans.find((x) => x.id === d.savedId);
  assert.strictEqual(m.status, '후보');
  assert.match(m.date, /^\d{4}-\d{2}-\d{2}$/);
  d = await con.saveOk('majorplans', { id: m.id, updatedAt: m.updatedAt, status: '최종', parentConfirmed: true });
  m = d.majorplans.find((x) => x.id === m.id);
  assert.strictEqual(m.parentConfirmed, 'TRUE');
  assert.strictEqual(m.parentConfirmedBy, 'con7@revera.test');
  d = await con.saveOk('majorplans', { id: m.id, updatedAt: m.updatedAt, parentConfirmed: false });
  m = d.majorplans.find((x) => x.id === m.id);
  assert.strictEqual(m.parentConfirmedAt, '');
  const act = (await con.ok('getActivity', { studentId: sid })).rows;
  assert.ok(act.some((r) => r.tbl === 'majorplans' && r.summary.includes('부모님 확정')));

  // 학력: 날짜 검증
  assert.strictEqual((await con.save('schools', { studentId: sid, school: 'A' })).status, 400);
  assert.strictEqual((await con.save('schools', { studentId: sid, school: 'A', startDate: '2020-03-01', endDate: '2019-01-01' })).status, 400);
  await con.saveOk('schools', { studentId: sid, school: 'A초', country: '한국', gradeFrom: 'G1', gradeTo: 'G6', startDate: '2014-03-03', endDate: '2020-02-14' });

  // 과목 일괄 저장: 전부 성공 또는 전부 취소, 남의 학생 불가
  assert.strictEqual((await con.rpc('saveMany', { table: 'courses', objs: [{ studentId: sid, grade: 'G10', subject: 'Math' }, { studentId: sid, grade: 'G10' }] })).status, 400);
  assert.strictEqual((await con.ok('getAll')).courses.length, 0, '하나라도 틀리면 아무것도 저장 안 됨');
  assert.strictEqual((await con.rpc('saveMany', { table: 'courses', objs: [{ studentId: other, grade: 'G10', subject: 'Math' }] })).status, 403);
  assert.strictEqual((await con.rpc('saveMany', { table: 'notes', objs: [{ studentId: sid, content: 'x' }] })).status, 400);
  d = await con.ok('saveMany', { table: 'courses', objs: [
    { studentId: sid, grade: 'G10', subject: 'AP Biology', level: 'AP' },
    { studentId: sid, grade: 'G10', subject: 'Statistics', termType: 'Trimester' }] });
  assert.strictEqual(d.savedIds.length, 2);
  const bio = d.courses.find((c) => c.subject === 'AP Biology');
  assert.strictEqual(bio.termType, '1년(2학기)');
  assert.strictEqual((await con.rpc('saveMany', { table: 'courses', objs: [{ id: bio.id, updatedAt: bio.updatedAt, termType: '분기' }] })).status, 400);
  d = await con.ok('saveMany', { table: 'courses', objs: [{ id: bio.id, updatedAt: bio.updatedAt, g1: 'A', g2: 'A-', final: 'A' }] });
  assert.strictEqual(d.courses.find((c) => c.id === bio.id).final, 'A');

  // 내 이름 변경
  d = await con.ok('updateMe', { name: '새이름' });
  assert.strictEqual(d.me.name, '새이름');
  assert.strictEqual((await con.rpc('updateMe', { name: ' ' })).status, 400);
});
