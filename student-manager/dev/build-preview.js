// 로컬 미리보기 생성: node dev/build-preview.js → dev/preview.html (샘플 데이터, 구글 연결 없음)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');
const mock = fs.readFileSync(path.join(__dirname, 'mock-gas.js'), 'utf8');
const code = fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');

const shim = `
<script>${mock}</script>
<script>var __gas = MockGAS.install(window, { user: 'admin@revera.test' });</script>
<script>${code}</script>
<script>
// google.script.run 흉내 (비동기 + 실패 핸들러)
var google = { script: { run: (function make(ok, fail) {
  return new Proxy({}, { get: function (_, fn) {
    if (fn === 'withSuccessHandler') return function (h) { return make(h, fail); };
    if (fn === 'withFailureHandler') return function (h) { return make(ok, h); };
    return function () { var a = arguments; setTimeout(function () {
      try { var r = JSON.parse(JSON.stringify(window[fn].apply(null, a))); ok && ok(r); } catch (e) { fail && fail(e); }
    }, 150); };
  } });
})() } };
(function seed() {
  setup();
  saveTeacher({ email: 'kim@revera.test', name: '김선생', role: 'teacher' });
  saveTeacher({ email: 'lee@revera.test', name: '이선생', role: 'teacher' });
  saveTeacher({ email: 'admin@revera.test', name: '박원장', role: 'admin' });
  function d(n) { var x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); }
  var people = [
    ['샘플 학생A', 'SIS', 'G12', 'IB', 'admin@revera.test', '진행중', '미대,장학금'],
    ['샘플 학생B', 'KIS', 'G11', 'AP', 'kim@revera.test', '상담중', '신규'],
    ['샘플 학생C', 'Dwight', 'G12', 'IB', 'lee@revera.test', '진행중', ''],
    ['샘플 학생D', '대원외고', '고3', '국내 특목고', 'kim@revera.test', '보류', ''],
    ['샘플 학생E', 'SFS', 'G12', 'AP', 'admin@revera.test', '완료', '']
  ];
  people.forEach(function (p) { saveStudent({ name: p[0], school: p[1], grade: p[2], curriculum: p[3], counselor: p[4], status: p[5], tags: p[6], parentName: '학부모', parentPhone: '010-0000-0000' }); });
  var S = getAll().students;
  function id(i) { return S.filter(function (s) { return s.name === people[i][0]; })[0].id; }
  saveNote({ studentId: id(0), date: d(-7), type: '대면상담', content: '지원 리스트 확정. Early 1곳, 나머지 RD.\\n에세이 주제 3개 중 2번으로 결정.', nextAction: 'Common App 에세이 초안 받기', nextDue: d(-1) });
  saveNote({ studentId: id(0), date: d(-1), type: '학부모상담', content: '학부모님께 일정 공유.' });
  saveNote({ studentId: id(1), date: d(-3), type: '전화', content: '첫 상담 예약 확인.', nextAction: '성적표 사본 받기', nextDue: d(4) });
  saveNote({ studentId: id(2), date: d(-2), type: '카톡·문자', content: '활동 리스트 정리본 받음.', nextAction: '추천서 요청 메일 확인', nextDue: d(10) });
  saveApp({ studentId: id(0), university: 'Stanford', major: 'Art Practice', round: 'REA', deadline: d(2), status: '작성중', essay: '수정중' });
  saveApp({ studentId: id(0), university: 'RISD', round: 'EA', deadline: d(17), status: '준비중', essay: '초안' });
  saveApp({ studentId: id(0), university: 'Cornell', round: 'RD', deadline: d(80), status: '준비중' });
  saveApp({ studentId: id(2), university: 'University of Toronto', round: 'Rolling', deadline: d(9), status: '준비중', essay: '미착수' });
  saveApp({ studentId: id(2), university: 'NYU', round: 'ED', deadline: d(-2), status: '제출완료', essay: '완료' });
  saveApp({ studentId: id(3), university: '연세대', major: '경영', round: '수시', deadline: d(-1), status: '작성중' });
})();
</script>`;

const out = html.replace('<script>\n/* ====', shim + '\n<script>\n/* ====');
if (out === html) throw new Error('삽입 위치를 찾지 못함');
fs.writeFileSync(path.join(__dirname, 'preview.html'), out.replace('<title>REVERA 학생관리</title>', '<title>REVERA 학생관리 (미리보기·샘플 데이터)</title>'));
console.log('dev/preview.html 생성');
