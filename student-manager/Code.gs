/**
 * REVERA 학생관리 — Google Apps Script 웹앱 (서버)
 *
 * 데이터는 이 스크립트가 연결된 구글 시트에 저장됩니다.
 * 처음 한 번 setup() 을 실행해 시트 탭과 머리글을 만드세요. (README.md 참고)
 */

var SHEETS = {
  teachers: { name: '선생님', cols: ['email', 'name', 'role', 'active', 'createdAt'] },
  students: { name: '학생', cols: ['id', 'name', 'dob', 'school', 'grade', 'curriculum', 'counselor',
    'status', 'studentPhone', 'parentName', 'parentPhone', 'email', 'tags', 'memo',
    'createdAt', 'createdBy', 'updatedAt', 'updatedBy'] },
  notes: { name: '상담기록', cols: ['id', 'studentId', 'date', 'type', 'content', 'nextAction',
    'nextDue', 'done', 'author', 'createdAt', 'updatedAt', 'updatedBy'] },
  apps: { name: '지원대학', cols: ['id', 'studentId', 'university', 'major', 'round', 'deadline',
    'status', 'essay', 'memo', 'createdAt', 'updatedAt', 'updatedBy'] },
  log: { name: '변경로그', cols: ['at', 'email', 'action', 'table', 'targetId', 'summary'] }
};

// 클라이언트에서 수정 가능한 필드 (나머지는 서버가 관리)
var EDITABLE = {
  students: ['name', 'dob', 'school', 'grade', 'curriculum', 'counselor', 'status', 'studentPhone',
    'parentName', 'parentPhone', 'email', 'tags', 'memo'],
  notes: ['studentId', 'date', 'type', 'content', 'nextAction', 'nextDue', 'done'],
  apps: ['studentId', 'university', 'major', 'round', 'deadline', 'status', 'essay', 'memo']
};

var TZ = 'Asia/Seoul';

/* ------------------------------------------------------------------ */
/* 웹앱 진입점                                                          */
/* ------------------------------------------------------------------ */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('REVERA 학생관리')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ------------------------------------------------------------------ */
/* 최초 설정 — Apps Script 편집기에서 한 번 직접 실행                         */
/* ------------------------------------------------------------------ */

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());

  Object.keys(SHEETS).forEach(function (key) {
    var def = SHEETS[key];
    var sh = ss.getSheetByName(def.name) || ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, def.cols.length).setValues([def.cols]);
    sh.setFrozenRows(1);
    // 날짜·전화번호가 숫자/날짜로 자동 변환되지 않도록 전체를 텍스트 서식으로
    sh.getRange(1, 1, sh.getMaxRows(), def.cols.length).setNumberFormat('@');
  });

  var me = Session.getEffectiveUser().getEmail();
  var teachers = readTable_('teachers');
  if (!teachers.some(function (t) { return lower_(t.email) === lower_(me); })) {
    appendRow_('teachers', { email: me, name: me.split('@')[0], role: 'admin', active: 'TRUE', createdAt: now_() });
  }
  return '설정 완료: ' + me + ' 님이 관리자로 등록되었습니다.';
}

/* ------------------------------------------------------------------ */
/* 클라이언트에서 호출하는 API                                             */
/* ------------------------------------------------------------------ */

/** 화면에 필요한 전체 데이터를 한 번에 반환 */
function getAll() {
  var me = requireTeacher_();
  return {
    me: me,
    teachers: readTable_('teachers').map(function (t) {
      return { email: t.email, name: t.name, role: t.role, active: isTrue_(t.active) };
    }),
    students: readTable_('students'),
    notes: readTable_('notes'),
    apps: readTable_('apps'),
    serverTime: now_()
  };
}

function saveStudent(obj) {
  if (!obj || !String(obj.name || '').trim()) throw new Error('학생 이름은 필수입니다.');
  return save_('students', obj, function (r) { return r.name; });
}
function saveNote(obj) {
  if (!obj || !obj.studentId) throw new Error('학생이 지정되지 않았습니다.');
  if (!String(obj.content || '').trim() && !String(obj.nextAction || '').trim()) {
    throw new Error('상담 내용 또는 다음 할 일을 입력하세요.');
  }
  return save_('notes', obj, function (r) { return r.date + ' ' + r.type; });
}
function saveApp(obj) {
  if (!obj || !obj.studentId) throw new Error('학생이 지정되지 않았습니다.');
  if (!String(obj.university || '').trim()) throw new Error('대학명은 필수입니다.');
  return save_('apps', obj, function (r) { return r.university + ' ' + (r.round || ''); });
}

