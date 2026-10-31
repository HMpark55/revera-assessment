'use strict';
/**
 * REVERA-TRACK (학원 SAT 모의고사 시스템, Score-Track) 읽기 전용 연동 — 수업 케어(시험 중)
 *   로그인: POST /tower/auth/login {email, password} → 쿠키
 *   학생 제출 목록: POST /tower/m/students/submissions/loadtests {sid, isWorkbook, perpage, offset}
 *   시험 결과(문항별 정답·유형·환산표): POST /tower/t/results/load {scheduledTestId}
 * 계정은 서버 환경변수 TRACK_EMAIL·TRACK_PASSWORD (코드에 넣지 않음). 저장·배정 같은 요청은 보내지 않음.
 * 점수: 모듈 점수 = 환산표(틀린 개수 → 점수, 최대 400), 영역 점수 = 모듈 점수 합 (실제 SAT와 같은 기준).
 */
const BASE = (process.env.TRACK_URL || 'https://www.revera-track.com').replace(/\/$/, '');
let cookie = '';

class TrackError extends Error { constructor(msg) { super(msg); this.status = 502; } }

function keepCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const kv = c.split(';')[0], name = kv.split('=')[0];
    cookie = cookie.split('; ').filter((x) => x && !x.startsWith(name + '=')).concat([kv]).join('; ');
  }
}
async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json;charset=UTF-8', accept: 'application/json, text/plain, */*', cookie },
    body: JSON.stringify(body),
  });
  keepCookies(res);
  const text = await res.text();
  try { return JSON.parse(text.trim()); } catch (e) { return null; } // 로그인이 풀리면 JSON 대신 화면(HTML)이 옴
}
async function login() {
  const email = process.env.TRACK_EMAIL, password = process.env.TRACK_PASSWORD;
  if (!email || !password) throw new TrackError('서버 설정에 track 계정(TRACK_EMAIL·TRACK_PASSWORD)이 없습니다.');
  cookie = '';
  const first = await fetch(BASE + '/tower/auth/login/needed', { signal: AbortSignal.timeout(20000) }); keepCookies(first); await first.text();
  const r = await post('/tower/auth/login', { email, password });
  if (!r || !r.logged_in) throw new TrackError('track 로그인에 실패했습니다. 계정·비밀번호를 확인하세요.');
}
/** 로그인이 풀려 있으면 한 번 다시 로그인 */
async function call(path, body, okKey) {
  if (!cookie) await login();
  let r = await post(path, body);
  if (!r || !(okKey in r)) { await login(); r = await post(path, body); }
  if (!r || !(okKey in r)) throw new TrackError('track에서 결과를 받지 못했습니다 (' + path + ').');
  return r;
}
async function studentTests(sid) {
  const out = [];
  for (let offset = 0; offset < 300; offset += 100) {
    const r = await call('/tower/m/students/submissions/loadtests', { sid: Number(sid), isWorkbook: 0, perpage: 100, offset }, 'test_data');
    out.push(...r.test_data);
    if (r.test_data.length < 100) break;
  }
  return out;
}
async function testResult(id) { return call('/tower/t/results/load', { scheduledTestId: Number(id) }, 'answer_sets'); }

