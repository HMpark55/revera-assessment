'use strict';
/**
 * REVERA Compass (학생관리) — 웹 서버
 *   npm start                (기본 포트 3000, DB 파일 ./data/revera.db)
 * 환경변수: PORT, DB_PATH, ADMIN_EMAIL / ADMIN_PASSWORD(최초 실행 시 관리자 생성),
 *           TRUST_PROXY=1 (HTTPS 프록시 뒤에서 실행할 때), COOKIE_SECURE=1 (HTTPS 전용 쿠키)
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { openStore, UserError, MAX_UPLOAD } = require('./lib/store');
const automation = require('./lib/automation');

const COOKIE = 'revera_sid';

function createApp(store, opts) {
  opts = opts || {};
  const app = express();
  if (opts.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // 화면 코드가 바뀌면(새 배포) 열려 있는 화면이 알 수 있도록 버전 표시
  let appVersion = '';
  try { appVersion = require('crypto').createHash('sha1').update(fs.readFileSync(path.join(__dirname, 'public', 'index.html'))).digest('hex').slice(0, 12); } catch (e) { appVersion = ''; }
  app.use((req, res, next) => {
    if (appVersion) res.set('X-App-Version', appVersion);
    res.set({
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    next();
  });
  // 가져오기 파일(회의록 첨부 이미지 포함)은 크기가 커서 따로 허용
  app.use('/api/rpc/importData', express.json({ limit: '60mb' }));
  app.use(express.json({ limit: '5mb' }));

  // 클라우드 상태 확인용 (DB 연결까지 확인)
  app.get('/healthz', (req, res) => {
    try { store.countTeachers(); res.json({ ok: true }); } catch (e) { res.status(503).json({ ok: false }); }
  });

  const readCookie = (req) => {
    const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : '';
  };
  const setCookie = (req, res, value, maxAgeSec) => {
    const secure = opts.cookieSecure || req.secure;
    res.set('Set-Cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}` +
      (secure ? '; Secure' : ''));
  };

  // 다른 사이트에서 몰래 보내는 요청(CSRF) 차단: 이 사이트의 화면만 이 헤더를 붙임
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.get('X-Requested-With') !== 'revera') {
      return res.status(403).json({ error: '허용되지 않은 요청입니다.' });
    }
    next();
  });

  /* ---- 로그인 시도 제한: 같은 IP+이메일로 15분에 5번 실패하면 15분 잠금 ---- */
  const fails = new Map();
  const WINDOW = 15 * 60 * 1000;
  const failKey = (req, email) => req.ip + '|' + String(email || '').toLowerCase();

  app.post('/api/login', (req, res) => {
    const { email, password } = req.body || {};
    const key = failKey(req, email);
    const f = fails.get(key);
    if (f && f.count >= 5 && Date.now() - f.first < WINDOW) {
      return res.status(429).json({ error: '로그인 실패가 반복되어 15분간 잠겼습니다. 잠시 후 다시 시도하세요.' });
    }
    const token = store.login(email, password);
    if (!token) {
      const cur = f && Date.now() - f.first < WINDOW ? f : { count: 0, first: Date.now() };
      cur.count++;
      fails.set(key, cur);
      return res.status(401).json({ error: '이메일 또는 비밀번호가 맞지 않습니다. (비활성 계정일 수도 있습니다)' });
    }
    fails.delete(key);
    setCookie(req, res, token, 14 * 86400);
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    store.logout(readCookie(req));
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  const requireLogin = (req, res, next) => {
    const me = store.authenticate(readCookie(req));
    if (!me) return res.status(401).json({ error: '로그인이 필요합니다.', needLogin: true });
    req.me = me;
    next();
  };

  // 팔로업 요청: 담당자를 바꾸고, 이메일 알림이 켜져 있으면 받는 선생님에게 바로 메일 (메일 실패해도 요청은 저장됨)
  app.post('/api/rpc/requestFollowup', requireLogin, async (req, res) => {
    if (req.me.mustChangePassword) return res.status(403).json({ error: '먼저 비밀번호를 변경해주세요.' });
    let data;
    try { data = store.rpc.requestFollowup(req.me, (req.body || {}).arg); } catch (e) { return sendError(res, e); }
    const r = data.request;
    delete data.request;
    try {
      const m = await automation.sendRequestMail(store, r, opts.fetch);
      data.mail = m.sent ? { sent: true, note: r.toName + ' 님에게 메일을 보냈습니다.' } : { sent: false, note: m.reason };
    } catch (e) {
      data.mail = { sent: false, note: '요청은 저장했지만 메일은 보내지 못했습니다. (' + e.message + ')' };
    }
    res.json(data);
  });

  // 화면에서 호출하는 기능들: POST /api/rpc/<기능이름>  { arg: ... }
  app.post('/api/rpc/:fn', requireLogin, (req, res) => {
    const fn = store.rpc[req.params.fn];
    if (!Object.prototype.hasOwnProperty.call(store.rpc, req.params.fn)) return res.status(404).json({ error: '없는 기능입니다.' });
    // 임시 비밀번호 상태에서는 비밀번호 변경과 조회만 허용
    if (req.me.mustChangePassword && !['getAll', 'changePassword'].includes(req.params.fn)) {
      return res.status(403).json({ error: '먼저 비밀번호를 변경해주세요.' });
    }
    try {
      res.json(fn(req.me, (req.body || {}).arg));
    } catch (e) {
      sendError(res, e);
    }
  });

  const sendError = (res, e) => {
    if (e instanceof UserError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: '서버 오류가 발생했습니다. 잠시 후 다시 시도하세요.' });
  };

  // 파일 업로드: POST /api/files/upload?studentId=..&category=..  (본문 = 파일 그대로, X-File-Name 헤더 = 파일명)
  app.post('/api/files/upload', requireLogin,
    express.raw({ type: () => true, limit: MAX_UPLOAD + 1024 }),
    (req, res) => {
      if (req.me.mustChangePassword) return res.status(403).json({ error: '먼저 비밀번호를 변경해주세요.' });
      try {
        let name = '';
        try { name = decodeURIComponent(req.get('X-File-Name') || ''); } catch (e) { name = ''; }
        res.json(store.addFile(req.me, { studentId: req.query.studentId, category: req.query.category, docId: req.query.docId, meetingId: req.query.meetingId, followupId: req.query.followupId, scoreId: req.query.scoreId, name,
          buffer: Buffer.isBuffer(req.body) ? req.body : null }));
      } catch (e) {
        sendError(res, e);
      }
    });

  // 대학 자료 파일(모집요강 등) 올리기: POST /api/unifiles/upload?cycleId=..&category=..
  app.post('/api/unifiles/upload', requireLogin,
    express.raw({ type: () => true, limit: MAX_UPLOAD + 1024 }),
    (req, res) => {
      if (req.me.mustChangePassword) return res.status(403).json({ error: '먼저 비밀번호를 변경해주세요.' });
      try {
        let name = '';
        try { name = decodeURIComponent(req.get('X-File-Name') || ''); } catch (e) { name = ''; }
        res.json(store.addUniFile(req.me, { cycleId: req.query.cycleId, programId: req.query.programId, category: req.query.category, name, buffer: Buffer.isBuffer(req.body) ? req.body : null }));
      } catch (e) {
        sendError(res, e);
      }
    });
  app.get('/api/unifiles/:id', requireLogin, (req, res) => {
    try {
      const f = store.getUniFile(req.me, req.params.id);
      res.set({
        'Content-Type': f.mime,
        'Content-Disposition': (req.query.download ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(f.name),
        'Content-Security-Policy': 'sandbox',
      });
      res.sendFile(f.path, (err) => { if (err && !res.headersSent) res.status(404).json({ error: '파일이 서버에 없습니다.' }); });
    } catch (e) {
      sendError(res, e);
    }
  });

  // 파일 보기/다운로드 (로그인 + 담당 학생 권한 확인)
  app.get('/api/files/:id', requireLogin, (req, res) => {
    try {
      const f = store.getFile(req.me, req.params.id);
      res.set({
        'Content-Type': f.mime,
        'Content-Disposition': (req.query.download ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(f.name),
        // 업로드된 파일이 이 사이트 권한으로 스크립트를 실행하지 못하게 격리
        'Content-Security-Policy': 'sandbox',
      });
      res.sendFile(f.path, (err) => { if (err && !res.headersSent) res.status(404).json({ error: '파일이 서버에 없습니다.' }); });
    } catch (e) {
      sendError(res, e);
    }
  });

  // 업로드 용량 초과 등 본문 처리 오류
  app.use('/api', (err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: '파일은 20MB 이하만 올릴 수 있습니다.' });
    next(err);
  });

  // 관리자: 백업 ZIP 으로 복구 — ① 지금 상태를 자동 백업(최근 2개 보관) ② 기록(DB)을 통째로 교체 ③ ZIP 안 업로드 파일을 files 폴더에
  const restoreDir = () => path.join(path.dirname(store.dbPath), 'restore-backups');
  app.post('/api/restore', requireLogin, express.raw({ type: () => true, limit: '400mb' }), async (req, res) => {
    if (req.me.role !== 'admin') return res.status(403).json({ error: '관리자만 복구할 수 있습니다.' });
    const os = require('os');
    const tmpDb = path.join(os.tmpdir(), 'compass-restore-' + Date.now() + '.db');
    try {
      const { readZip } = require('./lib/zip');
      let entries;
      try { entries = readZip(req.body); } catch (e) { throw new UserError(e.message + ' Compass 백업 ZIP 파일을 골라주세요.'); }
      const dbEntry = entries.find((e) => e.name === 'compass.db');
      if (!dbEntry) throw new UserError('ZIP 안에 compass.db 가 없습니다. Compass 백업 ZIP 파일을 골라주세요.');
      // ① 복구 직전 상태 자동 백업
      const dir = restoreDir();
      fs.mkdirSync(dir, { recursive: true });
      const z = await automation.buildBackupZip(store, true);
      const before = 'before-restore-' + new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16).replace(/[-:T]/g, '') + '.zip';
      try { fs.copyFileSync(z.path, path.join(dir, before)); } finally { z.cleanup(); }
      fs.readdirSync(dir).filter((f) => /^before-restore-.*\.zip$/.test(f)).sort().reverse().slice(2).forEach((f) => fs.rmSync(path.join(dir, f), { force: true })); // 볼륨이 작아서 최근 2개만
      // ② 기록 교체
      fs.writeFileSync(tmpDb, dbEntry.read());
      const counts = store.restoreFromDb(req.me, tmpDb);
      // ③ 업로드 파일
      let files = 0;
      for (const e of entries) {
        const m = /^files\/([^/\\]+)$/.exec(e.name);
        if (!m || m[1].startsWith('.')) continue;
        fs.writeFileSync(path.join(store.filesDir, m[1]), e.read());
        files++;
      }
      res.json({ ok: true, students: counts.students, filesInDb: counts.files, filesWritten: files, before });
    } catch (e) {
      if (e instanceof UserError) return sendError(res, e);
      console.error(e);
      res.status(500).json({ error: '복구에 실패했습니다: ' + e.message });
    } finally {
      fs.rm(tmpDb, { force: true }, () => {});
    }
  });
  // 복구 직전 자동 백업 목록·내려받기 (관리자)
  app.get('/api/restore-backups', requireLogin, (req, res) => {
    if (req.me.role !== 'admin') return res.status(403).json({ error: '관리자만 볼 수 있습니다.' });
    let list = [];
    try { list = fs.readdirSync(restoreDir()).filter((f) => /^before-restore-.*\.zip$/.test(f)).sort().reverse().map((f) => ({ name: f, size: fs.statSync(path.join(restoreDir(), f)).size })); } catch (e) { /* 아직 없음 */ }
    res.json({ list });
  });
  app.get('/api/restore-backups/:name', requireLogin, (req, res) => {
    if (req.me.role !== 'admin') return res.status(403).json({ error: '관리자만 받을 수 있습니다.' });
    const name = String(req.params.name);
    if (!/^before-restore-\d+\.zip$/.test(name)) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    const full = path.join(restoreDir(), name);
    if (!fs.existsSync(full)) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    res.download(full, name);
  });

  // 관리자: 백업 다운로드 (ZIP = DB 파일 + 업로드한 파일 전체 + 파일 목록, ?mode=db 면 파일 제외)
  app.get('/api/backup', requireLogin, async (req, res) => {
    if (req.me.role !== 'admin') return res.status(403).json({ error: '관리자만 백업할 수 있습니다.' });
    let z;
    try {
      z = await automation.buildBackupZip(store, req.query.mode !== 'db');
      res.download(z.path, z.name, z.cleanup);
    } catch (e) {
      if (z) z.cleanup();
      console.error(e);
      res.status(500).json({ error: '백업에 실패했습니다.' });
    }
  });

  // 관리자: 구글 계정에 붙여넣을 Apps Script 코드 (비밀 키가 들어간 상태)
  app.get('/api/automation/script', requireLogin, (req, res) => {
    if (req.me.role !== 'admin') return res.status(403).json({ error: '관리자만 볼 수 있습니다.' });
    const code = fs.readFileSync(path.join(__dirname, 'scripts', 'google-apps-script.gs'), 'utf8');
    res.type('text/plain').send(code.replace('__COMPASS_SECRET__', store.getConfig().secret || '(먼저 설정을 저장하세요)'));
  });

  // 관리자: 자동 백업·이메일 알림 — 연결 확인, 지금 백업, 테스트 메일, 오늘 알림 미리보기/보내기
  // 메인 달력 "↻ 원장님 일정 가져오기": 시트를 읽기만 하므로 모든 선생님, 너무 자주 누르면 잠시 기다리게
  let schedAt = 0;
  app.post('/api/schedule/refresh', requireLogin, async (req, res) => {
    if (Date.now() - schedAt < 30000) return res.status(429).json({ error: '방금 가져왔습니다. 30초 뒤에 다시 눌러주세요.' });
    schedAt = Date.now();
    try { const r = await automation.syncSchedule(store, opts.fetch, true); res.json({ saved: r.saved }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/automation/:action', requireLogin, async (req, res) => {
    if (req.me.role !== 'admin') return res.status(403).json({ error: '관리자만 할 수 있습니다.' });
    const f = opts.fetch;
    try {
      const a = req.params.action;
      if (a === 'ping') return res.json(await automation.callScript(store.getConfig(), { action: 'ping' }, f));
      if (a === 'backup') {
        const r = await automation.sendBackup(store, f);
        store.recordRun('backup', '성공(수동) · ' + r.name + ' (' + Math.round(r.size / 1024) + 'KB)');
        return res.json(r);
      }
      if (a === 'filesync') return res.json(await automation.runFileSync(store, f, true));
      if (a === 'schedule') return res.json(await automation.syncSchedule(store, f, true));
      if (a === 'testmail') return res.json(await automation.sendTestMail(store, req.me.email, f));
      if (a === 'preview') return res.json({ digests: automation.buildDigests(store).map((m) => ({ to: m.to, name: m.name, subject: m.subject, html: m.html, counts: m.counts })) });
      if (a === 'digest') {
        const r = await automation.sendDigests(store, automation.localDate(), f);
        store.recordRun('digest', '성공(수동) · ' + (r.sent ? r.sent + '명에게 보냄' : r.note));
        return res.json(r);
      }
      res.status(404).json({ error: '없는 기능입니다.' });
    } catch (e) {
      if (e instanceof UserError) return sendError(res, e);
      res.status(502).json({ error: e.message || '실패했습니다.' });
    }
  });

  // 대학 지도 도구(Leaflet)·세계 지도 윤곽(Natural Earth) — 바뀌지 않는 파일이라 압축해서 보내고 브라우저에 30일 보관 (바꾸면 화면의 ?v= 를 올림)
  const VENDOR = { '/world.json': 'application/json; charset=utf-8', '/leaflet/leaflet.js': 'text/javascript; charset=utf-8', '/leaflet/leaflet.css': 'text/css; charset=utf-8' };
  const vendorGz = {};
  app.use('/vendor', (req, res, next) => {
    const type = VENDOR[req.path] || (/^\/world10\/\d{1,2}_\d{1,2}\.json$/.test(req.path) && fs.existsSync(path.join(__dirname, 'public', 'vendor', req.path)) ? VENDOR['/world.json'] : ''); // world10 = 확대했을 때 받는 지역 조각
    if (!type || req.method !== 'GET') return next();
    if (!vendorGz[req.path]) vendorGz[req.path] = require('zlib').gzipSync(fs.readFileSync(path.join(__dirname, 'public', 'vendor', req.path)));
    res.set({ 'Content-Type': type, 'Cache-Control': 'public, max-age=2592000, immutable', Vary: 'Accept-Encoding' });
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return res.set('Content-Encoding', 'gzip').send(vendorGz[req.path]);
    res.send(require('zlib').gunzipSync(vendorGz[req.path]));
  });
  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
  return app;
}

if (require.main === module) {
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'revera.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = openStore(dbPath);

  if (store.countTeachers() === 0) {
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
      store.upsertAdmin(process.env.ADMIN_EMAIL, process.env.ADMIN_NAME, process.env.ADMIN_PASSWORD);
      console.log('관리자 계정을 만들었습니다: ' + process.env.ADMIN_EMAIL);
    } else {
      console.log('⚠ 아직 계정이 없습니다. 다음 명령으로 관리자를 만드세요:\n' +
        '   npm run admin -- create <이메일> <이름> <비밀번호>');
    }
  }

  const port = Number(process.env.PORT) || 3000;
  automation.startScheduler(store);
  createApp(store, { trustProxy: !!process.env.TRUST_PROXY, cookieSecure: !!process.env.COOKIE_SECURE })
    .listen(port, () => console.log(`REVERA Compass 실행 중: http://localhost:${port}  (DB: ${dbPath})`));
}

module.exports = { createApp };
