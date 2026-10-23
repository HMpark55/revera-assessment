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
// Apps Script 대신 받는 가짜 응답 (자동 백업·메일 테스트용)
const scriptCalls = [];
let sheetTabs = {}; // 원장님 스케줄 시트 (테스트에서 채움)
async function fakeFetch(url, init) {
  const body = JSON.parse(init.body);
  scriptCalls.push(body);
  const out = body.secret !== store.getConfig().secret ? { ok: false, error: 'secret' }
    : body.action === 'mail' ? { ok: true, sent: body.messages.length, remaining: 99 }
    : body.action === 'sheet' ? { ok: true, names: Object.keys(sheetTabs), tabs: Object.fromEntries((body.tabs || []).map((t) => [t, sheetTabs[t] || null])) }
    : { ok: true, url: 'https://drive.google.com/x' };
  return { status: 200, text: async () => JSON.stringify(out) };
}

before(async () => {
  store = openStore(path.join(dir, 'test.db'));
  store.upsertAdmin('Admin@Revera.test', '박원장', 'admin-pass-1');
  server = createApp(store, { fetch: (url, init) => fakeFetch(url, init) }).listen(0);
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
  assert.ok(!/[":]30000[",}]/.test(JSON.stringify(d)) && !JSON.stringify(d).includes('민감한')); // 따옴표까지 — 무작위 ID 안의 30000 과 헷갈리지 않게
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
  assert.ok(f && f.category === '성적증명서' && f.size === String(pdf.length));
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
  assert.ok(f && f.category === '지원자격증빙(출입국·여권 등)' && f.name === '출입국.pdf');
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
  assert.deepStrictEqual(d.importResult, { created: ['가져온학생'], skipped: ['김학생'], appended: [], duplicates: 0 });
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
  assert.deepStrictEqual(JSON.parse(cyc.requirements), [], '처음 자료의 지원 요건은 비어 있음 (선생님이 채움)');
  assert.ok(!/확인 완료/.test(cyc.memo), '확인 안내 문구 없음');
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

test('v4: 학교·커리큘럼 목록, 팔로업 답변, 전공 후보 대학, 사이트 계정', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  await admin.ok('saveTeacher', { email: 'staff8@revera.test', name: '관리8', role: 'staff', password: '123456' });
  await admin.ok('saveTeacher', { email: 'con8@revera.test', name: '컨설8', role: 'consultant', password: '123456' });
  const staff = client(); await staff.login('staff8@revera.test', '123456');
  const con = client(); await con.login('con8@revera.test', '123456');

  // 목록: 기본 커리큘럼이 들어 있고, 관리팀이 추가·이름 변경(학생 정보도 함께)·삭제, 컨설턴트는 불가
  let d = await staff.ok('getAll');
  assert.ok(d.options.some((o) => o.kind === 'curriculum' && o.value === 'IB'));
  d = await staff.ok('saveOption', { kind: 'school', value: 'SMIC' });
  const smic = d.savedId;
  assert.strictEqual((await staff.rpc('saveOption', { kind: 'school', value: 'SMIC' })).status, 400);
  assert.strictEqual((await con.rpc('saveOption', { kind: 'school', value: 'X' })).status, 403);
  assert.strictEqual((await staff.rpc('saveOption', { kind: 'bogus', value: 'X' })).status, 400);
  d = await staff.saveOk('students', { name: '목록학생', school: 'SMIC', counselor: 'con8@revera.test' });
  const sid = d.savedId;
  d = await staff.ok('saveOption', { id: smic, kind: 'school', value: 'Shanghai Livingston American School' });
  assert.strictEqual(d.students.find((s) => s.id === sid).school, 'Shanghai Livingston American School');
  d = await staff.ok('removeOption', { id: smic });
  assert.ok(!d.options.some((o) => o.id === smic));
  assert.strictEqual(d.students.find((s) => s.id === sid).school, 'Shanghai Livingston American School', '삭제해도 학생 값은 유지');

  // 팔로업 답변
  d = await staff.saveOk('followups', { studentId: sid, title: '시험 일정 확인' });
  let f = d.followups.find((x) => x.id === d.savedId);
  assert.strictEqual((await con.save('followups', { id: f.id, updatedAt: f.updatedAt, replyDate: '4/4' })).status, 400);
  d = await con.saveOk('followups', { id: f.id, updatedAt: f.updatedAt, replyFrom: '학생', replyDate: '2026-10-16', reply: '퀴즈는 다음 주로 미뤄졌어요' });
  f = d.followups.find((x) => x.id === f.id);
  assert.strictEqual(f.reply, '퀴즈는 다음 주로 미뤄졌어요');

  // 전공 후보에 대학 (이름 자동), 없는 대학은 거부
  const hku = d.universities.find((u) => u.name === 'HKU');
  d = await con.saveOk('majorplans', { studentId: sid, universityId: hku.id, major: 'Psychology', university: '무시됨' });
  assert.strictEqual(d.majorplans.find((m) => m.id === d.savedId).university, 'HKU');
  assert.strictEqual((await con.save('majorplans', { studentId: sid, universityId: 'nope', major: 'x' })).status, 400);

  // 계정: 비밀번호는 그대로 보임 (열람 기록 없음), 비우면 비워짐
  d = await con.saveOk('accounts', { studentId: sid, category: '원서 포털', site: 'HKU 포털', universityId: hku.id, loginId: 'kid01', password: 'S3cret!pw' });
  let acc = d.accounts.find((a) => a.id === d.savedId);
  assert.strictEqual(acc.password, 'S3cret!pw');
  d = await con.saveOk('accounts', { id: acc.id, updatedAt: acc.updatedAt, password: '', memo: '등록 완료' });
  assert.strictEqual(d.accounts.find((a) => a.id === acc.id).password, '');
  // 담당이 아닌 컨설턴트는 볼 수 없음
  await admin.ok('saveTeacher', { email: 'con9@revera.test', name: '컨설9', role: 'consultant', password: '123456' });
  const other = client(); await other.login('con9@revera.test', '123456');
  assert.ok(!(await other.ok('getAll')).accounts.some((a) => a.id === acc.id));
  assert.strictEqual((await con.save('accounts', { studentId: sid, site: 'x', url: 'javascript:alert(1)' })).status, 400);
  // 관리 사항 칸
  d = await con.saveOk('students', { id: sid, updatedAt: d.students.find((s) => s.id === sid).updatedAt, hopeUnis: 'NUS 1순위', meetingUrl: 'https://docs.google.com/x' });
  assert.strictEqual(d.students.find((s) => s.id === sid).hopeUnis, 'NUS 1순위');
});

test('v5: 미팅, 기존 학생에 회의록 덧붙여 가져오기(확인 필요·중복 방지), 계정 삭제', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  await admin.ok('saveTeacher', { email: 'con10@revera.test', name: '컨설10', role: 'consultant', password: '123456' });
  const con = client(); await con.login('con10@revera.test', '123456');
  let d = await admin.saveOk('students', { name: '미팅학생', counselor: 'con10@revera.test', manager: 'admin@revera.test' });
  const sid = d.savedId;

  // 미팅: 날짜 필수, 지난 날짜는 자동 "완료", 앞으로는 "예정"
  assert.strictEqual((await con.save('meetings', { studentId: sid, topic: 'x' })).status, 400);
  assert.strictEqual((await con.save('meetings', { studentId: sid, date: '2026-01-01', status: '몰라' })).status, 400);
  d = await con.saveOk('meetings', { studentId: sid, date: '2020-01-01', topic: '첫 미팅', content: '내용' });
  assert.strictEqual(d.meetings.find((m) => m.id === d.savedId).status, '완료');
  d = await con.saveOk('meetings', { studentId: sid, date: '2099-01-01', topic: '다음 미팅' });
  assert.strictEqual(d.meetings.find((m) => m.id === d.savedId).status, '예정');

  // 가져오기(덧붙이기): 기존 학생에 회의록 추가 + 확인 필요 표시, 두 번 가져와도 중복 없음
  const file = { format: 'compass-import-v1', mode: 'append', students: [{ name: '미팅학생', meetings: [
    { date: '2026-10-11', time: 'PM 1:00', place: '상담실', attendees: '원장님, 학생', writer: '박현모', content: '1. Resume 정리', sourceUrl: 'https://docs.google.com/spreadsheets/d/abc' },
    { date: '2026-10-10', time: 'PM 5:30', content: '2. 대학 방향', sourceUrl: 'https://docs.google.com/spreadsheets/d/abc' }] }] };
  d = await admin.ok('importData', file);
  assert.deepStrictEqual(d.importResult.appended, ['미팅학생 (2건)']);
  const imp = d.meetings.filter((m) => m.studentId === sid && m.sourceUrl);
  assert.strictEqual(imp.length, 2);
  assert.ok(imp.every((m) => m.needsReview === 'TRUE' && m.status === '완료'));
  d = await admin.ok('importData', file);
  assert.strictEqual(d.importResult.duplicates, 2);
  assert.strictEqual(d.meetings.filter((m) => m.studentId === sid && m.sourceUrl).length, 2);
  // 컨설턴트도 담당 학생 회의록을 보고 확인 완료 처리
  d = await con.ok('getAll');
  const m0 = d.meetings.find((m) => m.sourceUrl && m.date === '2026-10-11');
  assert.strictEqual(m0.content, '1. Resume 정리');
  d = await con.saveOk('meetings', { id: m0.id, updatedAt: m0.updatedAt, needsReview: false });
  assert.notStrictEqual(d.meetings.find((m) => m.id === m0.id).needsReview, 'TRUE');

  // 계정 삭제: 관리자만, 본인 불가, 담당은 미정으로
  assert.strictEqual((await con.rpc('deleteTeacher', { email: 'con10@revera.test' })).status, 403);
  assert.strictEqual((await admin.rpc('deleteTeacher', { email: 'admin@revera.test' })).status, 400);
  d = await admin.ok('deleteTeacher', { email: 'con10@revera.test' });
  assert.ok(!d.teachers.some((t) => t.email === 'con10@revera.test'));
  assert.strictEqual(d.students.find((s) => s.id === sid).counselor, '');
  assert.strictEqual((await con.rpc('getAll')).status, 401, '삭제된 계정은 바로 로그아웃');
});