/** 틀린 개수 → 모듈 점수 (환산표) */
function scaled(result, missed) {
  try {
    const t = JSON.parse((result.scaled_data && result.scaled_data.json_data) || '[]');
    const row = t.find((x) => Number(x.m) === missed);
    return row ? Number(row.s) : null;
  } catch (e) { return null; }
}
/** 한 모듈에서 이 학생의 결과: 맞은·틀린·안 푼 개수, 점수, 틀린 문제 유형 */
function moduleOf(result, sid) {
  const sets = (result.answer_sets || []).filter((a) => String(a.student_id) === String(sid)).sort((a, b) => String(b.submitted).localeCompare(String(a.submitted)));
  const a = sets[0]; if (!a) return null;
  const qt = {}; (result.questions || []).forEach((q) => { if (q.qt_ignored !== '1') qt[q.id] = q.qt_title || q.qt_short_title || ''; });
  const wrong = {};
  (result.whodidwhat || []).forEach((q) => {
    if (q.ignored === '1') return;
    const me = (q.whodidwhat || []).find((w) => String(w.answer_set_id) === String(a.answer_set_id));
    if (me && me.is_correct === '1') return; // 답이 없으면 안 푼 문제 → 틀린 것으로 셈
    const k = qt[q.id] || '기타'; wrong[k] = (wrong[k] || 0) + 1;
  });
  const cor = Number(a.DR_cor) || 0, inc = Number(a.DR_inc) || 0, omit = Number(a.DR_omit) || 0;
  return { submitted: a.submitted, perc: Number(a.DR_perc) || 0, cor, inc, omit, score: scaled(result, inc + omit), max: result.scaled_data ? Number(result.scaled_data.max_score) || null : null, wrong };
}
const section = (tt) => /RW|Reading|Writing/i.test(tt) ? 'rw' : /Math/i.test(tt) ? 'math' : '';
const baseTitle = (t) => String(t || '').replace(/\s*\(?M(odule)?\s*#?\d\)?\s*$/i, '').trim();

/**
 * 학생의 track 시험을 모듈 묶음(module_group)마다 하나로: 영역(RW/Math)·영역 점수(모듈 합)·틀린 유형
 *   skipKeys: 이미 끝까지 가져온 묶음은 건너뜀 (결과를 다시 받지 않음)
 */
async function studentSummary(sid, opts) {
  const skip = new Set((opts && opts.skipKeys) || []), limit = (opts && opts.limit) || 30;
  const tests = (await studentTests(sid)).filter((t) => t.is_workbook !== '1' && Number(t.answer_set_count) > 0);
  const groups = new Map();
  tests.forEach((t) => {
    const g = t.module_group_id || 'single_' + t.scheduled_test_id;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  });
  const list = [...groups.entries()].map(([g, ts]) => ({ key: 'track:' + g, tests: ts.sort((a, b) => Number(a.module_num) - Number(b.module_num)), last: ts.map((t) => t.answer_set_latest || '').sort().pop() }))
    .sort((a, b) => b.last.localeCompare(a.last)).slice(0, limit);
  const out = [];
  for (const g of list) {
    const t0 = g.tests[0], set0 = (t0.test_sets || [])[0] || {}, total = Number(t0.module_total_num) || 1;
    const setTitle = set0.test_set_title || set0.test_title || '', testType = set0.test_type_title || set0.tt_title || '';
    const item = { key: g.key, title: baseTitle(setTitle || t0.scheduled_test_title), trackTitle: baseTitle(t0.scheduled_test_title), testType, course: t0.course_title || '',
      section: section(testType), date: String(g.last).slice(0, 10), modulesTotal: total, modules: [], complete: false, skipped: skip.has(g.key) };
    if (!item.skipped) {
      for (const t of g.tests) {
        const m = moduleOf(await testResult(t.scheduled_test_id), sid);
        if (m && m.cor + m.inc > 0) item.modules.push(Object.assign({ n: Number(t.module_num) || 1, set: ((t.test_sets || [])[0] || {}).test_set_title || '' }, m)); // 하나도 안 푼 제출은 뺌
      }
      item.complete = item.modules.length >= total;
      item.full = total >= 2; // 모듈 2개 = 영역 점수(800 만점), 1개짜리(Remix 등)는 모듈 점수만
      item.score = item.modules.every((m) => m.score != null) && item.modules.length ? item.modules.reduce((s, m) => s + m.score, 0) : null;
      item.perc = item.modules.length ? Math.round(item.modules.reduce((s, m) => s + m.perc, 0) / item.modules.length * 10) / 10 : null;
      item.wrong = {}; item.modules.forEach((m) => Object.keys(m.wrong).forEach((k) => { item.wrong[k] = (item.wrong[k] || 0) + m.wrong[k]; }));
    }
    out.push(item);
  }
  return out;
}

module.exports = { studentSummary, TrackError, _test: { moduleOf, scaled, baseTitle, section } };
