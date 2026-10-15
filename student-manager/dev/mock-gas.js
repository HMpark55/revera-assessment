/**
 * 테스트/미리보기용 가짜 Apps Script 환경 (SpreadsheetApp 등).
 * 실제 배포에는 사용되지 않습니다. 브라우저와 Node 양쪽에서 동작합니다.
 */
(function (root) {
  function FakeSheet(name) { this.name = name; this.rows = []; }
  FakeSheet.prototype.getName = function () { return this.name; };
  FakeSheet.prototype.getLastRow = function () { return this.rows.length; };
  FakeSheet.prototype.getMaxRows = function () { return Math.max(1000, this.rows.length); };
  FakeSheet.prototype.setFrozenRows = function () {};
  FakeSheet.prototype.deleteRow = function (r) { this.rows.splice(r - 1, 1); };
  FakeSheet.prototype.getDataRange = function () {
    var w = this.rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    return this.getRange(1, 1, Math.max(1, this.rows.length), Math.max(1, w));
  };
  FakeSheet.prototype.getRange = function (row, col, nr, nc) {
    var sh = this;
    return {
      setNumberFormat: function () { return this; },
      getValues: function () {
        var out = [];
        for (var i = 0; i < nr; i++) {
          var src = sh.rows[row - 1 + i] || [], line = [];
          for (var j = 0; j < nc; j++) {
            var v = src[col - 1 + j];
            if (v === undefined) v = '';
            // 실제 시트처럼 앞의 ' (텍스트 강제 접두사)는 값에서 빠짐
            if (typeof v === 'string' && v.charAt(0) === "'") v = v.slice(1);
            line.push(v);
          }
          out.push(line);
        }
        return out;
      },
      setValues: function (vals) {
        if (vals.length !== nr || vals[0].length !== nc) throw new Error('range size mismatch');
        for (var i = 0; i < nr; i++) {
          while (sh.rows.length < row + i) sh.rows.push([]);
          for (var j = 0; j < nc; j++) {
            var v = vals[i][j];
            if (typeof v === 'string' && /^[=+@]/.test(v)) throw new Error('수식으로 해석될 값이 그대로 저장됨: ' + v);
            sh.rows[row - 1 + i][col - 1 + j] = v;
          }
        }
        return this;
      }
    };
  };

  function FakeSpreadsheet() { this.sheets = {}; this.editors = []; }
  FakeSpreadsheet.prototype.getId = function () { return 'fake-sheet-id'; };
  FakeSpreadsheet.prototype.getSheetByName = function (n) { return this.sheets[n] || null; };
  FakeSpreadsheet.prototype.insertSheet = function (n) { return (this.sheets[n] = new FakeSheet(n)); };
  FakeSpreadsheet.prototype.addEditor = function (e) { this.editors.push(e); };

  function install(target, opts) {
    var ss = new FakeSpreadsheet();
    var props = {};
    var state = { user: (opts && opts.user) || 'admin@revera.test', ss: ss };
    target.SpreadsheetApp = { getActiveSpreadsheet: function () { return ss; }, openById: function () { return ss; } };
    target.PropertiesService = { getScriptProperties: function () {
      return { getProperty: function (k) { return props[k] || null; }, setProperty: function (k, v) { props[k] = v; } };
    } };
    target.Session = {
      getActiveUser: function () { return { getEmail: function () { return state.user; } }; },
      getEffectiveUser: function () { return { getEmail: function () { return state.user; } }; }
    };
    target.LockService = { getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } };
    var seq = 0;
    target.Utilities = {
      getUuid: function () { seq++; return ('00000000' + seq.toString(16)).slice(-8) + '-aaaa-bbbb-cccc-' + Math.random().toString(16).slice(2, 14); },
      formatDate: function (d, tz, fmt) {
        // Asia/Seoul 고정(+9h) 간이 구현
        var k = new Date(d.getTime() + 9 * 3600000);
        function p(n, w) { return String(n).padStart(w || 2, '0'); }
        return fmt.replace("'T'", 'T')
          .replace('yyyy', k.getUTCFullYear()).replace('MM', p(k.getUTCMonth() + 1)).replace('dd', p(k.getUTCDate()))
          .replace('HH', p(k.getUTCHours())).replace('mm', p(k.getUTCMinutes())).replace('ss', p(k.getUTCSeconds()))
          .replace('SSS', p(k.getUTCMilliseconds(), 3));
      }
    };
    target.HtmlService = { createHtmlOutputFromFile: function () { var o = { setTitle: function () { return o; }, addMetaTag: function () { return o; } }; return o; } };
    return state;
  }

  root.MockGAS = { install: install };
  if (typeof module !== 'undefined') module.exports = root.MockGAS;
})(typeof window !== 'undefined' ? window : globalThis);