test('v5-2: 미팅의 부모님 내용은 컨설턴트에게 숨김, 미팅 첨부파일, 가져오기 시 첨부 이미지·팔로업', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  await admin.ok('saveTeacher', { email: 'con11@revera.test', name: '컨설11', role: 'consultant', password: '123456' });
  const con = client(); await con.login('con11@revera.test', '123456');
  let d = await admin.saveOk('students', { name: '첨부학생', counselor: 'con11@revera.test' });
  const sid = d.savedId;
  d = await admin.saveOk('meetings', { studentId: sid, date: '2026-10-01', content: '공개 내용', parentNote: '어머님 비공개 대화' });
  const mid = d.savedId;
  d = await con.ok('getAll');
  let m = d.meetings.find((x) => x.id === mid);
  assert.strictEqual(m.content, '공개 내용');
  assert.ok(!('parentNote' in m));
  assert.ok(!JSON.stringify(d).includes('어머님 비공개'));
  // 컨설턴트는 부모님 칸을 덮어쓰거나 새로 쓸 수 없음
  await con.saveOk('meetings', { id: mid, updatedAt: m.updatedAt, parentNote: '덮어쓰기', topic: '안건' });
  d = await con.saveOk('meetings', { studentId: sid, date: '2026-10-02', parentNote: '몰래' });
  const mine = d.savedId;
  d = await admin.ok('getAll');
  assert.strictEqual(d.meetings.find((x) => x.id === mid).parentNote, '어머님 비공개 대화');
  assert.strictEqual(d.meetings.find((x) => x.id === mine).parentNote, '');

  // 미팅 첨부파일: 담당 컨설턴트가 올림, 성적표 파일 목록과 구분
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  let r = await con.req('POST', '/api/files/upload?studentId=' + sid + '&meetingId=' + mid, undefined,
    { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('화이트보드.png') }, png);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const f = r.data.files.find((x) => x.meetingId === mid);
  assert.strictEqual(f.category, '미팅');
  r = await con.req('POST', '/api/files/upload?studentId=' + sid + '&meetingId=nope', undefined,
    { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'a.png' }, png);
  assert.strictEqual(r.status, 404);

  // 가져오기: 미팅 + 첨부 이미지(base64) + 팔로업
  d = await admin.ok('importData', { format: 'compass-import-v1', mode: 'append', students: [{ name: '첨부학생',
    meetings: [{ date: '2026-09-01', content: '회의록', parentNote: '부모님 전달 사항', sourceUrl: 'https://docs.google.com/x',
      files: [{ name: '회의록 이미지 1.png', data: png.toString('base64') }] }],
    followups: [{ title: '[09-01 미팅] 확인중인 사항', detail: 'SAT 접수 확인' }] }] });
  assert.strictEqual(d.importResult.files, 1);
  const im = d.meetings.find((x) => x.studentId === sid && x.date === '2026-09-01');
  assert.strictEqual(im.parentNote, '부모님 전달 사항');
  assert.ok(d.files.some((x) => x.meetingId === im.id && x.name === '회의록 이미지 1.png'));
  assert.ok(d.followups.some((x) => x.studentId === sid && x.title.includes('확인중인 사항')));
  d = await admin.ok('importData', { format: 'compass-import-v1', mode: 'append', students: [{ name: '첨부학생',
    followups: [{ title: '[09-01 미팅] 확인중인 사항', detail: 'SAT 접수 확인' }] }] });
  assert.strictEqual(d.followups.filter((x) => x.studentId === sid && x.title.includes('확인중인 사항')).length, 1, '팔로업도 중복 없음');
  // 잘못된 파일이 섞이면 전체 취소 (미팅도 안 들어감)
  r = await admin.rpc('importData', { format: 'compass-import-v1', mode: 'append', students: [{ name: '첨부학생',
    meetings: [{ date: '2026-08-01', content: 'x', files: [{ name: 'virus.exe', data: 'AAAA' }] }] }] });
  assert.strictEqual(r.status, 400);
  assert.ok(!(await admin.ok('getAll')).meetings.some((x) => x.date === '2026-08-01'));
});

test('가져오기(덧붙이기): 빈 칸만 채움·메모 이어 붙임·학교 목록 추가·계정 대학 이름 연결·학력/계정 중복 방지', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  let d = await admin.saveOk('students', { name: '채움학생', school: '기존학교', hopeUnis: '' });
  const sid = d.savedId;
  const file = { format: 'compass-import-v1', mode: 'append', students: [
    { name: '채움학생', school: '새학교', curriculum: 'NewCurr', hopeUnis: 'HKU 1순위', appendMemo: '[학생별 관리 사항에서 가져옴] 비고',
      accounts: [{ category: '원서 포털', site: 'HKU 원서 포털', university: 'HKU', loginId: 'kid', password: 'pw1' }],
      schools: [{ school: 'SAS', country: '중국', gradeFrom: 'G2', gradeTo: 'G12', startDate: '2015-08-12', endDate: '2026-06-12' }] },
    { name: '새로온학생', status: '완료', school: 'SLAS', grade: 'G12', appendMemo: '명단에서 가져옴' }] };
  d = await admin.ok('importData', file);
  const s = d.students.find((x) => x.id === sid);
  assert.strictEqual(s.school, '기존학교', '이미 있는 값은 그대로');
  assert.strictEqual(s.hopeUnis, 'HKU 1순위');
  assert.strictEqual(s.curriculum, 'NewCurr');
  assert.ok(s.memo.includes('비고'));
  assert.ok(d.options.some((o) => o.kind === 'curriculum' && o.value === 'NewCurr'));
  assert.ok(d.options.some((o) => o.kind === 'school' && o.value === 'SLAS'));
  const acc = d.accounts.find((a) => a.studentId === sid);
  assert.strictEqual(acc.universityId, d.universities.find((u) => u.name === 'HKU').id);
  assert.strictEqual(d.students.find((x) => x.name === '새로온학생').memo, '명단에서 가져옴');
  d = await admin.ok('importData', file);
  assert.strictEqual(d.accounts.filter((a) => a.studentId === sid).length, 1);
  assert.strictEqual(d.schools.filter((a) => a.studentId === sid).length, 1);
  assert.strictEqual((d.students.find((x) => x.id === sid).memo.match(/비고/g) || []).length, 1, '메모 중복 없음');
  const bad = { format: 'compass-import-v1', mode: 'append', students: [{ name: '채움학생', accounts: [{ site: 'x', university: '없는대학' }] }] };
  assert.strictEqual((await admin.rpc('importData', bad)).status, 400);
});

test('사이트 목록: 기본 사이트, 주소·분류 저장, 이름 바꾸면 계정의 사이트 이름도 변경', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  let d = await admin.ok('getAll');
  const cb = d.options.find((o) => o.kind === 'site' && o.value === 'College Board (SAT·AP)');
  assert.strictEqual(cb.url, 'https://www.collegeboard.org');
  assert.strictEqual((await admin.rpc('saveOption', { kind: 'site', value: 'X', url: 'javascript:alert(1)' })).status, 400);
  assert.strictEqual((await admin.rpc('saveOption', { kind: 'site', value: 'X', category: '아무거나' })).status, 400);
  d = await admin.saveOk('students', { name: '사이트학생' });
  const sid = d.savedId;
  await admin.saveOk('accounts', { studentId: sid, site: 'College Board (SAT·AP)', loginId: 'a' });
  d = await admin.ok('saveOption', { id: cb.id, kind: 'site', value: 'College Board', url: 'https://www.collegeboard.org', category: '시험' });
  assert.strictEqual(d.accounts.find((a) => a.studentId === sid).site, 'College Board');
});

