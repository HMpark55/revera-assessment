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

module.exports = { sanitizeRich, richToText, hasFormatting, textToRich };
