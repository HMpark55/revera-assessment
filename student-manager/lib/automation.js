'use strict';
/**
 * 자동 백업(구글 드라이브) + 이메일 알림.
 * 둘 다 원장님 구글 계정에 설치한 Google Apps Script(웹 앱)로 보냄 — scripts/google-apps-script.gs
 *   백업: 매일 정해진 시각에 백업 ZIP을 "Compass 백업" 폴더에 저장 (최근 30개 유지)
 *   알림: 매일 아침 선생님마다 "오늘 챙길 일"(팔로업 기한·지원 마감)을 메일로 보냄
 * 시각은 중국 시간(UTC+8) 기준.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeZip } = require('./zip');

const TZ_OFFSET_H = 8; // 중국 표준시
const RESTORE_HELP = [
  'REVERA Compass 백업 복구 방법',
  '',
  '1. 서버를 멈춥니다.',
  '2. compass.db 를 DB_PATH 위치(Railway: /data/revera.db)에 같은 이름으로 덮어씁니다.',
  '3. files 폴더 안의 파일들을 DB_PATH 와 같은 폴더의 files 폴더(Railway: /data/files)에 넣습니다.',
  '4. 서버를 다시 시작합니다.',
  '',
  '파일목록.csv 에서 저장 이름과 학생/원래 파일 이름을 확인할 수 있습니다.',
].join('\r\n');

function localNow(d) { return new Date((d ? d.getTime() : Date.now()) + TZ_OFFSET_H * 3600000); }
function localDate(d) { return localNow(d).toISOString().slice(0, 10); }
function addDays(ymd, n) { const x = new Date(ymd + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }

/** 백업 ZIP 파일을 임시 폴더에 만든다 → { path, name, cleanup } */
async function buildBackupZip(store) {
  const stamp = localNow().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const tmpDb = path.join(os.tmpdir(), 'compass-backup-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db');
  const tmpZip = tmpDb.replace(/\.db$/, '.zip');
  const cleanup = () => { fs.unlink(tmpDb, () => {}); fs.unlink(tmpZip, () => {}); };
  try {
    await store.backup(tmpDb);
    const files = store.listFiles().filter((f) => fs.existsSync(path.join(store.filesDir, f.storedName)));
    const csvCell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const csv = '﻿' + [['저장 이름', '학생', '파일 이름', '분류', '올린 날짜', '휴지통']]
      .concat(files.map((f) => [f.storedName, f.studentName, f.name, f.category, f.createdAt.slice(0, 10), f.deletedAt ? 'Y' : '']))
      .map((r) => r.map(csvCell).join(',')).join('\r\n');
    writeZip(tmpZip, [
      { name: 'compass.db', path: tmpDb },
      { name: '파일목록.csv', data: Buffer.from(csv, 'utf8') },
      { name: '복구방법.txt', data: Buffer.from(RESTORE_HELP, 'utf8') },
    ].concat(files.map((f) => ({ name: 'files/' + f.storedName, path: path.join(store.filesDir, f.storedName) }))));
    return { path: tmpZip, name: 'compass-backup-' + stamp + '.zip', cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** Apps Script 웹 앱 호출 */
async function callScript(cfg, payload, fetchImpl) {
  if (!cfg.scriptUrl) throw new Error('Apps Script 주소가 설정되지 않았습니다.');
  let res;
  try {
    res = await (fetchImpl || fetch)(cfg.scriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ secret: cfg.secret }, payload)),
    redirect: 'follow',
    signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    throw new Error('Apps Script에 연결할 수 없습니다. 주소와 배포 상태를 확인하세요. (' + (e.name === 'TimeoutError' ? '응답 시간 초과' : e.message) + ')');
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error('Apps Script 응답을 읽을 수 없습니다 (HTTP ' + res.status + '). 배포 설정(액세스: 모든 사용자)을 확인하세요.');
  }
  if (!data.ok) throw new Error(data.error === 'secret' ? '비밀 키가 맞지 않습니다. Apps Script 코드의 SECRET 값을 다시 붙여넣으세요.' : (data.error || 'Apps Script 오류'));
  return data;
}

async function sendBackup(store, fetchImpl) {
  const cfg = store.getConfig();
  const z = await buildBackupZip(store);
  try {
    const data = fs.readFileSync(z.path).toString('base64');
    const r = await callScript(cfg, { action: 'backup', name: z.name, data }, fetchImpl);
    return { name: z.name, size: Math.round(data.length * 3 / 4), url: r.url || '' };
  } finally {
    z.cleanup();
  }
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const APP_FINAL = ['제출완료', '대기', '합격', '불합격', '철회'];

/** 선생님별 "오늘 챙길 일" 메일 내용 (보낼 것이 없는 사람은 제외) */
function buildDigests(store, today) {
  today = today || localDate();
  const cfg = store.getConfig();
  const site = cfg.siteUrl || '';
  const soon = addDays(today, 3), week = addDays(today, 7);
  const out = [];
  for (const t of store.listTeachers()) {
    if (!t.active || !t.notify) continue;
    const me = { email: t.email, name: t.name, role: t.role };
    const d = store.rpc.getAll(me); // 권한대로 보이는 데이터만
    const student = {}; d.students.forEach((s) => { student[s.id] = s; });
    const mine = (s) => s && (String(s.counselor || '').toLowerCase() === t.email || String(s.manager || '').toLowerCase() === t.email);
    const fu = d.followups.filter((f) => f.status !== '완료' && f.assignee === t.email && f.due && f.due <= soon && student[f.studentId])
      .sort((a, b) => a.due.localeCompare(b.due));
    const asked = d.followups.filter((f) => f.status !== '완료' && f.assignee === t.email && f.requestedBy && f.requestedBy !== t.email && student[f.studentId] && !fu.includes(f));
    const apps = d.apps.filter((a) => a.deadline && a.deadline >= today && a.deadline <= week && !APP_FINAL.includes(a.status) && mine(student[a.studentId]))
      .sort((a, b) => a.deadline.localeCompare(b.deadline));
    if (!fu.length && !apps.length && !asked.length) continue;
    const dd = (x) => { const n = Math.round((Date.parse(x) - Date.parse(today)) / 86400000); return n < 0 ? 'D+' + -n : n === 0 ? 'D-DAY' : 'D-' + n; };
    const over = fu.filter((f) => f.due < today).length;
    const subject = '[Compass] ' + today.slice(5).replace('-', '/') + ' 오늘 챙길 일 — 팔로업 ' + fu.length + (over ? '(기한 지남 ' + over + ')' : '') + ' · 지원 마감 ' + apps.length + (asked.length ? ' · 요청받은 일 ' + asked.length : '');
    const link = (sid) => site ? site + '/#/student/' + sid : '';
    const li = (title, sub, sid) => '<li style="margin:4px 0">' + (link(sid) ? '<a href="' + esc(link(sid)) + '">' + esc(title) + '</a>' : esc(title)) + (sub ? ' <span style="color:#666">' + esc(sub) + '</span>' : '') + '</li>';
    let html = '<div style="font-family:sans-serif;font-size:14px;color:#222">' + esc(t.name) + ' 선생님, 오늘 챙길 일입니다.<br>';
    let text = t.name + ' 선생님, 오늘 챙길 일입니다.\n';
    const nameOf = (email) => { const x = store.listTeachers().find((y) => y.email === email); return x ? x.name : email; };
    if (asked.length) {
      html += '<h3 style="color:#0B1B45;margin:16px 0 4px">요청받은 일 ' + asked.length + '건</h3><ul>' +
        asked.map((f) => li((student[f.studentId] || {}).name + ' — ' + f.title, nameOf(f.requestedBy) + ' 님 요청' + (f.due ? ' · 기한 ' + f.due : '') + (f.requestNote ? ' · ' + f.requestNote : ''), f.studentId)).join('') + '</ul>';
      text += '\n[요청받은 일]\n' + asked.map((f) => '- ' + (student[f.studentId] || {}).name + ' — ' + f.title + ' (' + nameOf(f.requestedBy) + ' 님 요청)').join('\n') + '\n';
    }
    if (fu.length) {
      html += '<h3 style="color:#0B1B45;margin:16px 0 4px">내 팔로업 (기한 지남·3일 이내) ' + fu.length + '건</h3><ul>' +
        fu.map((f) => li((student[f.studentId] || {}).name + ' — ' + f.title, '기한 ' + f.due + ' ' + dd(f.due), f.studentId)).join('') + '</ul>';
      text += '\n[내 팔로업]\n' + fu.map((f) => '- ' + (student[f.studentId] || {}).name + ' — ' + f.title + ' (기한 ' + f.due + ' ' + dd(f.due) + ')').join('\n') + '\n';
    }
    if (apps.length) {
      html += '<h3 style="color:#0B1B45;margin:16px 0 4px">담당 학생 지원 마감 (7일 이내) ' + apps.length + '건</h3><ul>' +
        apps.map((a) => li((student[a.studentId] || {}).name + ' — ' + a.university + (a.round ? ' ' + a.round : ''), a.deadline + ' ' + dd(a.deadline) + (a.status ? ' · ' + a.status : ''), a.studentId)).join('') + '</ul>';
      text += '\n[지원 마감]\n' + apps.map((a) => '- ' + (student[a.studentId] || {}).name + ' — ' + a.university + ' ' + (a.round || '') + ' (' + a.deadline + ' ' + dd(a.deadline) + ')').join('\n') + '\n';
    }
    if (site) { html += '<p><a href="' + esc(site) + '">Compass 열기 →</a></p>'; text += '\nCompass: ' + site + '\n'; }
    html += '<p style="color:#888;font-size:12px">알림을 그만 받으려면 관리자에게 “이메일 알림 끄기”를 요청하세요.</p></div>';
    out.push({ to: t.email, name: t.name, subject, html, text, counts: { followups: fu.length, apps: apps.length, requests: asked.length } });
  }
  return out;
}

async function sendDigests(store, today, fetchImpl) {
  const list = buildDigests(store, today);
  if (!list.length) return { sent: 0, note: '보낼 내용이 있는 선생님이 없습니다.' };
  const r = await callScript(store.getConfig(), { action: 'mail', messages: list.map((m) => ({ to: m.to, subject: m.subject, html: m.html, text: m.text })) }, fetchImpl);
  return { sent: r.sent || list.length, remaining: r.remaining };
}

/** 팔로업 요청 메일 (요청한 순간 받는 선생님에게). 알림이 꺼져 있거나 연결 전이면 보내지 않음 → { sent, reason } */
async function sendRequestMail(store, req, fetchImpl) {
  const cfg = store.getConfig();
  if (!cfg.scriptUrl || cfg.mailOn !== 'on') return { sent: false, reason: '이메일 알림이 꺼져 있어 메일은 보내지 않았습니다.' };
  if (!req.notify) return { sent: false, reason: req.toName + ' 님은 이메일 알림을 받지 않도록 설정되어 있습니다.' };
  const link = cfg.siteUrl ? cfg.siteUrl + '/#/student/' + req.studentId : '';
  const subject = '[Compass] ' + req.from + ' 님의 요청 — ' + req.student + ' · ' + req.title;
  const lines = [req.from + ' 님이 팔로업을 요청했습니다.', '', '학생: ' + req.student, '할 일: ' + req.title + (req.due ? ' (기한 ' + req.due + ')' : '')]
    .concat(req.note ? ['메모: ' + req.note] : []);
  const html = '<div style="font-family:sans-serif;font-size:14px;color:#222"><p>' + esc(req.from) + ' 님이 팔로업을 요청했습니다.</p><ul>' +
    '<li>학생: <b>' + esc(req.student) + '</b></li><li>할 일: <b>' + esc(req.title) + '</b>' + (req.due ? ' (기한 ' + esc(req.due) + ')' : '') + '</li>' +
    (req.note ? '<li>메모: ' + esc(req.note) + '</li>' : '') + '</ul>' + (link ? '<p><a href="' + esc(link) + '">학생 화면 열기 →</a></p>' : '') + '</div>';
  await callScript(cfg, { action: 'mail', messages: [{ to: req.to, subject, html, text: lines.join('\n') + (link ? '\n\n' + link : '') }] }, fetchImpl);
  return { sent: true };
}

async function sendTestMail(store, to, fetchImpl) {
  const cfg = store.getConfig();
  return callScript(cfg, { action: 'mail', messages: [{ to, subject: '[Compass] 테스트 메일', text: 'REVERA Compass 이메일 알림 테스트입니다.',
    html: '<p>REVERA Compass 이메일 알림 테스트입니다.</p>' + (cfg.siteUrl ? '<p><a href="' + esc(cfg.siteUrl) + '">Compass 열기 →</a></p>' : '') }] }, fetchImpl);
}

/** 정해진 시각이 지났고 오늘 아직 안 했으면 실행 (10분마다 호출) */
async function tick(store, opts) {
  opts = opts || {};
  const cfg = store.getConfig();
  if (!cfg.scriptUrl) return;
  const now = localNow(opts.now);
  const today = now.toISOString().slice(0, 10), hour = now.getUTCHours();
  const jobs = [
    ['backup', cfg.backupOn === 'on', Number(cfg.backupHour), async () => { const r = await sendBackup(store, opts.fetch); return '성공 · ' + r.name + ' (' + Math.round(r.size / 1024) + 'KB)'; }],
    ['digest', cfg.mailOn === 'on', Number(cfg.mailHour), async () => { const r = await sendDigests(store, today, opts.fetch); return '성공 · ' + (r.sent ? r.sent + '명에게 보냄' : r.note); }],
  ];
  for (const [kind, on, h, run] of jobs) {
    if (!on || hour < h || store.getMeta('run.' + kind + '.date') === today) continue;
    try {
      store.recordRun(kind, await run(), today);
    } catch (e) {
      // 백업은 실패하면 10분 뒤 다시 시도. 메일은 일부만 나갔을 수 있어 같은 날 다시 보내지 않음
      store.recordRun(kind, '실패 · ' + e.message, kind === 'digest' ? today : '');
    }
  }
}

function startScheduler(store) {
  const run = () => tick(store).catch((e) => console.error('자동 작업 오류:', e));
  setTimeout(run, 30000);
  return setInterval(run, 10 * 60000);
}

module.exports = { buildBackupZip, callScript, sendBackup, buildDigests, sendDigests, sendTestMail, sendRequestMail, tick, startScheduler, localDate, RESTORE_HELP };
