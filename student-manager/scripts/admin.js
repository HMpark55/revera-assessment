'use strict';
/**
 * 서버 콘솔용 관리 명령
 *   npm run admin -- create <이메일> <이름> <비밀번호>   관리자 계정 생성 (이미 있으면 관리자 권한 + 비밀번호 재설정)
 *   npm run admin -- list                                계정 목록
 */
const path = require('path');
const fs = require('fs');
const { openStore } = require('../lib/store');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'revera.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const store = openStore(dbPath);
const [cmd, ...args] = process.argv.slice(2);

try {
  if (cmd === 'create') {
    const [email, name, password] = args;
    if (!email || !password) throw new Error('사용법: npm run admin -- create <이메일> <이름> <비밀번호>');
    store.upsertAdmin(email, name, password);
    console.log('완료: ' + email + ' (관리자)');
  } else if (cmd === 'list') {
    console.table(store.db.prepare('SELECT email, name, role, active, mustChangePassword FROM teachers').all());
  } else {
    console.log('명령: create <이메일> <이름> <비밀번호> | list');
  }
} catch (e) {
  console.error('오류: ' + e.message);
  process.exitCode = 1;
} finally {
  store.close();
}