test('자동 백업·이메일 알림: 설정 권한, 백업 전송, 오늘 챙길 일 메일, 하루 한 번 실행, 미팅 시간 길이', async () => {
  const automation = require('../lib/automation');
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  await admin.ok('saveTeacher', { email: 'mail1@revera.test', name: '메일관리', role: 'staff', password: '123456' });
  await admin.ok('saveTeacher', { email: 'mail2@revera.test', name: '알림끔', role: 'staff', password: '123456', notify: false });
  const staff = client(); await staff.login('mail1@revera.test', '123456');
  assert.strictEqual((await staff.rpc('getAutomation')).status, 403);
  assert.strictEqual((await staff.req('POST', '/api/automation/ping', {})).status, 403);
  assert.strictEqual((await admin.rpc('saveAutomation', { scriptUrl: 'https://evil.example.com/x' })).status, 400);
  let d = await admin.ok('saveAutomation', { scriptUrl: 'https://script.google.com/macros/s/AKfy_abc-123/exec', siteUrl: 'https://revera-compass.up.railway.app/',
    backupOn: true, backupHour: 3, mailOn: true, mailHour: 8 });
  assert.ok(d.config.secret.length > 10);
  assert.strictEqual(d.config.siteUrl, 'https://revera-compass.up.railway.app');
  assert.strictEqual((await admin.req('POST', '/api/automation/ping', {})).status, 200);

  // 지금 백업: ZIP(base64)이 Apps Script로 감
  let r = await admin.req('POST', '/api/automation/backup', {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const sent = scriptCalls.filter((c) => c.action === 'backup').pop();
  assert.ok(Buffer.from(sent.data, 'base64').slice(0, 2).toString() === 'PK');
  assert.match((await admin.ok('getAutomation')).status.backup.result, /성공/);

  // 오늘 챙길 일: 기한 지난 팔로업이 있는 사람에게만, 알림 끈 사람 제외
  d = await admin.saveOk('students', { name: '알림학생', manager: 'mail1@revera.test' });
  await admin.saveOk('followups', { studentId: d.savedId, title: '서류 받기', assignee: 'mail1@revera.test', due: '2000-01-01' });
  await admin.saveOk('followups', { studentId: d.savedId, title: '끈 사람 일', assignee: 'mail2@revera.test', due: '2000-01-01' });
  const list = automation.buildDigests(store);
  const m1 = list.find((m) => m.to === 'mail1@revera.test');
  assert.ok(m1 && m1.html.includes('서류 받기') && m1.html.includes('https://revera-compass.up.railway.app/#/student/'));
  assert.ok(!list.some((m) => m.to === 'mail2@revera.test'));
  r = await admin.req('POST', '/api/automation/preview', {});
  assert.ok(r.data.digests.some((m) => m.to === 'mail1@revera.test'));

  // 정해진 시각 이후 하루 한 번만
  const daily = () => scriptCalls.filter((c) => c.action === 'backup' || c.action === 'mail').length;
  const before = daily();
  const at = (h) => new Date(Date.UTC(2030, 0, 5, h - 8, 5));
  const fetch = (u, i) => fakeFetch(u, i);
  await automation.tick(store, { now: at(2), fetch });
  assert.strictEqual(daily(), before, '3시 전에는 백업 안 함');
  await automation.tick(store, { now: at(9), fetch });
  assert.strictEqual(daily(), before + 2, '백업 1번 + 메일 1번');
  await automation.tick(store, { now: at(10), fetch });
  assert.strictEqual(daily(), before + 2, '같은 날 다시 안 보냄');
  // 비밀 키가 틀리면 알기 쉬운 오류
  await admin.ok('saveAutomation', { newSecret: true });
  await assert.rejects(automation.callScript(Object.assign({}, store.getConfig(), { secret: 'wrong' }), { action: 'ping' }, fetch), /비밀 키/);

  // 미팅 시간은 30자 이내
  assert.strictEqual((await admin.save('meetings', { studentId: d.savedId, date: '2026-01-01', time: 'x'.repeat(31) })).status, 400);
});

test('v8 업그레이드: 미팅 시간 칸에 들어간 긴 글은 본문 [추가 메모]로 옮김', () => {
  const p = path.join(dir, 'v8.db');
  let st = openStore(p, { filesDir: path.join(dir, 'v8files') });
  st.upsertAdmin('b8@revera.test', '원장', 'boss-pass-1');
  const boss = { email: 'b8@revera.test', name: '원장', role: 'admin' };
  const sid = st.rpc.save(boss, { table: 'students', obj: { name: '시간학생' } }).savedId;
  const mid = st.rpc.save(boss, { table: 'meetings', obj: { studentId: sid, date: '2026-09-23', content: '본문' } }).savedId;
  st.db.prepare('UPDATE meetings SET time = ? WHERE id = ?').run('긴 메모 '.repeat(20), mid);
  st.db.prepare("DELETE FROM meta WHERE key = 'v8_meeting_time'").run();
  st.close();
  st = openStore(p, { filesDir: path.join(dir, 'v8files') });
  const m = st.rpc.getAll(boss).meetings.find((x) => x.id === mid);
  assert.strictEqual(m.time, '');
  assert.ok(m.content.startsWith('본문') && m.content.includes('[추가 메모') && m.content.includes('긴 메모'));
  st.close();
});

test('공용 달력: 누구나 추가, 수정·삭제는 등록자·관리팀만, 날짜 검사, 변경 기록', async () => {
  const admin = client(); await admin.login('admin@revera.test', 'admin-pass-1');
  const c1 = await newUser(admin, 'cal1@revera.test', 'consultant');
  const c2 = await newUser(admin, 'cal2@revera.test', 'consultant');
  const staff = await newUser(admin, 'calstaff@revera.test', 'staff');
  let d = await c1.ok('saveEvent', { date: '2026-11-07', title: 'SAT 시험', category: '시험', memo: '접수 마감 10/24' });
  const id = d.savedId;
  assert.ok(d.events.some((e) => e.id === id && e.createdBy === 'cal1@revera.test'));
  // 다른 컨설턴트에게도 보임, 하지만 수정·삭제는 불가
  const seen = await c2.ok('getAll');
  const ev = seen.events.find((e) => e.id === id);
  assert.ok(ev);
  assert.strictEqual((await c2.rpc('saveEvent', { id, updatedAt: ev.updatedAt, date: '2026-11-08', title: 'x' })).status, 403);
  assert.strictEqual((await c2.rpc('removeEvent', { id })).status, 403);
  // 잘못된 날짜·기간
  assert.strictEqual((await c1.rpc('saveEvent', { date: '11/07', title: 'x' })).status, 400);
  assert.strictEqual((await c1.rpc('saveEvent', { date: '2026-11-07', endDate: '2026-11-01', title: 'x' })).status, 400);
  assert.strictEqual((await c1.rpc('saveEvent', { date: '2026-11-07', title: '' })).status, 400);
  assert.strictEqual((await c1.rpc('saveEvent', { date: '2026-11-07', title: 'x', category: '없는 분류' })).status, 400);
  // 관리팀은 수정 가능, 동시 수정 충돌 감지
  d = await staff.ok('saveEvent', { id, updatedAt: ev.updatedAt, date: '2026-11-07', endDate: '2026-11-07', title: 'SAT 시험 (11월)', category: '시험' });
  const ev2 = d.events.find((e) => e.id === id);
  assert.strictEqual(ev2.title, 'SAT 시험 (11월)');
  assert.strictEqual(ev2.endDate, '');
  assert.strictEqual((await c1.rpc('saveEvent', { id, updatedAt: ev.updatedAt, date: '2026-11-07', title: '옛 화면에서 저장' })).status, 409);
  // 등록자는 삭제 가능, 변경 기록에 남음
  await c1.ok('removeEvent', { id });
  assert.ok(!(await c1.ok('getAll')).events.some((e) => e.id === id));
  const log = await admin.ok('getLog', {});
  assert.ok(log.rows.some((r) => r.tbl === 'events' && r.action === 'delete' && r.tblLabel === '달력 일정' && /SAT 시험 \(11월\)/.test(r.summary)));
});

test('v7: 계약 날짜, 회의록·상담기록의 팔로업, 팔로업 요청(메일), 목록 순서, 대학 자료 파일', async () => {
  const admin = client(); await admin.login('admin@revera.test', 'admin-pass-1');
  const staff = await newUser(admin, 'v7staff@revera.test', 'staff');
  const kim = await newUser(admin, 'v7kim@revera.test', 'consultant');
  const lee = await newUser(admin, 'v7lee@revera.test', 'consultant');
  let d = await admin.saveOk('students', { name: 'v7학생', counselor: 'v7kim@revera.test', manager: 'v7staff@revera.test' });
  const sid = d.savedId;

  // 계약: 날짜로 저장하면 연월도 맞춰짐, 연월만 오면 날짜로 채움, 종료일이 빠르면 거부
  d = await admin.saveOk('contracts', { studentId: sid, kind: '연간', term: '1년', startDate: '2026-03-15' });
  let c = d.contracts.find((x) => x.id === d.savedId);
  assert.strictEqual(c.startMonth, '2026-03');
  d = await admin.saveOk('contracts', { studentId: sid, kind: '원서', startMonth: '2026-05', endMonth: '2027-02' });
  c = d.contracts.find((x) => x.id === d.savedId);
  assert.deepStrictEqual([c.startDate, c.endDate], ['2026-05-01', '2027-02-28']);
  assert.strictEqual((await admin.save('contracts', { studentId: sid, kind: '원서', startDate: '2026-05-01', endDate: '2026-04-01' })).status, 400);

  // 회의록 + 팔로업 한 번에 (팔로업에 미팅 연결)
  d = await kim.ok('saveWithFollowups', { table: 'meetings', obj: { studentId: sid, date: '2026-10-10', topic: '방향 회의', nextDate: '2026-10-24' },
    followups: [{ title: '추천서 요청', assignee: 'v7kim@revera.test', due: '2026-10-15' }, { title: '성적표 받기', assignee: 'v7staff@revera.test' }, { title: '  ' }] });
  const mid = d.savedId;
  assert.strictEqual(d.meetings.find((m) => m.id === mid).nextDate, '2026-10-24');
  const fus = d.followups.filter((f) => f.meetingId === mid);
  assert.deepStrictEqual(fus.map((f) => f.title).sort(), ['성적표 받기', '추천서 요청']);
  assert.ok(fus.every((f) => f.status === '할 일' && f.studentId === sid));
  // 상담기록: 내용 없이 팔로업만 있어도 저장, 둘 다 없으면 거부
  d = await admin.ok('saveWithFollowups', { table: 'notes', obj: { studentId: sid, date: '2026-10-11', type: '전화' }, followups: [{ title: '학부모 회신 확인' }] });
  assert.ok(d.followups.some((f) => f.noteId === d.savedId && f.assignee === 'admin@revera.test'));
  assert.strictEqual((await admin.rpc('saveWithFollowups', { table: 'notes', obj: { studentId: sid, date: '2026-10-11' }, followups: [] })).status, 400);
  // 실패하면 기록도 팔로업도 남지 않음 (잘못된 기한)
  const before = (await admin.ok('getAll')).meetings.length;
  assert.strictEqual((await kim.rpc('saveWithFollowups', { table: 'meetings', obj: { studentId: sid, date: '2026-10-12' }, followups: [{ title: 'x', due: '10/15' }] })).status, 400);
  assert.strictEqual((await admin.ok('getAll')).meetings.length, before);
  // 컨설턴트는 다른 학생 기록에 팔로업을 붙일 수 없음
  assert.strictEqual((await lee.rpc('saveWithFollowups', { table: 'meetings', obj: { studentId: sid, date: '2026-10-12' } })).status, 403);

  // 팔로업 요청: 담당자 변경 + 요청 기록 + 메일, 볼 수 없는 컨설턴트에게는 불가
  const fu = fus.find((f) => f.title === '추천서 요청');
  assert.strictEqual((await kim.rpc('requestFollowup', { id: fu.id, to: 'v7lee@revera.test' })).status, 400);
  scriptCalls.length = 0;
  d = await kim.ok('requestFollowup', { id: fu.id, to: 'v7staff@revera.test', note: '저 휴무라 부탁드려요', updatedAt: fu.updatedAt });
  const f2 = d.followups.find((f) => f.id === fu.id);
  assert.deepStrictEqual([f2.assignee, f2.requestedBy, f2.requestNote], ['v7staff@revera.test', 'v7kim@revera.test', '저 휴무라 부탁드려요']);
  assert.strictEqual(d.mail.sent, true);
  const mail = scriptCalls.find((x) => x.action === 'mail');
  assert.ok(mail && mail.messages[0].to === 'v7staff@revera.test' && /추천서 요청/.test(mail.messages[0].subject) && /휴무/.test(mail.messages[0].text));
  // 이미 담당인 사람에게 다시 요청 불가, 오래된 화면에서 요청하면 충돌
  assert.strictEqual((await kim.rpc('requestFollowup', { id: fu.id, to: 'v7staff@revera.test' })).status, 400);
  assert.strictEqual((await staff.rpc('requestFollowup', { id: fu.id, to: 'v7kim@revera.test', updatedAt: fu.updatedAt })).status, 409);
  // 아침 메일에 "넘겨받은 일"
  const dg = require('../lib/automation').buildDigests(store, '2026-10-01').find((m) => m.to === 'v7staff@revera.test');
  assert.ok(dg && dg.counts.requests >= 1 && /넘겨받은 일/.test(dg.html));

  // 목록 순서 (드래그): 관리팀은 학교 순서, 대학 순서는 관리자만
  await admin.ok('saveOption', { kind: 'school', value: 'v7 A학교' });
  d = await admin.ok('saveOption', { kind: 'school', value: 'v7 B학교' });
  const sch = d.options.filter((o) => o.kind === 'school' && /^v7/.test(o.value));
  d = await staff.ok('saveOrder', { kind: 'school', ids: [sch[1].id, sch[0].id] });
  assert.strictEqual(d.options.find((o) => o.id === sch[1].id).sortOrder, '1');
  const unis = d.universities.slice(0, 2).map((u) => u.id);
  assert.strictEqual((await staff.rpc('saveOrder', { kind: 'universities', ids: unis })).status, 403);
  d = await admin.ok('saveOrder', { kind: 'universities', ids: [unis[1], unis[0]] });
  assert.strictEqual(d.universities.find((u) => u.id === unis[1]).sortOrder, '1');

  // 대학 자료: 입학 연도별 업로드, 모두 보기, 수정·삭제는 올린 사람·관리팀
  const cyc = d.unicycles[0];
  const up = (cl, name, cat) => cl.req('POST', '/api/unifiles/upload?cycleId=' + cyc.id + '&category=' + encodeURIComponent(cat || ''),
    undefined, { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) }, Buffer.from('%PDF-1.4 test'));
  let r = await up(kim, '2027 모집요강.pdf', '모집요강');
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const uf = r.data.unifiles.find((x) => x.name === '2027 모집요강.pdf');
  assert.strictEqual(uf.cycleId, cyc.id);
  assert.strictEqual((await up(kim, 'virus.exe')).status, 400);
  const dl = await lee.req('GET', '/api/unifiles/' + uf.id);
  assert.strictEqual(dl.status, 200);
  assert.strictEqual(String(dl.data).slice(0, 8), '%PDF-1.4');
  assert.strictEqual((await lee.rpc('removeUniFile', { id: uf.id })).status, 403);
  await kim.ok('saveUniFile', { id: uf.id, category: '공식 안내', memo: '2027학년도' });
  assert.ok(store.listFiles().some((f) => f.name === '2027 모집요강.pdf' && /대학 자료/.test(f.studentName)), 'backup includes uni files');
  await staff.ok('removeUniFile', { id: uf.id });
  assert.strictEqual((await lee.req('GET', '/api/unifiles/' + uf.id)).status, 404);
});

test('v10 업그레이드: 기존 계약의 시작·종료 연월을 날짜로 채움', () => {
  const p = path.join(dir, 'v10.db');
  let st = openStore(p);
  st.db.prepare("INSERT INTO students (id, name, createdAt, updatedAt) VALUES ('s1', '옛학생', 'x', 'x')").run();
  st.db.prepare("INSERT INTO contracts (id, studentId, kind, startMonth, endMonth, startDate, endDate, createdAt, updatedAt) VALUES ('c1','s1','연간','2024-02','2024-02','','','x','x'), ('c2','s1','원서','','','','','x','x')").run();
  st.db.prepare("DELETE FROM meta WHERE key = 'v10_contract_dates'").run();
  st.close();
  st = openStore(p);
  const rows = st.db.prepare('SELECT id, startDate, endDate FROM contracts ORDER BY id').all();
  assert.deepStrictEqual(rows, [{ id: 'c1', startDate: '2024-02-01', endDate: '2024-02-29' }, { id: 'c2', startDate: '', endDate: '' }]);
  st.close();
});

test('서식 있는 회의록: 허용한 서식만 저장, 일반 글도 함께 만들어짐', async () => {
  const admin = client(); await admin.login('admin@revera.test', 'admin-pass-1');
  let d = await admin.saveOk('students', { name: '서식학생' });
  const sid = d.savedId;
  d = await admin.ok('saveWithFollowups', { table: 'meetings', obj: { studentId: sid, date: '2026-10-17',
    contentHtml: '1. 홍콩대<div><span style="color: rgb(217, 83, 79); font-size: x-large; position: fixed">중요</span> <u>밑줄</u></div>' +
      '<img src=x onerror=alert(1)><script>alert(2)</script><a href="javascript:alert(3)">링크</a><div><span style="background-color: rgb(255, 243, 163)">형광</span></div>' } });
  const m = d.meetings.find((x) => x.id === d.savedId);
  assert.ok(!/script|onerror|img|javascript|position|<a/i.test(m.contentHtml), m.contentHtml);
  assert.ok(/color: rgb\(217, 83, 79\); font-size: x-large/.test(m.contentHtml) && /<u>밑줄<\/u>/.test(m.contentHtml) && /background-color/.test(m.contentHtml));
  assert.strictEqual(m.content, '1. 홍콩대\n중요 밑줄링크\n형광'); // 지운 태그 안의 글자(링크)는 남음
  // 서식 없이 줄바꿈만 있으면 일반 글로만 저장
  d = await admin.ok('saveWithFollowups', { table: 'notes', obj: { studentId: sid, date: '2026-10-17', contentHtml: '첫 줄<div>둘째 줄</div><div><br></div><div>넷째</div>' } });
  const n = d.notes.find((x) => x.id === d.savedId);
  assert.deepStrictEqual([n.content, n.contentHtml], ['첫 줄\n둘째 줄\n\n넷째', '']);
  // 검색용 글이 비면 상담기록은 거부
  assert.strictEqual((await admin.rpc('saveWithFollowups', { table: 'notes', obj: { studentId: sid, date: '2026-10-17', contentHtml: '<div><br></div>' } })).status, 400);
});

test('원서 정보: 항목·내용 자유 목록, 대학 지정, 담당 학생만', async () => {
  const admin = client(); await admin.login('admin@revera.test', 'admin-pass-1');
  const kim = await newUser(admin, 'aikim@revera.test', 'consultant');
  const lee = await newUser(admin, 'ailee@revera.test', 'consultant');
  let d = await admin.saveOk('students', { name: '원서학생', counselor: 'aikim@revera.test' });
  const sid = d.savedId, hku = d.universities.find((u) => u.name === 'HKU').id;
  d = await kim.saveOk('appinfo', { studentId: sid, item: '추천인 1', content: '이름: 예시 선생님\n이메일: teacher@example.org', universityId: hku });
  const r = d.appinfo.find((x) => x.id === d.savedId);
  assert.deepStrictEqual([r.item, r.universityId], ['추천인 1', hku]);
  await kim.saveOk('appinfo', { studentId: sid, item: '학교 코드', content: '000000' });
  assert.strictEqual((await kim.save('appinfo', { studentId: sid, item: '', content: 'x' })).status, 400);
  assert.strictEqual((await kim.save('appinfo', { studentId: sid, item: '빈 내용', content: '' })).status, 400);
  assert.strictEqual((await kim.save('appinfo', { studentId: sid, item: 'x', content: 'y', universityId: 'nope' })).status, 400);
  assert.strictEqual((await lee.save('appinfo', { studentId: sid, item: 'x', content: 'y' })).status, 403);
  assert.ok(!(await lee.ok('getAll')).appinfo.some((x) => x.studentId === sid));
  // 휴지통으로 지우고 되살리기
  await kim.ok('remove', { table: 'appinfo', id: r.id });
  assert.ok(!(await kim.ok('getAll')).appinfo.some((x) => x.id === r.id));
  await admin.ok('restore', { table: 'appinfo', id: r.id });
  assert.ok((await kim.ok('getAll')).appinfo.some((x) => x.id === r.id));
});

test('v8: 일정 분류·색 목록(이름 바꾸면 일정도), 대회·프로그램 정보', async () => {
  const admin = client(); await admin.login('admin@revera.test', 'admin-pass-1');
  const staff = await newUser(admin, 'v8staff@revera.test', 'staff');
  const kim = await newUser(admin, 'v8kim@revera.test', 'consultant');
  const lee = await newUser(admin, 'v8lee@revera.test', 'consultant');
  let d = await kim.ok('getAll');
  const cats = d.options.filter((o) => o.kind === 'evcat');
  assert.deepStrictEqual(cats.map((c) => c.value), ['시험', '원서·입시', '학교', '설명회·행사', '휴무', '기타']);
  assert.ok(cats.every((c) => /^#[0-9a-f]{6}$/.test(c.color)));
  // 관리팀이 분류 추가(색 지정), 컨설턴트는 목록 관리 불가
  d = await staff.ok('saveOption', { kind: 'evcat', value: '에세이 대회', color: '#1d4ed8' });
  const essay = d.options.find((o) => o.kind === 'evcat' && o.value === '에세이 대회');
  assert.strictEqual(essay.sortOrder, '7');
  assert.strictEqual((await kim.rpc('saveOption', { kind: 'evcat', value: 'x', color: '#000000' })).status, 403);
  assert.strictEqual((await staff.rpc('saveOption', { kind: 'evcat', value: 'y', color: 'red;}' })).status, 400);
  // 일정은 목록에 있는 분류만
  d = await kim.ok('saveEvent', { date: '2026-10-25', title: 'Immerse essay 마감', category: '에세이 대회' });
  const evId = d.savedId;
  assert.strictEqual((await kim.rpc('saveEvent', { date: '2026-10-25', title: 'x', category: '없는 분류' })).status, 400);
  // 분류 이름을 바꾸면 그 분류의 일정도 함께, 색만 바꾸면 이름 유지
  d = await staff.ok('saveOption', { id: essay.id, kind: 'evcat', value: '대회 마감', color: '#0f7a55' });
  assert.strictEqual(d.events.find((e) => e.id === evId).category, '대회 마감');
  assert.strictEqual(d.options.find((o) => o.id === essay.id).color, '#0f7a55');
  // 분류를 지워도 기존 일정은 남고, 그 일정은 분류 그대로 고칠 수 있음
  d = await staff.ok('removeOption', { id: essay.id });
  const ev = d.events.find((e) => e.id === evId);
  assert.strictEqual(ev.category, '대회 마감');
  await kim.ok('saveEvent', { id: evId, updatedAt: ev.updatedAt, date: '2026-10-26', title: ev.title, category: '대회 마감' });

  // 대회·프로그램
  d = await kim.ok('saveProgram', { name: 'Immerse Education Essay Competition', category: '에세이 대회', target: 'G9–G12', schedule: '마감 2026-10-25 (예시)',
    deadline: '2026-10-25', url: 'https://example.org/immerse', memo: '주제 중 하나 골라 500단어' });
  const pid = d.savedId;
  assert.ok(d.programs.some((x) => x.id === pid && x.createdBy === 'v8kim@revera.test'));
  assert.strictEqual((await kim.rpc('saveProgram', { name: '' })).status, 400);
  assert.strictEqual((await kim.rpc('saveProgram', { name: 'x', url: 'javascript:alert(1)' })).status, 400);
  assert.strictEqual((await kim.rpc('saveProgram', { name: 'x', deadline: '10/25' })).status, 400);
  const p0 = d.programs.find((x) => x.id === pid);
  d = await lee.ok('saveProgram', { id: pid, updatedAt: p0.updatedAt, name: p0.name, category: p0.category, url: p0.url, memo: '모두 수정 가능' });
  assert.strictEqual(d.programs.find((x) => x.id === pid).memo, '모두 수정 가능');
  assert.strictEqual((await kim.rpc('saveProgram', { id: pid, updatedAt: p0.updatedAt, name: 'x' })).status, 409);
  assert.strictEqual((await lee.rpc('removeProgram', { id: pid })).status, 403);
  await staff.ok('removeProgram', { id: pid });
  const log = await admin.ok('getLog', {});
  assert.ok(log.rows.some((r) => r.tbl === 'programs' && r.action === 'delete' && r.tblLabel === '대회·프로그램'));
});

test('받은 연락: 팔로업 종류·보낸 사람·경로·우리 답변, 스크린샷 연결', async () => {
  const admin = client(); await admin.login('admin@revera.test', 'admin-pass-1');
  let d = await admin.saveOk('students', { name: '연락학생' });
  const sid = d.savedId;
  d = await admin.saveOk('followups', { studentId: sid, kind: 'contact', fromWho: '어머님', channel: '위챗', receivedDate: '2026-10-20',
    title: 'IA 초안 월요일까지 내도 되나요?', detail: 'IA 초안 월요일까지 내도 되나요?\n학교는 수요일까지래요' });
  const fid = d.savedId;
  assert.strictEqual(d.followups.find((f) => f.id === fid).status, '할 일');
  assert.strictEqual((await admin.save('followups', { studentId: sid, kind: 'x', title: 't' })).status, 400);
  assert.strictEqual((await admin.save('followups', { studentId: sid, kind: 'contact', fromWho: '친구', title: 't' })).status, 400);
  assert.strictEqual((await admin.save('followups', { studentId: sid, kind: 'contact', channel: '팩스', title: 't' })).status, 400);
  const cur = d.followups.find((f) => f.id === fid);
  d = await admin.saveOk('followups', { id: fid, updatedAt: cur.updatedAt, answer: '월요일 가능', answerDate: '2026-10-20', status: '완료' });
  const f2 = d.followups.find((f) => f.id === fid);
  assert.deepStrictEqual([f2.answer, f2.status, !!f2.doneAt], ['월요일 가능', '완료', true]);
  // 스크린샷은 그 연락에 연결 (다른 학생 연락에는 불가)
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const up = (studentId, followupId) => admin.req('POST', '/api/files/upload?studentId=' + studentId + '&followupId=' + followupId, undefined,
    { 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('캡처.png') }, png);
  let r = await up(sid, fid);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.files.some((f) => f.followupId === fid && f.category === '연락'));
  const other = (await admin.saveOk('students', { name: '다른학생' })).savedId;
  assert.strictEqual((await up(other, fid)).status, 404);
});

test('저장 공간: 매일 백업은 기록만, 파일은 새것만 하나씩 드라이브로, 실패 3번이면 건너뜀, 사용량·경고', async () => {
  const automation = require('../lib/automation');
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  await admin.ok('saveAutomation', { scriptUrl: 'https://script.google.com/macros/s/AKfy_abc-123/exec', backupOn: true, volumeGB: 5 });
  let d = await admin.saveOk('students', { name: '용량학생' });
  const sid = d.savedId;
  for (const n of ['a.pdf', 'b.pdf']) {
    const r = await admin.upload(sid, n, Buffer.alloc(1000, 1));
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  }
  // 매일 백업 ZIP 에는 업로드 파일이 들어가지 않음
  await admin.req('POST', '/api/automation/backup', {});
  const zip = Buffer.from(scriptCalls.filter((c) => c.action === 'backup').pop().data, 'base64');
  assert.ok(zip.includes(Buffer.from('compass.db')) && !zip.includes(Buffer.from('files/')), '기록만');
  // 기록만 다운로드
  const dl = await admin.req('GET', '/api/backup?mode=db');
  assert.match(dl.headers.get('content-disposition'), /compass-backup-\d+-/);

  // 파일 백업: 처음엔 전부, 다음엔 새 것만
  const fetch = (u, i) => fakeFetch(u, i);
  const files = () => scriptCalls.filter((c) => c.action === 'file');
  let r = await automation.syncFiles(store, fetch, { maxFiles: 1000, maxBytes: 1e12 });
  assert.ok(r.sent >= 2 && r.left === 0);
  const sentNames = files().map((c) => c.name);
  assert.ok(files().some((c) => /용량학생 · 성적증명서 · a\.pdf/.test(c.label)));
  r = await automation.syncFiles(store, fetch);
  assert.strictEqual(r.sent, 0, '이미 보낸 파일은 다시 안 보냄');
  await admin.upload(sid, 'c.pdf', Buffer.alloc(500, 1));
  r = await admin.req('POST', '/api/automation/filesync', {});
  assert.strictEqual(r.data.sent, 1);
  assert.ok(!sentNames.includes(files().pop().name));

  // 예전 Apps Script(파일 기능 없음) → 알기 쉬운 오류, 3번 실패하면 건너뛰고 실패 목록에
  await admin.upload(sid, 'd.pdf', Buffer.alloc(500, 1));
  const oldScript = async (url, init) => { const body = JSON.parse(init.body); return { status: 200, text: async () => JSON.stringify(body.action === 'file' ? { ok: false, error: 'unknown action' } : { ok: true }) }; };
  for (let i = 0; i < 3; i++) await assert.rejects(automation.runFileSync(store, oldScript), /예전 버전/);
  assert.strictEqual(store.pendingSync().length, 0);
  let st = await admin.ok('getStorage');
  assert.strictEqual(st.sync.failed.length, 1);
  assert.match(st.sync.status.result, /^실패/);
  assert.ok((await admin.ok('getAll')).backupAlert.some((x) => x.kind === 'filesync'));
  st = await admin.ok('retrySync');
  assert.strictEqual(st.sync.pending, 1);
  await automation.runFileSync(store, fetch);
  assert.ok(!(await admin.ok('getAll')).backupAlert, '성공하면 경고 사라짐');

  // 사용량: 학생별·분류별·큰 파일, 권한
  st = await admin.ok('getStorage');
  const me = st.byStudent.find((x) => x.studentId === sid);
  assert.strictEqual(me.count, 4); assert.strictEqual(me.bytes, 3000);
  assert.ok(st.byCategory.some((x) => x.category === '성적증명서'));
  assert.ok(st.summary.used > 0 && st.summary.limit === 5 * 1024 ** 3);
  const staff = client(); await staff.login('mail1@revera.test', '123456');
  assert.strictEqual((await staff.rpc('getStorage')).status, 403);
  assert.strictEqual((await staff.req('POST', '/api/automation/filesync', {})).status, 403);
  assert.ok(!(await staff.ok('getAll')).storageAlert);
  // 80% 넘으면 관리자·관리팀 화면에 경고 (공간 크기를 아주 작게 해서 확인)
  assert.strictEqual((await admin.rpc('saveAutomation', { volumeGB: 0.1 })).status, 400);
  store.db.prepare("UPDATE meta SET value = '0.000001' WHERE key = 'cfg.volumeGB'").run();
  assert.ok((await staff.ok('getAll')).storageAlert.pct >= 80);
  store.db.prepare("UPDATE meta SET value = '5' WHERE key = 'cfg.volumeGB'").run();
});


test('메인 화면 배치: 계정별 저장, 관리자 기본 배치, 형식 검사, 전체 최근 활동은 볼 수 있는 학생만', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  await admin.ok('saveTeacher', { email: 'lay1@revera.test', name: '배치컨설', role: 'consultant', password: '123456' });
  const con = client(); await con.login('lay1@revera.test', '123456');
  let d = await con.ok('getAll');
  assert.strictEqual(d.me.homeLayout, null);
  const mine = [{ id: 'contacts', s: '2x3' }, { id: 'today', s: '9x9', hide: 0 }, { id: 'calendar', s: '<b>', hide: true }];
  d = await con.ok('saveHomeLayout', { layout: mine });
  assert.deepStrictEqual(d.me.homeLayout, [{ id: 'contacts', s: '2x3', hide: false, ts: '', tc: '', bg: '' }, { id: 'today', s: '', hide: false, ts: '', tc: '', bg: '' }, { id: 'calendar', s: '', hide: true, ts: '', tc: '', bg: '' }]);
  d = await con.ok('saveHomeLayout', { layout: [{ id: 'gap1', s: '1x1' }, { id: 'today', s: '2x2', ts: 'xl', tc: '#C0392B', bg: 'red' }] });
  assert.deepStrictEqual(d.me.homeLayout[1], { id: 'today', s: '2x2', hide: false, ts: 'xl', tc: '#c0392b', bg: '' });
  assert.strictEqual(d.me.homeLayout[0].id, 'gap1');
  assert.strictEqual((await con.rpc('saveHomeLayout', { layout: [{ id: 'a' }, { id: 'a' }] })).status, 400, '중복');
  assert.strictEqual((await con.rpc('saveHomeLayout', { layout: [{ id: '<script>' }] })).status, 400);
  assert.strictEqual((await con.rpc('saveHomeLayout', { layout: [], asDefault: true })).status, 403, '기본 배치는 관리자만');
  // 관리자 기본 배치: 배치를 안 바꾼 사람에게 보임 (내 배치가 있으면 내 배치)
  await admin.ok('saveHomeLayout', { layout: [{ id: 'today', s: '4x2' }, { id: 'review', s: '1x2' }], asDefault: true });
  d = await con.ok('getAll');
  assert.strictEqual(d.homeDefault[1].id, 'review');
  assert.strictEqual(d.me.homeLayout[0].id, 'gap1');
  d = await con.ok('saveHomeLayout', { layout: null });
  assert.strictEqual(d.me.homeLayout, null, '되돌리기 → 기본 배치를 따름');
  await admin.ok('saveHomeLayout', { layout: null, asDefault: true });
  assert.strictEqual((await con.ok('getAll')).homeDefault, null);

  // 전체 최근 활동: 컨설턴트는 담당 학생 것만
  d = await admin.saveOk('students', { name: '활동담당', counselor: 'lay1@revera.test' });
  await admin.saveOk('followups', { studentId: d.savedId, title: '담당 학생 일' });
  d = await admin.saveOk('students', { name: '활동남의학생' });
  await admin.saveOk('followups', { studentId: d.savedId, title: '남의 학생 일' });
  const rows = (await con.ok('getActivity', { all: true })).rows;
  assert.ok(rows.some((r) => r.studentName === '활동담당'));
  assert.ok(!rows.some((r) => r.studentName === '활동남의학생'));
  assert.ok((await admin.ok('getActivity', { all: true })).rows.some((r) => r.studentName === '활동남의학생'));
});

test('확인 요청: 저장하면서 요청, 받은 사람만 확인, 보낸 사람 취소, 볼 수 없는 사람·상담기록은 컨설턴트에게 못 보냄', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  await admin.ok('saveTeacher', { email: 'rv-staff@revera.test', name: '확인관리', role: 'staff', password: '123456' });
  await admin.ok('saveTeacher', { email: 'rv-con@revera.test', name: '확인컨설', role: 'consultant', password: '123456' });
  await admin.ok('saveTeacher', { email: 'rv-other@revera.test', name: '남의컨설', role: 'consultant', password: '123456' });
  const staff = client(); await staff.login('rv-staff@revera.test', '123456');
  const con = client(); await con.login('rv-con@revera.test', '123456');
  let d = await admin.saveOk('students', { name: '확인학생', counselor: 'rv-con@revera.test' });
  const sid = d.savedId;
  // 받은 연락 저장 + 확인 요청 (관리팀·담당 컨설턴트)
  d = await admin.ok('save', { table: 'followups', obj: { studentId: sid, kind: 'contact', title: '어머님 문의', detail: '어머님 문의', status: '완료', answer: '답변 완료' },
    review: { to: ['rv-staff@revera.test', 'rv-con@revera.test'], note: '참고만 해주세요' } });
  const fid = d.savedId;
  assert.strictEqual(d.reviews.filter((r) => r.refId === fid).length, 2);
  // 볼 수 없는 컨설턴트 → 거절, 저장도 안 됨
  let r = await admin.rpc('save', { table: 'followups', obj: { studentId: sid, title: '거절될 일' }, review: { to: ['rv-other@revera.test'] } });
  assert.strictEqual(r.status, 400);
  assert.ok(!(await admin.ok('getAll')).followups.some((f) => f.title === '거절될 일'), '요청이 실패하면 기록도 저장 안 됨');
  // 상담기록은 컨설턴트에게 못 보냄, 관리팀에는 됨 (팔로업과 함께 저장하는 경로)
  r = await admin.rpc('saveWithFollowups', { table: 'notes', obj: { studentId: sid, date: '2026-10-20', content: '상담' }, followups: [], review: { to: ['rv-con@revera.test'] } });
  assert.strictEqual(r.status, 400);
  d = await admin.ok('saveWithFollowups', { table: 'notes', obj: { studentId: sid, date: '2026-10-20', content: '상담' }, followups: [], review: { to: ['rv-staff@revera.test'] } });
  const nid = d.savedId;
  // 받은 사람에게 보임 (컨설턴트는 상담기록 건은 안 보임)
  const sv = (await staff.ok('getAll')).reviews.filter((x) => x.toEmail === 'rv-staff@revera.test');
  assert.strictEqual(sv.length, 2);
  const cv = (await con.ok('getAll')).reviews;
  assert.ok(cv.every((x) => x.refTable !== 'notes') && cv.some((x) => x.refId === fid));
  // 같은 사람에게 중복 요청은 하나만
  d = await admin.ok('requestReview', { refTable: 'followups', refId: fid, to: ['rv-staff@revera.test'] });
  assert.strictEqual(d.reviews.filter((x) => x.refId === fid && x.toEmail === 'rv-staff@revera.test').length, 1);
  // 확인은 받은 사람만
  const mine = sv.find((x) => x.refId === nid);
  assert.strictEqual((await con.rpc('doneReview', { id: mine.id })).status, 403);
  d = await staff.ok('doneReview', { id: mine.id });
  assert.ok(d.reviews.find((x) => x.id === mine.id).doneAt);
  d = await staff.ok('doneReview', { id: mine.id, undo: true });
  assert.strictEqual(d.reviews.find((x) => x.id === mine.id).doneAt, '');
  // 취소는 보낸 사람(또는 관리자)만
  const cr = cv.find((x) => x.refId === fid);
  assert.strictEqual((await con.rpc('cancelReview', { id: cr.id })).status, 403);
  d = await admin.ok('cancelReview', { id: cr.id });
  assert.ok(!d.reviews.some((x) => x.id === cr.id));
  // 컨설턴트도 담당 학생의 미팅은 관리팀에 요청 가능, 상담기록은 불가
  d = await con.saveOk('meetings', { studentId: sid, date: '2026-10-20', content: '미팅' });
  d = await con.ok('requestReview', { refTable: 'meetings', refId: d.savedId, to: ['rv-staff@revera.test'] });
  assert.strictEqual((await con.rpc('requestReview', { refTable: 'notes', refId: nid, to: ['rv-staff@revera.test'] })).status, 403);
});

