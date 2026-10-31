'use strict';
/** 원서 연습 양식 목록 — 대학·입학 연도마다 파일 하나 (포털 구조를 옮긴 것) */
const FORMS = [require('./hku-2027'), require('./hkust-2027')];
const byId = Object.fromEntries(FORMS.map((f) => [f.id, f]));
/** 화면 목록용 (선택 목록 같은 큰 내용은 빼고) */
const formList = () => FORMS.map((f) => ({ id: f.id, uni: f.uni, title: f.title, intake: f.intake, tabs: f.tabs.map((t) => ({ key: t.key, title: t.title })) }));
module.exports = { formList, getForm: (id) => byId[id] || null };
