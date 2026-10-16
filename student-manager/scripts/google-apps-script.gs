/**
 * REVERA Compass ↔ Google 연결 (자동 백업 + 이메일 알림)
 *
 * 설치: 원장님 구글 계정으로 https://script.google.com → 새 프로젝트 → 이 코드 전체 붙여넣기 → 저장
 *       배포 → 새 배포 → 유형 "웹 앱" → 실행: 나 / 액세스 권한: 모든 사용자 → 배포 → 권한 허용
 *       나온 "웹 앱 URL"(…/exec)을 Compass › 관리 › 백업·알림 에 붙여넣기
 * SECRET 값은 Compass 화면에 보이는 비밀 키와 같아야 합니다. (Compass 화면에서 복사하면 자동으로 들어가 있음)
 */
const SECRET = '__COMPASS_SECRET__';
const FOLDER_NAME = 'Compass 백업';   // 내 드라이브에 이 이름의 폴더를 만들어 저장
const KEEP = 30;                      // 최근 30개만 남기고 오래된 백업은 휴지통으로

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad request' }); }
  if (req.secret !== SECRET) return out({ ok: false, error: 'secret' });

  if (req.action === 'ping') {
    return out({ ok: true, account: Session.getEffectiveUser().getEmail(), mailQuota: MailApp.getRemainingDailyQuota() });
  }
  if (req.action === 'backup') {
    const folder = getFolder();
    const blob = Utilities.newBlob(Utilities.base64Decode(req.data), 'application/zip', req.name);
    const file = folder.createFile(blob);
    cleanup(folder);
    return out({ ok: true, url: file.getUrl() });
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

function getFolder() {
  const it = DriveApp.getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
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