function deleteNote(id) { return remove_('notes', id); }
function deleteApp(id) { return remove_('apps', id); }

/** 학생 삭제 — 관리자만. 해당 학생의 상담기록·지원대학도 함께 삭제 */
function deleteStudent(id) {
  var me = requireTeacher_();
  if (me.role !== 'admin') throw new Error('학생 삭제는 관리자만 할 수 있습니다. 상태를 "종료"로 바꿔주세요.');
  return withLock_(function () {
    var student = findById_('students', id);
    if (!student) throw new Error('이미 삭제된 학생입니다.');
    ['notes', 'apps'].forEach(function (t) {
      readTable_(t).filter(function (r) { return r.studentId === id; })
        .map(function (r) { return r._row; })
        .sort(function (a, b) { return b - a; })
        .forEach(function (row) { sheet_(t).deleteRow(row); });
    });
    sheet_('students').deleteRow(student._row);
    log_(me.email, 'delete', 'students', id, student.name);
    return getAll();
  });
}

/** 선생님 추가/수정 — 관리자만 */
function saveTeacher(obj) {
  var me = requireTeacher_();
  if (me.role !== 'admin') throw new Error('관리자만 선생님을 관리할 수 있습니다.');
  var email = lower_(obj && obj.email).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('이메일 형식이 올바르지 않습니다.');
  var role = obj.role === 'admin' ? 'admin' : 'teacher';
  var active = obj.active === false ? 'FALSE' : 'TRUE';
  if (email === lower_(me.email) && (role !== 'admin' || active !== 'TRUE')) {
    throw new Error('본인의 관리자 권한은 해제할 수 없습니다.');
  }
  return withLock_(function () {
    var rows = readTable_('teachers');
    var found = rows.filter(function (t) { return lower_(t.email) === email; })[0];
    var rec = { email: email, name: String(obj.name || '').trim() || email.split('@')[0], role: role,
      active: active, createdAt: found ? found.createdAt : now_() };
    if (found) writeRow_('teachers', found._row, rec);
    else appendRow_('teachers', rec);
    log_(me.email, found ? 'update' : 'create', 'teachers', email, rec.name + ' ' + role + ' ' + active);
    // "웹앱을 사용하는 사용자로 실행" 배포에서는 선생님이 시트 편집 권한이 있어야 합니다.
    if (active === 'TRUE' && obj.grantSheet !== false) {
      try { SpreadsheetApp.openById(sheetId_()).addEditor(email); } catch (e) { /* 이미 권한 있음 등 */ }
    }
    return getAll();
  });
}

/* ------------------------------------------------------------------ */
/* 내부 함수                                                            */
/* ------------------------------------------------------------------ */

function save_(table, obj, summarize) {
  var me = requireTeacher_();
  return withLock_(function () {
    var rec = {};
    EDITABLE[table].forEach(function (k) { if (k in obj) rec[k] = clean_(obj[k]); });
    if (rec.studentId && !findById_('students', rec.studentId)) throw new Error('존재하지 않는 학생입니다.');
    var t = now_();
    if (obj.id) {
      var cur = findById_(table, obj.id);
      if (!cur) throw new Error('다른 선생님이 이미 삭제한 항목입니다. 새로고침 해주세요.');
      // 동시 수정 방지: 불러온 뒤에 다른 사람이 수정했으면 거부
      if (obj.updatedAt && cur.updatedAt && obj.updatedAt !== cur.updatedAt) {
        var who = readTable_('teachers').filter(function (x) { return lower_(x.email) === lower_(cur.updatedBy); })[0];
        throw new Error('그 사이 ' + (who ? who.name : cur.updatedBy || '다른 선생님') + ' 님이 먼저 수정했습니다. ' +
          '새로고침 후 다시 입력해주세요.');
      }
      var merged = {};
      SHEETS[table].cols.forEach(function (c) { merged[c] = c in rec ? rec[c] : cur[c]; });
      merged.updatedAt = t;
      merged.updatedBy = me.email;
      writeRow_(table, cur._row, merged);
      log_(me.email, 'update', table, obj.id, summarize(merged));
    } else {
      rec.id = newId_();
      rec.createdAt = t;
      rec.updatedAt = t;
      rec.updatedBy = me.email;
      if (table === 'students') rec.createdBy = me.email;
      if (table === 'notes') rec.author = me.email;
      appendRow_(table, rec);
      log_(me.email, 'create', table, rec.id, summarize(rec));
    }
    return getAll();
  });
}