test('선생님 색: 저장·형식 검사, 모두에게 보임', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  let d = await admin.ok('saveTeacher', { email: 'color1@revera.test', name: '색관리', role: 'staff', password: '123456', color: '#FFFF00' });
  assert.strictEqual(d.teachers.find((t) => t.email === 'color1@revera.test').color, '#ffff00');
  assert.strictEqual((await admin.rpc('saveTeacher', { email: 'color1@revera.test', color: 'red;background:url(x)' })).status, 400);
  d = await admin.ok('saveTeacher', { email: 'color1@revera.test', name: '색관리', role: 'staff', color: '' });
  assert.strictEqual(d.teachers.find((t) => t.email === 'color1@revera.test').color, '');
  await admin.ok('saveTeacher', { email: 'color1@revera.test', name: '색관리', role: 'staff', color: '#cfe2f3' });
  const c = client(); await c.login('color1@revera.test', '123456');
  assert.strictEqual((await c.ok('getAll')).teachers.find((t) => t.email === 'color1@revera.test').color, '#cfe2f3');
});

test('원장님 스케줄 가져오기: 우리 학생 일정만 저장, 권한대로 보임, 우리 학생 아님으로 빼면 다음에도 안 들어옴', async () => {
  const automation = require('../lib/automation');
  const schedule = require('../lib/schedule');
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  await admin.ok('saveTeacher', { email: 'sch-con@revera.test', name: '일정컨설', role: 'consultant', password: '123456' });
  let d = await admin.saveOk('students', { name: '일정학생', counselor: 'sch-con@revera.test' });
  const sid = d.savedId;
  await admin.saveOk('students', { name: '남의일정' });
  assert.strictEqual((await admin.rpc('saveAutomation', { schedSheet: 'https://evil.example.com/x' })).status, 400);
  d = await admin.ok('saveAutomation', { scriptUrl: 'https://script.google.com/macros/s/AKfy_abc-123/exec', schedSheet: 'https://docs.google.com/spreadsheets/d/17qMPa0jnDnGrGCIg6UkjPg6gKy4K5mw3plmqR_0-GXs/edit#gid=1', schedOn: true });
  assert.strictEqual(d.config.schedSheet, '17qMPa0jnDnGrGCIg6UkjPg6gKy4K5mw3plmqR_0-GXs');
  // 이번 달 탭: 우리 학생 2명 + 유료 상담(다른 사람)
  const now = new Date(Date.now() + 8 * 3600000), y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  const ymd = (dd) => (m) + '/' + dd + '/' + y;
  const grid = [['', 'Mon'], ['', ymd(1), ymd(2), ymd(3), ymd(4), ymd(5), ymd(6), ymd(7), 'Weekly Total'], ['Daily Total']];
  for (let k = 0; k < 32; k++) grid.push([(k < 8 ? '0' : '') + 'x:00 - y'.replace('x', String(8 + Math.floor(k / 2))).replace(/^0(\d\d)/, '$1'), '', '', '', '', '', '', '']);
  grid.forEach((r, i) => { if (i > 2) r[0] = '08:00 - 08:30'; });
  grid[3 + 4][1] = '일정학생 학생'; grid[3 + 5][1] = 'ZOOM 미팅';
  grid[3 + 8][2] = '남의일정 부모님 미팅';
  grid[3 + 10][3] = '윤바다 덜위치 Y12'; grid[3 + 11][3] = '1:1 유료 상담';
  sheetTabs = { [schedule.tabName(y, m)]: grid };
  const fetch = (u, i) => fakeFetch(u, i);
  let r = await automation.syncSchedule(store, fetch, true);
  assert.deepStrictEqual([r.saved, r.unmatched], [2, 1]);
  assert.match((await admin.ok('getAutomation')).status.schedule.result, /우리 학생 일정 2건.*그 외 일정 1건/);
  d = await admin.ok('getAll');
  const mine = d.sched.find((x) => x.studentId === sid);
  assert.strictEqual(mine.startAt, y + '-' + String(m).padStart(2, '0') + '-01T10:00');
  assert.strictEqual(mine.detail, 'ZOOM 미팅');
  assert.ok(!d.sched.some((x) => /윤바다/.test(x.title)), '우리 학생이 아닌 일정은 저장 안 함');
  // 컨설턴트는 담당 학생 일정만
  const con = client(); await con.login('sch-con@revera.test', '123456');
  assert.deepStrictEqual((await con.ok('getAll')).sched.map((x) => x.studentId), [sid]);
  // 우리 학생 아님 → 지워지고 다시 가져와도 안 들어옴, 관리자가 되돌리면 다시 들어옴
  const other = d.sched.find((x) => /남의일정/.test(x.title));
  assert.strictEqual((await con.rpc('excludeSched', { key: other.key })).status, 403, '볼 수 없는 학생 일정은 못 뺌');
  d = await admin.ok('excludeSched', { key: other.key });
  assert.ok(!d.sched.some((x) => x.key === other.key));
  r = await automation.syncSchedule(store, fetch);
  assert.deepStrictEqual([r.saved, r.excluded], [1, 1]);
  const ex = (await admin.ok('getAutomation')).schedEx;
  assert.strictEqual(ex[0].key, other.key);
  await admin.ok('unexcludeSched', { key: other.key });
  r = await automation.syncSchedule(store, fetch);
  assert.strictEqual(r.saved, 2);
  // 탭이 없으면 알기 쉬운 오류
  sheetTabs = {};
  await assert.rejects(automation.syncSchedule(store, fetch), /탭을 찾을 수 없습니다/);
  // 예전 Apps Script
  await assert.rejects(automation.syncSchedule(store, async () => ({ status: 200, text: async () => JSON.stringify({ ok: false, error: 'unknown action' }) })), /예전 버전/);
  await admin.ok('saveAutomation', { schedOn: false });
});

