'use strict';
/**
 * 회의록·상담기록의 서식 있는 글(HTML) 정리.
 * 편집기에서 쓸 수 있는 서식(굵게·밑줄·취소선·글자색·배경색·글자 크기)과 줄바꿈만 남기고 나머지는 모두 지움.
 * 화면에 그대로 넣어 보여주는 값이므로 저장할 때 반드시 이 함수를 거침.
 */
const BLOCK = new Set(['div', 'p']);
const INLINE = new Set(['b', 'strong', 'u', 's', 'strike', 'span']);
const VOID = new Set(['br']);
const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)|transparent|inherit|initial)$/i;
const STYLE_OK = {
  color: (v) => COLOR.test(v),
  'background-color': (v) => COLOR.test(v),
  'font-size': (v) => /^(\d{1,2}(\.\d)?(px|pt|em|rem)|x-small|small|medium|large|x-large|xx-large)$/i.test(v),
  'font-weight': (v) => /^(bold|normal|[1-9]00)$/i.test(v),
  'text-decoration': (v) => /^(none|underline|line-through|underline line-through|line-through underline)$/i.test(v),
  'text-decoration-line': (v) => /^(none|underline|line-through|underline line-through|line-through underline)$/i.test(v),
};
const ENTITY = /^&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/i;

function cleanStyle(attrs) {
  const m = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs || '');
  if (!m) return '';
  const raw = (m[2] != null ? m[2] : m[3]).replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const out = [];
  raw.split(';').forEach((decl) => {
    const i = decl.indexOf(':');
    if (i < 0) return;
    const k = decl.slice(0, i).trim().toLowerCase(), v = decl.slice(i + 1).trim();
    if (STYLE_OK[k] && STYLE_OK[k](v)) out.push(k + ': ' + v.toLowerCase());
  });
  return out.join('; ');
}

/** 텍스트 조각: 올바른 &엔티티; 는 그대로, 나머지 & < > " 는 이스케이프 */
function escText(t) {
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '&') {
      const m = ENTITY.exec(t.slice(i));
      if (m) { out += m[0]; i += m[0].length - 1; } else out += '&amp;';
    } else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else out += c;
  }
  return out;
}

