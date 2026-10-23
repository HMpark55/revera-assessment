/**
 * REVERA Compass ↔ Google 연결 (자동 백업 + 이메일 알림)
 *
 * 설치: 원장님 구글 계정으로 https://script.google.com → 새 프로젝트 → 이 코드 전체 붙여넣기 → 저장
 *       배포 → 새 배포 → 유형 "웹 앱" → 실행: 나 / 액세스 권한: 모든 사용자 → 배포 → 권한 허용
 *       나온 "웹 앱 URL"(…/exec)을 Compass › 관리 › 백업·알림 에 붙여넣기
 * 코드 업데이트: 같은 프로젝트에 새 코드를 통째로 붙여넣고 저장 → 위쪽 함수 선택에서 authorize 선택 후 ▶실행 → 권한 허용(새 권한이 필요할 때)
 *       → 배포 → 배포 관리 → ✏️(수정) → 버전 "새 버전" → 배포
 *       (이렇게 하면 웹 앱 URL이 그대로라 Compass 설정은 바꾸지 않아도 됨)
 * SECRET 값은 Compass 화면에 보이는 비밀 키와 같아야 합니다. (Compass 화면에서 복사하면 자동으로 들어가 있음)
 */
const SECRET = '__COMPASS_SECRET__';
const FOLDER_NAME = 'Compass 백업';   // 내 드라이브에 이 이름의 폴더를 만들어 저장
const KEEP = 30;                      // 최근 30개만 남기고 오래된 백업은 휴지통으로
const FILES_FOLDER = 'Compass 파일'; // 업로드 파일을 하나씩 복사 (지우지 않음)
const VERSION = 4;

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad request' }); }
  if (req.secret !== SECRET) return out({ ok: false, error: 'secret' });

  if (req.action === 'ping') {
    return out({ ok: true, version: VERSION, account: Session.getEffectiveUser().getEmail(), mailQuota: MailApp.getRemainingDailyQuota() });
  }
  if (req.action === 'backup') {
    const folder = getFolder(FOLDER_NAME);
    const blob = Utilities.newBlob(Utilities.base64Decode(req.data), 'application/zip', req.name);
    const file = folder.createFile(blob);
    cleanup(folder);
    return out({ ok: true, url: file.getUrl() });
  }
  if (req.action === 'file') {
    const folder = getFolder(FILES_FOLDER);
    const found = folder.getFilesByName(req.name);
    if (found.hasNext()) return out({ ok: true, id: found.next().getId(), existed: true }); // 지난번에 응답만 못 받은 경우
    const f = folder.createFile(Utilities.newBlob(Utilities.base64Decode(req.data), req.mime || 'application/octet-stream', req.name));
    if (req.label) f.setDescription(String(req.label).slice(0, 500));
    return out({ ok: true, id: f.getId() });
  }
  if (req.action === 'sheet') { // 원장님 상담 스케줄 읽기 (읽기만, 수정하지 않음)
    const ss = SpreadsheetApp.openById(req.id);
    const tabs = {};
    const colors = {}; // 칸 배경색 — 회색 칸은 취소된 일정으로 보고 가져오지 않음
    (req.tabs || []).forEach(function (n) {
      const sh = ss.getSheetByName(n), r = sh ? sh.getDataRange() : null;
      tabs[n] = r ? r.getDisplayValues() : null;
      colors[n] = r ? r.getBackgrounds() : null;
    });
    return out({ ok: true, names: ss.getSheets().map(function (sh) { return sh.getName(); }), tabs: tabs, colors: colors });
  }
  if (req.action === 'mail') {
    const list = req.messages || [];
    list.forEach(function (m) {
      MailApp.sendEmail({ to: m.to, subject: m.subject, body: m.text || '', htmlBody: m.html || '', name: 'REVERA Compass' });
    });
    return out({ ok: true, sent: list.length, remaining: MailApp.getRemainingDailyQuota() });
  }
  return out({ ok: false, error: 'unknown action' });
}

/** 처음 한 번 편집기에서 실행 → 드라이브·메일·시트 권한 허용 창이 뜸 */
function authorize() {
  DriveApp.getRootFolder();
  MailApp.getRemainingDailyQuota();
  SpreadsheetApp.flush();
}

function getFolder(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

function cleanup(folder) {
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(KEEP).forEach(function (f) { f.setTrashed(true); });
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