test('달력 자동 표시(원장님 미팅·다음 미팅·지원 마감): 이름 고정, 색·보이기·순서만, 지울 수 없음', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  let d = await admin.ok('getAll');
  const autos = d.options.filter((o) => o.kind === 'evauto');
  assert.deepStrictEqual(autos.map((o) => o.value).sort(), ['deadline', 'nextmeet', 'sched']);
  const sc = autos.find((o) => o.value === 'sched');
  d = await admin.ok('saveAutoCat', { id: sc.id, color: '#FF0000', hidden: true });
  const after = d.options.find((o) => o.id === sc.id);
  assert.deepStrictEqual([after.value, after.color, after.category], ['sched', '#ff0000', 'off']);
  assert.strictEqual((await admin.rpc('saveAutoCat', { id: sc.id, color: 'red' })).status, 400);
  assert.strictEqual((await admin.rpc('removeOption', { id: sc.id })).status, 400, '지울 수 없음');
  assert.strictEqual((await admin.rpc('saveOption', { kind: 'evauto', value: '새 항목' })).status, 400, '추가 안 됨');
  d = await admin.ok('saveOrder', { kind: 'evauto', ids: [autos[2].id, autos[1].id, autos[0].id] });
  assert.strictEqual(d.options.find((o) => o.id === autos[2].id).sortOrder, '1');
  await admin.ok('saveAutoCat', { id: sc.id, hidden: false, color: '#7c5cc4' });
  await admin.ok('saveTeacher', { email: 'auto-con@revera.test', name: '자동컨설', role: 'consultant', password: '123456' });
  const con = client(); await con.login('auto-con@revera.test', '123456');
  assert.strictEqual((await con.rpc('saveAutoCat', { id: sc.id, hidden: true })).status, 403, '컨설턴트는 못 바꿈');
});


