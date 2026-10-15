'use strict';
/**
 * REVERA Compass (학생관리) — 웹 서버
 *   npm start                (기본 포트 3000, DB 파일 ./data/revera.db)
 * 환경변수: PORT, DB_PATH, ADMIN_EMAIL / ADMIN_PASSWORD(최초 실행 시 관리자 생성),
 *           TRUST_PROXY=1 (HTTPS 프록시 뒤에서 실행할 때), COOKIE_SECURE=1 (HTTPS 전용 쿠키)
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore, UserError } = require('./lib/store');

const COOKIE = 'revera_sid';

function createApp(store, opts) {
  opts = opts || {};
  const app = express();
  if (opts.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    next();
  });
  app.use(express.json({ limit: '1mb' }));

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
      if (e instanceof UserError) return res.status(e.status).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: '서버 오류가 발생했습니다. 잠시 후 다시 시도하세요.' });
    }
  });

  // 관리자: DB 백업 파일 다운로드
  app.get('/api/backup', requireLogin, async (req, res) => {
    if (req.me.role !== 'admin') return res.status(403).json({ error: '관리자만 백업할 수 있습니다.' });
    const tmp = path.join(os.tmpdir(), 'compass-backup-' + Date.now() + '.db');
    try {
      await store.backup(tmp);
      const stamp = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
      res.download(tmp, 'compass-backup-' + stamp + '.db', () => fs.unlink(tmp, () => {}));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: '백업에 실패했습니다.' });
    }
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
  createApp(store, { trustProxy: !!process.env.TRUST_PROXY, cookieSecure: !!process.env.COOKIE_SECURE })
    .listen(port, () => console.log(`REVERA Compass 실행 중: http://localhost:${port}  (DB: ${dbPath})`));
}

module.exports = { createApp };