function sanitizeRich(html) {
  const src = String(html || '');
  const stack = [];
  let out = '';
  const re = /<!--[\s\S]*?(-->|$)|<\/?([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|<|[^<]+/g;
  let m, skip = 0; // <script>/<style> 안의 글자는 통째로 버림
  while ((m = re.exec(src))) {
    const tok = m[0];
    if (tok.startsWith('<!--')) continue;
    if (m[2]) {
      const name = m[2].toLowerCase(), closing = tok[1] === '/';
      if (name === 'script' || name === 'style') { skip += closing ? (skip ? -1 : 0) : 1; continue; }
      if (skip) continue;
      if (VOID.has(name)) { if (!closing) out += '<br>'; continue; }
      if (!BLOCK.has(name) && !INLINE.has(name)) continue;
      const tag = name === 'strong' ? 'b' : name === 'strike' ? 's' : name === 'p' ? 'div' : name;
      if (closing) {
        const at = stack.lastIndexOf(tag);
        if (at < 0) continue;
        while (stack.length > at) out += '</' + stack.pop() + '>';
      } else {
        const st = tag === 'span' || tag === 'div' ? cleanStyle(m[3]) : '';
        out += '<' + tag + (st ? ' style="' + st + '"' : '') + '>';
        stack.push(tag);
      }
      continue;
    }
    if (skip) continue;
    out += escText(tok);
  }
  while (stack.length) out += '</' + stack.pop() + '>';
  return out;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
/** 정리된 HTML → 검색·메일·요약용 일반 글 (줄바꿈 유지) */
function richToText(html) {
  return String(html || '')
    .replace(/<br>(<\/(?:b|u|s|span)>)*<\/div>/g, '$1</div>') // 빈 줄 <div><br></div> 은 줄바꿈 하나
    .replace(/<br>/g, '\n')
    .replace(/<div[^>]*>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (all, e) => {
      if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch (x) { return ''; } }
      return NAMED[e.toLowerCase()] != null ? NAMED[e.toLowerCase()] : all;
    })
    .replace(/^\n/, '')
    .replace(/[ \t]+$/gm, '');
}

/** 서식이 하나도 없으면(줄바꿈뿐이면) 일반 글로만 저장해도 됨 */
function hasFormatting(html) { return /<(b|u|s|span)\b|<div style=/.test(html); }

/** 예전 일반 글 → 편집기에 넣을 HTML */
function textToRich(t) { return escText(String(t || '').replace(/&/g, '&amp;')).split('\n').join('<br>'); }

/**
 * 계약서처럼 "문서" 모양이 필요한 글: 제목(h1~h3)·표·목록·가운데/오른쪽 정렬까지 허용.
 * 화면·인쇄에 그대로 넣는 값이므로 저장할 때 반드시 이 함수를 거침 (스크립트·링크·이미지·이벤트 속성은 모두 지움).
 */
const DOC_TAGS = new Set(['div', 'p', 'h1', 'h2', 'h3', 'b', 'strong', 'u', 's', 'strike', 'span', 'i', 'em', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'ul', 'ol', 'li']);
const DOC_STYLE = Object.assign({}, STYLE_OK, {
  'text-align': (v) => /^(left|center|right|justify)$/i.test(v),
  width: (v) => /^\d{1,3}(\.\d+)?%$/.test(v),
  'padding-left': (v) => /^\d{1,2}(\.\d+)?em$/.test(v), // 번호 항목 들여쓰기 (1. 다음 줄이 글자에 맞춰지게)
  'text-indent': (v) => /^-?\d{1,2}(\.\d+)?em$/.test(v),
});
function cleanDocStyle(attrs) {
  const m = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs || '');
  if (!m) return '';
  const raw = (m[2] != null ? m[2] : m[3]).replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return raw.split(';').map((decl) => {
    const i = decl.indexOf(':'); if (i < 0) return '';
    const k = decl.slice(0, i).trim().toLowerCase(), v = decl.slice(i + 1).trim();
    return DOC_STYLE[k] && DOC_STYLE[k](v) ? k + ': ' + v.toLowerCase() : '';
  }).filter(Boolean).join('; ');
}
function sanitizeDoc(html) {
  const src = String(html || '').slice(0, 400000);
  const stack = [];
  let out = '';
  const re = /<!--[\s\S]*?(-->|$)|<\/?([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|<|[^<]+/g;
  let m, skip = 0;
  while ((m = re.exec(src))) {
    const tok = m[0];
    if (tok.startsWith('<!--')) continue;
    if (m[2]) {
      const name = m[2].toLowerCase(), closing = tok[1] === '/';
      if (name === 'script' || name === 'style') { skip += closing ? (skip ? -1 : 0) : 1; continue; }
      if (skip) continue;
      if (name === 'br') { if (!closing) out += '<br>'; continue; }
      if (!DOC_TAGS.has(name)) continue;
      const tag = name === 'strong' ? 'b' : name === 'strike' ? 's' : name === 'em' ? 'i' : name;
      if (closing) {
        const at = stack.lastIndexOf(tag);
        if (at < 0) continue;
        while (stack.length > at) out += '</' + stack.pop() + '>';
      } else {
        const st = cleanDocStyle(m[3]);
        let extra = '';
        if (tag === 'td' || tag === 'th') ['colspan', 'rowspan'].forEach((a) => { const x = new RegExp('\\b' + a + '\\s*=\\s*["\']?(\\d{1,2})', 'i').exec(m[3] || ''); if (x) extra += ' ' + a + '="' + x[1] + '"'; });
        if (tag === 'table' && /\bdata-ct\s*=\s*["']?cost/i.test(m[3] || '')) extra += ' data-ct="cost"'; // 계약서의 비용 표 (줄 추가 버튼이 찾는 표시)
        if (tag === 'div' && /\bdata-ct\s*=\s*["']?special/i.test(m[3] || '')) extra += ' data-ct="special"'; // 계약서의 특약사항 (작성 창의 입력 칸이 채움)
        out += '<' + tag + extra + (st ? ' style="' + st + '"' : '') + '>';
        stack.push(tag);
      }
      continue;
    }
    if (skip) continue;
    out += escText(tok);
  }
  while (stack.length) out += '</' + stack.pop() + '>';
  return out;
}

module.exports = { sanitizeRich, richToText, hasFormatting, textToRich, sanitizeDoc };