test('v11: 공통 팔로업(학생마다 하나, 관리팀 담당), 여러 개 삭제·복구·영구 삭제, 점수 파일 첨부, 트랙 목록 이름 변경', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  await admin.ok('saveTeacher', { email: 'v11-mgr@revera.test', name: '관리A', role: 'staff', password: '123456' });
  let d = await admin.saveOk('students', { name: '공통1', manager: 'v11-mgr@revera.test', tracks: '3년특례, 홍콩' });
  const s1 = d.savedId;
  d = await admin.saveOk('students', { name: '공통2' });
  const s2 = d.savedId;
  // 공통 팔로업
  assert.strictEqual((await admin.rpc('addFollowupMany', { title: '', studentIds: [s1] })).status, 400);
  d = await admin.ok('addFollowupMany', { title: '1학기 성적표 받기', due: '2030-01-10', assignee: 'manager', studentIds: [s1, s2] });
  const g = d.followups.filter((f) => f.groupId === d.groupId);
  assert.strictEqual(g.length, 2);
  assert.strictEqual(g.find((f) => f.studentId === s1).assignee, 'v11-mgr@revera.test', '각 학생 관리팀 담당');
  assert.strictEqual(g.find((f) => f.studentId === s2).assignee, '', '관리팀 없으면 미정');
  // 컨설턴트는 볼 수 없는 학생에게 못 만듦
  await admin.ok('saveTeacher', { email: 'v11-con@revera.test', name: '컨설B', role: 'consultant', password: '123456' });
  const con = client(); await con.login('v11-con@revera.test', '123456');
  assert.strictEqual((await con.rpc('addFollowupMany', { title: 'x', studentIds: [s1] })).status, 403);
  // 점수 + 파일 첨부
  d = await admin.saveOk('scores', { studentId: s1, kind: 'SAT', score: '1500' });
  const scoreId = d.savedId;
  let r = await admin.req('POST', '/api/files/upload?studentId=' + s1 + '&scoreId=' + scoreId, undefined, { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('sat.pdf') }, Buffer.from('%PDF-1.4 x'));
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const sf = r.data.files.find((f) => f.scoreId === scoreId);
  assert.strictEqual(sf.category, '표준화학력(SAT·AP·IB)', 'SAT 첨부 → 표준화학력');
  r = await admin.req('POST', '/api/files/upload?studentId=' + s2 + '&scoreId=' + scoreId, undefined, { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('x.pdf') }, Buffer.from('%PDF'));
  assert.strictEqual(r.status, 404, '다른 학생 점수에는 못 붙임');
  // 여러 개 삭제 → 복구 → 다시 삭제 → 영구 삭제
  const f2 = (await admin.upload(s1, 'b.pdf', Buffer.from('%PDF b'))).data.files.find((f) => f.name === 'b.pdf');
  const items = [{ table: 'files', id: sf.id }, { table: 'files', id: f2.id }];
  d = await admin.ok('removeMany', { items });
  assert.ok(!d.files.some((f) => f.id === sf.id || f.id === f2.id));
  assert.strictEqual((await admin.rpc('removeMany', { items })).status, 404, '이미 삭제된 것이 있으면 전체 취소');
  d = await admin.ok('restoreMany', { items });
  assert.strictEqual(d.files.filter((f) => f.id === sf.id || f.id === f2.id).length, 2);
  await admin.ok('removeMany', { items });
  d = await admin.ok('purgeMany', { items: items.concat([{ table: 'files', id: 'nope' }]) });
  assert.strictEqual(d.count, 2); assert.strictEqual(d.failed.length, 1);
  assert.strictEqual((await con.rpc('purgeMany', { items })).status, 403);
  // 트랙 목록: 이름을 바꾸면 학생 트랙도 바뀜
  d = await admin.ok('getAll');
  const hk = d.options.find((o) => o.kind === 'track' && o.value === '홍콩');
  assert.ok(hk && d.options.filter((o) => o.kind === 'track').length >= 10);
  d = await admin.ok('saveOption', { id: hk.id, kind: 'track', value: '홍콩(HK)' });
  assert.strictEqual(d.students.find((s) => s.id === s1).tracks, '3년특례, 홍콩(HK)');
});

