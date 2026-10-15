'use strict';
// npm test — 실제 HTTP로 서버 기능 검증 (임시 DB 사용)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../lib/store');
const { createApp } = require('../server');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revera-test-'));
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
  async function req(method, url, body, headers) {
    const res = await fetch(base + url, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-Requested-With': 'revera', Cookie: cookie }, headers || {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  return {
    req,
    login: (email, password) => req('POST', '/api/login', { email, password }),
    rpc: (fn, arg) => req('POST', '/api/rpc/' + fn, { arg }),
    async ok(fn, arg) { const r = await this.rpc(fn, arg); assert.strictEqual(r.status, 200, fn + ': ' + JSON.stringify(r.data)); return r.data; },
  };
}

test('로그인 없이는 접근 불가, 잘못된 비밀번호 거부', async () => {
  const c = client();
  assert.strictEqual((await c.rpc('getAll')).status, 401);
  assert.strictEqual((await c.login('admin@revera.test', 'wrong')).status, 401);
  assert.strictEqual((await c.login('nobody@revera.test', 'whatever1')).status, 401);
  const r = await c.login('ADMIN@revera.test', 'admin-pass-1');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  const d = await c.ok('getAll');
  assert.strictEqual(d.me.role, 'admin');
  assert.ok(!JSON.stringify(d).includes('passwordHash'), '비밀번호 해시는 화면으로 내려가지 않음');
});

test('상태 확인 엔드포인트', async () => {
  const r = await client().req('GET', '/healthz');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data, { ok: true });
});

test('CSRF 헤더 없는 요청 차단', async () => {
  const c = client();
  await c.login('admin@revera.test', 'admin-pass-1');
  const r = await c.req('POST', '/api/rpc/getAll', {}, { 'X-Requested-With': '' });
  assert.strictEqual(r.status, 403);
});

test('로그인 5회 실패 시 잠금', async () => {
  const c = client();
  for (let i = 0; i < 5; i++) await c.login('lock@revera.test', 'bad-password');
  assert.strictEqual((await c.login('lock@revera.test', 'bad-password')).status, 429);
});

test('학생·상담기록·지원대학 + 동시 수정 충돌 + 선생님 권한', async () => {
  const admin = client();
  await admin.login('admin@revera.test', 'admin-pass-1');

  assert.strictEqual((await admin.rpc('saveStudent', { name: '  ' })).status, 400);
  let d = await admin.ok('saveStudent', { name: '김학생', school: 'SIS', parentPhone: '010-1234-5678',
    memo: '=HYPERLINK("x") <script>', createdBy: 'hacker', bogus: 1, counselor: 'Admin@Revera.test' });
  const s = d.students[0];
  assert.strictEqual(s.memo, '=HYPERLINK("x") <script>');
  assert.strictEqual(s.createdBy, 'admin@revera.test');
  assert.strictEqual(s.counselor, 'admin@revera.test');
  assert.ok(!('bogus' in s));

  d = await admin.ok('saveStudent', { id: s.id, updatedAt: s.updatedAt, name: '김학생', grade: 'G11' });
  assert.strictEqual(d.students[0].grade, 'G11');
  assert.strictEqual(d.students[0].school, 'SIS', '보내지 않은 필드는 유지');
  const conflict = await admin.rpc('saveStudent', { id: s.id, updatedAt: s.updatedAt, name: '덮어쓰기' });
  assert.strictEqual(conflict.status, 409);
  assert.match(conflict.data.error, /박원장 님이 먼저 수정/);

  assert.strictEqual((await admin.rpc('saveNote', { studentId: 'nope', content: 'x' })).status, 400);
  d = await admin.ok('saveNote', { studentId: s.id, date: '2026-10-15', type: '대면상담', content: '첫 상담\n여러 줄', nextAction: '에세이 초안' });
  const n = d.notes[0];
  assert.strictEqual(n.author, 'admin@revera.test');
  d = await admin.ok('saveNote', Object.assign({}, n, { done: true }));
  assert.strictEqual(d.notes[0].done, 'TRUE');
  d = await admin.ok('saveApp', { studentId: s.id, university: 'Stanford', round: 'REA', deadline: '2026-11-01', status: '준비중' });
  d = await admin.ok('saveApp', { studentId: s.id, university: 'MIT' });
  d = await admin.ok('deleteApp', d.apps.find((a) => a.university === 'MIT').id);
  assert.strictEqual(d.apps.length, 1);

  // 선생님 추가 — 임시 비밀번호 필수
  assert.strictEqual((await admin.rpc('saveTeacher', { email: 't1@revera.test', name: '김선생' })).status, 400);
  await admin.ok('saveTeacher', { email: 'T1@revera.test', name: '김선생', role: 'teacher', password: 'temp-pass-1' });
  assert.strictEqual((await admin.rpc('saveTeacher', { email: 'admin@revera.test', role: 'teacher' })).status, 400);

  // 선생님: 첫 로그인 시 비밀번호 변경 강제
  const t1 = client();
  assert.strictEqual((await t1.login('t1@revera.test', 'temp-pass-1')).status, 200);
  assert.strictEqual((await t1.ok('getAll')).me.mustChangePassword, true);
  assert.strictEqual((await t1.rpc('saveNote', { studentId: s.id, content: 'x' })).status, 403);
  assert.strictEqual((await t1.rpc('changePassword', { current: 'wrong', next: 'my-own-pass' })).status, 400);
  assert.strictEqual((await t1.rpc('changePassword', { current: 'temp-pass-1', next: 'short' })).status, 400);
  d = await t1.ok('changePassword', { current: 'temp-pass-1', next: 'my-own-pass' });
  assert.strictEqual(d.me.mustChangePassword, false);

  // 일반 선생님 권한
  d = await t1.ok('saveNote', { studentId: s.id, date: '2026-10-16', type: '전화', content: '학부모 통화' });
  assert.strictEqual(d.notes.length, 2);
  assert.strictEqual((await t1.rpc('deleteStudent', s.id)).status, 403);
  assert.strictEqual((await t1.rpc('saveTeacher', { email: 'x@y.z', password: '12345678' })).status, 403);
  assert.strictEqual((await t1.req('GET', '/api/backup')).status, 403);
  assert.strictEqual((await t1.rpc('constructor')).status, 404);

  // 비활성화하면 즉시 로그아웃 + 재로그인 불가
  await admin.ok('saveTeacher', { email: 't1@revera.test', name: '김선생', role: 'teacher', active: false });
  assert.strictEqual((await t1.rpc('getAll')).status, 401);
  assert.strictEqual((await t1.login('t1@revera.test', 'my-own-pass')).status, 401);

  // 관리자 백업
  const b = await admin.req('GET', '/api/backup');
  assert.strictEqual(b.status, 200);
  assert.match(b.headers.get('content-disposition'), /revera-backup-\d+\.db/);

  // 학생 삭제 시 상담기록·지원대학 함께 삭제, 변경로그 기록
  d = await admin.ok('deleteStudent', s.id);
  assert.strictEqual(d.students.length + d.notes.length + d.apps.length, 0);
  assert.ok(store.db.prepare('SELECT COUNT(*) n FROM log').get().n > 10);

  // 로그아웃
  await admin.req('POST', '/api/logout');
  assert.strictEqual((await admin.rpc('getAll')).status, 401);
});