function remove_(table, id) {
  var me = requireTeacher_();
  return withLock_(function () {
    var cur = findById_(table, id);
    if (!cur) throw new Error('이미 삭제된 항목입니다.');
    sheet_(table).deleteRow(cur._row);
    log_(me.email, 'delete', table, id, JSON.stringify(stripRow_(cur)).slice(0, 500));
    return getAll();
  });
}

function requireTeacher_() {
  var email = lower_(Session.getActiveUser().getEmail());
  if (!email) {
    throw new Error('로그인 정보를 확인할 수 없습니다. 구글 계정으로 로그인했는지, ' +
      '웹앱이 "웹앱에 액세스하는 사용자"로 실행되도록 배포되었는지 확인하세요.');
  }
  var t = readTable_('teachers').filter(function (r) { return lower_(r.email) === email; })[0];
  if (!t || !isTrue_(t.active)) throw new Error('등록되지 않은 계정입니다 (' + email + '). 관리자에게 등록을 요청하세요.');
  return { email: email, name: t.name || email, role: t.role === 'admin' ? 'admin' : 'teacher' };
}

function sheetId_() {
  return PropertiesService.getScriptProperties().getProperty('SHEET_ID');
}

var ss_cache_ = null;
function sheet_(table) {
  if (!ss_cache_) {
    var id = sheetId_();
    ss_cache_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  }
  var sh = ss_cache_.getSheetByName(SHEETS[table].name);
  if (!sh) throw new Error('"' + SHEETS[table].name + '" 시트가 없습니다. setup() 을 먼저 실행하세요.');
  return sh;
}

/** 시트를 객체 배열로 읽기. 각 객체에 _row(시트 행 번호)를 붙임 */
function readTable_(table) {
  var cols = SHEETS[table].cols;
  var values = sheet_(table).getDataRange().getValues();
  var header = values[0] || [];
  var idx = cols.map(function (c) { return header.indexOf(c); });
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.every(function (v) { return v === '' || v === null; })) continue;
    var o = { _row: i + 1 };
    cols.forEach(function (c, j) { o[c] = idx[j] < 0 ? '' : toText_(row[idx[j]]); });
    out.push(o);
  }
  return out;
}

function findById_(table, id) {
  if (!id) return null;
  return readTable_(table).filter(function (r) { return r.id === id; })[0] || null;
}

function rowValues_(table, rec) {
  return SHEETS[table].cols.map(function (c) {
    var s = rec[c] === undefined || rec[c] === null ? '' : String(rec[c]);
    // 시트 수식으로 해석되는 것을 방지 (앞의 ' 는 시트에서 보이지 않고 읽을 때도 제거됨)
    return /^[=+@]/.test(s) ? "'" + s : s;
  });
}
function appendRow_(table, rec) {
  var sh = sheet_(table);
  var row = sh.getLastRow() + 1;
  var range = sh.getRange(row, 1, 1, SHEETS[table].cols.length);
  range.setNumberFormat('@');
  range.setValues([rowValues_(table, rec)]);
}
function writeRow_(table, row, rec) {
  var range = sheet_(table).getRange(row, 1, 1, SHEETS[table].cols.length);
  range.setNumberFormat('@');
  range.setValues([rowValues_(table, rec)]);
}

function log_(email, action, table, id, summary) {
  appendRow_('log', { at: now_(), email: email, action: action, table: SHEETS[table].name,
    targetId: id, summary: String(summary || '').slice(0, 500) });
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('다른 선생님이 저장 중입니다. 잠시 후 다시 시도하세요.');
  try { return fn(); } finally { lock.releaseLock(); }
}

function clean_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v).replace(/\r\n/g, '\n').slice(0, 20000);
}

function toText_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    var full = Utilities.formatDate(v, TZ, "yyyy-MM-dd'T'HH:mm:ss");
    return /T00:00:00$/.test(full) ? full.slice(0, 10) : full;
  }
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

function stripRow_(o) {
  var c = {};
  Object.keys(o).forEach(function (k) { if (k !== '_row') c[k] = o[k]; });
  return c;
}

function now_() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss.SSS"); }
function newId_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
function lower_(s) { return String(s || '').toLowerCase(); }
function isTrue_(v) { return String(v).toUpperCase() === 'TRUE'; }