test('대학 전공: 여러 개 한 번에 추가(중복 건너뜀), 학부 이름 한꺼번에 바꾸기', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  let d = await admin.ok('getAll');
  const u = d.universities[0];
  d = await admin.ok('addMajorsMany', { universityId: u.id, rows: [{ name: 'Bachelor of Arts', faculty: 'Faculty of Arts' }, { name: 'bachelor of arts', faculty: 'X' }, { name: 'Business Administration', faculty: 'Arts Faculty', code: 'BBA' }, { name: '' }] });
  assert.deepStrictEqual([d.added, d.skipped], [2, 2]);
  d = await admin.ok('addMajorsMany', { universityId: u.id, rows: [{ name: 'BACHELOR OF ARTS' }] });
  assert.deepStrictEqual([d.added, d.skipped], [0, 1], '이미 있는 이름은 건너뜀');
  d = await admin.ok('renameFaculty', { universityId: u.id, from: 'Arts Faculty', to: 'Faculty of Arts' });
  assert.strictEqual(d.changed, 1);
  assert.strictEqual(d.unimajors.filter((m) => m.universityId === u.id && m.faculty === 'Faculty of Arts').length, 2);
  assert.strictEqual((await admin.rpc('addMajorsMany', { universityId: 'nope', rows: [{ name: 'x' }] })).status, 404);
});

test('백업으로 복구: 전체 백업 ZIP → 기록·파일 되돌림, 직전 상태 자동 백업, 관리자만, 잘못된 파일 거절', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');
  let d = await admin.saveOk('students', { name: '복구전학생' });
  const sid = d.savedId;
  const up = await admin.upload(sid, 'keep.pdf', Buffer.from('%PDF keep me'));
  const fileId = up.data.files.find((f) => f.name === 'keep.pdf').id;
  const stored = store.db.prepare('SELECT storedName FROM files WHERE id = ?').get(fileId).storedName;
  const zip = (await admin.req('GET', '/api/backup')).data;
  assert.ok(Buffer.isBuffer(zip) && zip.slice(0, 2).toString() === 'PK');
  // 백업 뒤 변경: 학생 추가, 학생 삭제, 파일 지움
  await admin.saveOk('students', { name: '백업뒤학생' });
  await admin.ok('remove', { table: 'students', id: sid });
  fs.rmSync(path.join(store.filesDir, stored), { force: true });
  // 권한·잘못된 파일
  await admin.ok('saveTeacher', { email: 'rs-staff@revera.test', name: '복구관리', role: 'staff', password: '123456' });
  const staff = client(); await staff.login('rs-staff@revera.test', '123456');
  assert.strictEqual((await staff.req('POST', '/api/restore', undefined, { 'Content-Type': 'application/zip' }, zip)).status, 403);
  assert.strictEqual((await admin.req('POST', '/api/restore', undefined, { 'Content-Type': 'application/zip' }, Buffer.from('not a zip'))).status, 400);
  // 복구
  const r = await admin.req('POST', '/api/restore', undefined, { 'Content-Type': 'application/zip' }, zip);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.filesWritten >= 1 && /^before-restore-\d+\.zip$/.test(r.data.before));
  d = await admin.ok('getAll'); // 로그인 유지
  assert.ok(d.students.some((s) => s.name === '복구전학생'), '지운 학생이 돌아옴');
  assert.ok(!d.students.some((s) => s.name === '백업뒤학생'), '백업 뒤에 만든 학생은 없어짐');
  assert.ok(fs.existsSync(path.join(store.filesDir, stored)), '지운 파일이 돌아옴');
  assert.ok(d.options.some((o) => o.kind === 'evauto'), '복구 뒤에도 새 구조 유지');
  const list = (await admin.req('GET', '/api/restore-backups')).data.list;
  assert.ok(list.some((f) => f.name === r.data.before));
  assert.strictEqual((await admin.req('GET', '/api/restore-backups/' + r.data.before)).status, 200);
  assert.strictEqual((await admin.req('GET', '/api/restore-backups/..%2Ftest.db')).status, 404);
});

test('팔로업 답변 이어쓰기: 여러 번 추가, 검증, 예전 한 칸 답변·우리 답변 옮기기(어머니→어머님)', async () => {
  const admin = client(); await admin.login('admin@revera.test', 'admin-pass-1');
  let d = await admin.saveOk('students', { name: '답변학생' });
  const sid = d.savedId;
  d = await admin.saveOk('followups', { studentId: sid, title: '추천서 요청', status: '할 일' });
  const fid = d.savedId;
  await admin.saveOk('fureplies', { studentId: sid, followupId: fid, who: '학생', date: '2026-10-20', content: '선생님께 메일 보냈어요' });
  d = await admin.saveOk('fureplies', { studentId: sid, followupId: fid, who: '어머님', date: '2026-10-21', content: '확인했습니다' });
  assert.strictEqual(d.fureplies.filter((x) => x.followupId === fid).length, 2);
  assert.strictEqual((await admin.save('fureplies', { studentId: sid, followupId: fid, who: '학생', content: '  ' })).status, 400, '내용 필수');
  assert.strictEqual((await admin.save('fureplies', { studentId: sid, followupId: fid, who: '', content: 'x' })).status, 400, '답변한 사람 필수');
  assert.strictEqual((await admin.save('fureplies', { studentId: 'other', followupId: fid, who: '학생', content: 'x' })).status, 404, '다른 학생 팔로업에는 못 붙임');

  const p = path.join(dir, 'v16.db');
  let st = openStore(p);
  st.db.prepare("INSERT INTO students (id, name, createdAt, updatedAt) VALUES ('s1', '옛학생', 'x', 'x')").run();
  st.db.prepare(`INSERT INTO followups (id, studentId, title, status, reply, replyFrom, replyDate, kind, fromWho, answer, answerDate, createdAt, updatedAt, createdBy, updatedBy) VALUES
    ('f1','s1','성적표','할 일','보냈어요','어머니','2026-10-01','','','','','x','x','a@x','a@x'),
    ('f2','s1','질문','완료','','','','contact','아버지','월요일 제출 가능','2026-10-02','x','x','a@x','a@x')`).run();
  st.db.prepare("DELETE FROM meta WHERE key = 'v16_replies'").run();
  st.close();
  st = openStore(p);
  const reps = st.db.prepare('SELECT followupId, who, date, content FROM fureplies ORDER BY followupId').all();
  assert.deepStrictEqual(reps, [
    { followupId: 'f1', who: '어머님', date: '2026-10-01', content: '보냈어요' },
    { followupId: 'f2', who: '담당 선생님', date: '2026-10-02', content: '월요일 제출 가능' }]);
  assert.deepStrictEqual(st.db.prepare('SELECT reply, answer, fromWho FROM followups ORDER BY id').all(), [{ reply: '', answer: '', fromWho: '' }, { reply: '', answer: '', fromWho: '아버님' }]);
  st.close();
});

test('서류 분류: 기본 목록, 파일·서류 분류 옮기기, 점수 첨부 자동 분류, 이름 바꾸면 파일·서류도 함께', async () => {
  const p = path.join(dir, 'v17.db');
  let st = openStore(p);
  st.db.prepare("INSERT INTO students (id, name, createdAt, updatedAt) VALUES ('s1', '옛학생', 'x', 'x')").run();
  st.db.prepare("INSERT INTO docs (id, studentId, name, category, createdAt, updatedAt) VALUES ('d1','s1','출입국사실증명서(부)','','x','x'), ('d2','s1','재학증명서','','x','x'), ('d3','s1','추천서','','x','x')").run();
  st.db.prepare("INSERT INTO scores (id, studentId, kind, createdAt, updatedAt) VALUES ('c1','s1','IELTS','x','x')").run();
  st.db.prepare(`INSERT INTO files (id, studentId, category, name, memo, docId, scoreId, meetingId, createdAt, updatedAt) VALUES
    ('f1','s1','성적표','a.pdf','','','','','x','x'), ('f2','s1','학교 자료','b.pdf','2026','','','','x','x'), ('f3','s1','서류','c.pdf','','d1','','','x','x'),
    ('f4','s1','어학·표준화 점수','d.pdf','','','c1','','x','x'), ('f5','s1','미팅','e.png','','','','m1','x','x'), ('f6','s1','기타','g.pdf','','','','','x','x')`).run();
  st.db.prepare("DELETE FROM meta WHERE key = 'v17_doccats'").run();
  st.close();
  st = openStore(p);
  const cat = (t, id) => st.db.prepare(`SELECT category, memo FROM ${t} WHERE id = ?`).get(id);
  assert.deepStrictEqual(st.db.prepare("SELECT value FROM options WHERE kind = 'doccat' ORDER BY CAST(sortOrder AS INTEGER)").all().map((x) => x.value).slice(0, 3), ['재학증명서', '성적증명서', '졸업증명서']);
  assert.strictEqual(cat('docs', 'd1').category, '지원자격증빙(출입국·여권 등)');
  assert.strictEqual(cat('docs', 'd2').category, '재학증명서');
  assert.strictEqual(cat('docs', 'd3').category, '기타(학사일정표·고교 프로파일 등)');
  assert.strictEqual(cat('files', 'f1').category, '성적증명서');
  assert.deepStrictEqual(cat('files', 'f2'), { category: '기타(학사일정표·고교 프로파일 등)', memo: '학교 자료 · 2026' }, '예전 분류는 메모에');
  assert.strictEqual(cat('files', 'f3').category, '지원자격증빙(출입국·여권 등)', '서류 파일 = 서류 분류');
  assert.strictEqual(cat('files', 'f4').category, '어학증빙', 'IELTS 첨부 → 어학증빙');
  assert.strictEqual(cat('files', 'f5').category, '미팅', '미팅 첨부는 그대로');
  assert.deepStrictEqual(cat('files', 'f6'), { category: '기타(학사일정표·고교 프로파일 등)', memo: '' });
  st.close();

  const admin = client(); await admin.login('admin@revera.test', 'admin-pass-1');
  let d = await admin.saveOk('students', { name: '분류학생' });
  const sid = d.savedId;
  d = await admin.saveOk('docs', { studentId: sid, name: '여권 사본', category: '지원자격증빙(출입국·여권 등)', status: '요청 전' });
  const docId = d.savedId;
  let r = await admin.upload(sid, 'toefl.pdf', Buffer.from('%PDF t'), '어학증빙');
  assert.ok(r.data.files.some((f) => f.name === 'toefl.pdf' && f.category === '어학증빙'));
  r = await admin.upload(sid, 'x.pdf', Buffer.from('%PDF x'), '없는 분류');
  assert.ok(r.data.files.some((f) => f.name === 'x.pdf' && f.category === '기타(학사일정표·고교 프로파일 등)'), '목록에 없는 분류는 기타');
  const opt = (await admin.ok('getAll')).options.find((o) => o.kind === 'doccat' && o.value === '지원자격증빙(출입국·여권 등)');
  d = await admin.ok('saveOption', { id: opt.id, kind: 'doccat', value: '지원자격증빙' });
  assert.strictEqual(d.docs.find((x) => x.id === docId).category, '지원자격증빙');
});

test('부모님 확정은 지원대학에서: 체크하면 날짜·기록자, 전공 탭 확정 기록은 같은 대학·전공 지원대학으로 옮김', async () => {
  const admin = client(); await admin.login('admin@revera.test', 'admin-pass-1');
  let d = await admin.ok('getAll');
  const u = d.universities[0];
  d = await admin.saveOk('students', { name: '확정학생' });
  const sid = d.savedId;
  d = await admin.saveOk('apps', { studentId: sid, universityId: u.id, major: 'Psychology', status: '준비중', parentConfirmed: 'TRUE' });
  let a = d.apps.find((x) => x.id === d.savedId);
  assert.strictEqual(a.parentConfirmed, 'TRUE');
  assert.ok(a.parentConfirmedAt && a.parentConfirmedBy === 'admin@revera.test');
  d = await admin.saveOk('apps', { id: a.id, updatedAt: a.updatedAt, parentConfirmed: '' });
  a = d.apps.find((x) => x.id === a.id);
  assert.deepStrictEqual([a.parentConfirmed, a.parentConfirmedAt], ['', '']);

  const p = path.join(dir, 'v18.db');
  let st = openStore(p);
  st.db.prepare("INSERT INTO students (id, name, createdAt, updatedAt) VALUES ('s1', '옛학생', 'x', 'x')").run();
  st.db.prepare("INSERT INTO majorplans (id, studentId, universityId, major, status, parentConfirmed, parentConfirmedAt, parentConfirmedBy, createdAt, updatedAt) VALUES ('m1','s1','u1','Psychology','최종','TRUE','2026-10-01T10:00','k@x','x','x')").run();
  st.db.prepare("INSERT INTO apps (id, studentId, universityId, major, createdAt, updatedAt) VALUES ('a1','s1','u1',' psychology ','x','x'), ('a2','s1','u1','Law','x','x'), ('a3','s1','u2','Psychology','x','x')").run();
  st.db.prepare("DELETE FROM meta WHERE key = 'v18_app_parent'").run();
  st.close();
  st = openStore(p);
  assert.deepStrictEqual(st.db.prepare('SELECT id, parentConfirmed, parentConfirmedBy FROM apps ORDER BY id').all(),
    [{ id: 'a1', parentConfirmed: 'TRUE', parentConfirmedBy: 'k@x' }, { id: 'a2', parentConfirmed: '', parentConfirmedBy: '' }, { id: 'a3', parentConfirmed: '', parentConfirmedBy: '' }]);
  assert.strictEqual(st.db.prepare("SELECT parentConfirmed FROM majorplans WHERE id = 'm1'").get().parentConfirmed, 'TRUE', '전공 기록은 그대로');
  st.close();
});

test('학생 정보 정리: 영문 이름·영문 주소를 원서 정보에서 학생 칸으로, 추천서·온라인 코스는 메모로, 추천인 이메일 보냄 체크', async () => {
  const p = path.join(dir, 'v19.db');
  let st = openStore(p);
  st.db.prepare("INSERT INTO students (id, name, memo, recommenders, onlineCourse, createdAt, updatedAt) VALUES ('s1','옛학생','원래 메모','영어쌤 요청 완료','Coursera 3주차','x','x'), ('s2','둘째','','','','x','x')").run();
  st.db.prepare("UPDATE students SET englishName = 'ALREADY' WHERE id = 's2'").run();
  st.db.prepare(`INSERT INTO appinfo (id, studentId, universityId, item, content, createdAt, updatedAt) VALUES
    ('i1','s1','','영문 이름 (여권 기준)','HONG GILDONG','1','x'), ('i2','s1','','영문 주소','12 Main St','2','x'),
    ('i3','s1','u1','영문 이름 (여권 기준)','HKU용','3','x'), ('i4','s2','','영문 이름 (여권 기준)','OTHER','4','x'), ('i5','s1','','추천인 1','Mr. Kim','5','x')`).run();
  st.db.prepare("DELETE FROM meta WHERE key = 'v19_profile'").run();
  st.close();
  st = openStore(p);
  assert.deepStrictEqual(st.db.prepare("SELECT englishName, addressEn, memo, recommenders, onlineCourse FROM students WHERE id = 's1'").get(),
    { englishName: 'HONG GILDONG', addressEn: '12 Main St', memo: '원래 메모\n[추천서 진행] 영어쌤 요청 완료\n[온라인 코스] Coursera 3주차', recommenders: '', onlineCourse: '' });
  const live = st.db.prepare("SELECT id FROM appinfo WHERE deletedAt = '' ORDER BY id").all().map((x) => x.id);
  assert.deepStrictEqual(live, ['i3', 'i4', 'i5'], '대학별 항목·이미 값이 있는 학생·추천인은 그대로');
  st.close();

  const admin = client(); await admin.login('admin@revera.test', 'admin-pass-1');
  let d = await admin.saveOk('students', { name: '추천학생', englishName: 'KIM A', address: '서울', addressEn: 'Seoul' });
  const sid = d.savedId;
  assert.strictEqual(d.students.find((x) => x.id === sid).englishName, 'KIM A');
  d = await admin.saveOk('appinfo', { studentId: sid, item: '추천인 1', content: 'Ms. Lee' });
  let r = d.appinfo.find((x) => x.id === d.savedId);
  d = await admin.saveOk('appinfo', { id: r.id, updatedAt: r.updatedAt, sent: 'TRUE' });
  r = d.appinfo.find((x) => x.id === r.id);
  assert.ok(r.sent === 'TRUE' && r.sentAt && r.sentBy === 'admin@revera.test');
  d = await admin.saveOk('appinfo', { id: r.id, updatedAt: r.updatedAt, sent: '' });
  r = d.appinfo.find((x) => x.id === r.id);
  assert.deepStrictEqual([r.sent, r.sentAt], ['', '']);
});

test('v12 의견: 받은 연락 어머님, 학생 목록 칸(관리팀만·모두 같게), 대학 원서 접수 주소, 원장님 일정 가져오기는 누구나', async () => {
  const admin = client(); await admin.login('admin@revera.test', 'admin-pass-1');
  let d = await admin.saveOk('students', { name: '연락학생' });
  const sid = d.savedId;
  await admin.saveOk('followups', { studentId: sid, kind: 'contact', fromWho: '어머님', channel: '위챗', title: '질문', status: '할 일' });
  await admin.saveOk('followups', { studentId: sid, kind: 'contact', fromWho: '아버님', channel: '위챗', title: '질문2', status: '할 일' });

  d = await admin.ok('saveStudentCols', { cols: ['status', 'school', 'nope', 'status', 'hope'] });
  assert.deepStrictEqual(d.studentCols, ['status', 'school', 'hope'], '모르는 칸·중복은 빠짐');
  await admin.ok('saveTeacher', { email: 'v12-con@revera.test', name: '컨설C', role: 'consultant', password: '123456' });
  const con = client(); await con.login('v12-con@revera.test', '123456');
  assert.deepStrictEqual((await con.ok('getAll')).studentCols, ['status', 'school', 'hope'], '모두에게 같게');
  assert.strictEqual((await con.rpc('saveStudentCols', { cols: ['school'] })).status, 403);
  d = await admin.ok('saveStudentCols', { cols: null });
  assert.strictEqual(d.studentCols, null, '처음 상태로');

  const u = d.universities[0];
  d = await admin.ok('save', { table: 'universities', obj: { id: u.id, updatedAt: u.updatedAt, portalUrl: 'https://apply.example.edu/login' } });
  assert.strictEqual(d.universities.find((x) => x.id === u.id).portalUrl, 'https://apply.example.edu/login');
  assert.strictEqual((await admin.rpc('save', { table: 'universities', obj: { id: u.id, updatedAt: d.universities.find((x) => x.id === u.id).updatedAt, portalUrl: 'javascript:alert(1)' } })).status, 400);

  const r = await con.req('POST', '/api/schedule/refresh', {});
  assert.notStrictEqual(r.status, 403, '컨설턴트도 누를 수 있음');
  assert.ok(r.status === 200 || r.status === 400, JSON.stringify(r.data)); // 시트 설정이 없으면 400 + 안내
});

test('v13: 대학 정보 처음 요건 비우기(선생님이 고친 건 그대로), 대회·프로그램 첨부 파일, 학생 목록 새 칸', async () => {
  const p = path.join(dir, 'v20.db');
  let st = openStore(p);
  st.db.prepare(`INSERT INTO unicycles (id, universityId, year, requirements, memo, status, createdAt, createdBy, updatedAt, updatedBy) VALUES
    ('c1','u1','2027','[{"item":"IELTS","content":"6.5"}]','Compass 초기 자료(2026-10-16 조사). 공식 사이트에서 확인한 뒤 "확인 완료"로 바꿔주세요.\n마감 메모','확인 필요','x','system','x','system'),
    ('c2','u1','2028','[{"item":"PS","content":"선생님이 씀"}]','','확인 완료','x','system','y','kim@x')`).run();
  st.db.prepare("DELETE FROM meta WHERE key = 'v20_uni_reset'").run();
  st.close();
  st = openStore(p);
  assert.deepStrictEqual(st.db.prepare("SELECT id, requirements, memo FROM unicycles WHERE id IN ('c1','c2') ORDER BY id").all(), [
    { id: 'c1', requirements: '[]', memo: '마감 메모' }, { id: 'c2', requirements: '[{"item":"PS","content":"선생님이 씀"}]', memo: '' }]);
  st.close();

  const admin = client(); await admin.login('admin@revera.test', 'admin-pass-1');
  let d = await admin.ok('saveProgram', { name: '첨부 대회', category: '에세이 대회' });
  const pid = d.programs.find((x) => x.name === '첨부 대회').id;
  let r = await admin.req('POST', '/api/unifiles/upload?programId=' + pid, undefined, { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('요강.pdf') }, Buffer.from('%PDF guide'));
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const f = r.data.unifiles.find((x) => x.programId === pid);
  assert.ok(f && f.name === '요강.pdf' && !f.cycleId);
  assert.strictEqual((await admin.req('GET', '/api/unifiles/' + f.id)).status, 200);
  assert.ok(store.listFiles().some((x) => x.name === '요강.pdf' && /첨부 대회 \(대회·프로그램 자료\)/.test(x.studentName)), '드라이브 백업에 포함');
  assert.strictEqual((await admin.req('POST', '/api/unifiles/upload?programId=nope', undefined, { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'x.pdf' }, Buffer.from('%PDF'))).status, 404);
  d = await admin.ok('removeProgram', { id: pid });
  assert.ok(!d.unifiles.some((x) => x.programId === pid), '대회를 지우면 첨부도 함께');

  d = await admin.ok('saveStudentCols', { cols: ['contract', 'amount', 'unpaid', 'contractEnd', 'scores', 'appProgress', 'nextSched', 'curriculum', 'parentPhone', 'dob'] });
  assert.strictEqual(d.studentCols.length, 10);
  await admin.ok('saveStudentCols', { cols: null });
});
