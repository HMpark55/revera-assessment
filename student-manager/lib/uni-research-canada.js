'use strict';
/**
 * 캐나다 대학 공식 자료 확인 결과 (2026-10-26 조사 — 대학 공식 페이지만 사용, 2027년 9월 입학 기준).
 * uni-research.js 와 같은 방식: 그 입학 연도의 주요 정보가 비어 있을 때만 넣음 (v28).
 */
const MEMO = '2026-10-26 공식 자료 확인 결과를 주요 정보에 넣었습니다 (Compass 조사). 확인 못 한 항목은 “확인 못 함”으로 표시.';

module.exports = [
  {
    name: 'McGill', year: '2027', term: '9월',
    sourceUrl: 'https://www.mcgill.ca/undergraduate-admissions/apply/requirements/international',
    requirements: [
      { item: '원서 포털', content: 'https://www.mcgill.ca/undergraduate-admissions/apply' },
      { item: '일정 (캐나다·미국 밖 고교)', content: '지원 마감 1/15 / 서류 마감 3/1 / Major Entrance Scholarship 1/21 / Music·Religious Studies는 지원·서류 모두 1/15, Social Work 서류 3/7' },
      { item: '발표', content: '캐나다·미국 밖 고교: 2026년 11월 중순 ~ 2027년 5월 중순 (경쟁 프로그램은 더 늦을 수 있음)' },
      { item: '전형료', content: 'CAD 140.16 (환불 불가). 같은 학기 두 번째 지원서는 무료, 그다음부터 지원서마다 CAD 140.16. 지원서마다 프로그램 1개, 제출 후 변경 불가' },
      { item: '영어', content: 'IELTS 6.5 (각 6.0) / TOEFL: 2026-01-20까지 응시 90 (각 21), 2026-01-21부터 4.5 (각 4.5) — 경영(Management)·TESL은 100 / 5.0 (MyBest 불인정) / Duolingo 125 (경영·TESL 130) / PTE 65 (각 60). 성적은 시험 기관이 McGill로 직접 보내야 함' },
      { item: '영어 면제', content: '영어가 주 언어인 나라에서 4년 연속 거주·재학, IB English A 5 이상, A-level English C 이상, IGCSE English B(5) 이상 등. 영어로 수업하는 국제학교 재학만으로는 면제 안 됨(공식 명시)' },
      { item: '미국식 (미국 밖 학교)', content: '미국 지역 인증(WASC·NEASC·Cognia 등) 고교 졸업장, 10~12학년 성적(포털에 업로드, 자가 입력 아님). SAT/ACT는 Fall 2027 선택 제출(Music 제외) — 내면 반드시 도착해야 함. 참고 범위: Arts B+ / ACT 27–29 / SAT RW 670–700·M 610–640, Science·Management B+~A- / ACT 29–31 / SAT RW 690–700·M 690–710, Engineering(Chem·Civil·Comp·Elec) A-~A / ACT 30–31 / SAT 700–720' },
      { item: 'IB', content: '42점 만점(보너스 제외) 기준 참고 범위: Arts 33–36 / B.A.&Sc. 35–37 / Science 생명·생의학·물리계열 그룹 36–39, 물리·수학·컴퓨터 그룹 35–38 / Management 35–38 / Engineering 대부분 35–38 (Mechanical 38–42, Bioengineering 39–41) / Architecture 39–42 / Education·Nursing 30 / Kinesiology 30–31 / 농업·환경 28–30. SL Math AI는 수학 선수과목으로 불인정(농업·환경 제외)' },
      { item: '지원 단위', content: '학부(Faculty)로 지원, Science는 4개 그룹 중 하나로 지원. B.A. Psychology는 별도 지원 필요. 전공별 소속 학부·그룹은 전공 리스트 메모 참고' },
      { item: '제출 서류', content: '포털 업로드: 고교 성적표(마지막 학년 1학기 포함), IB 예상점수 등. 대부분 성적 위주 — 일부 프로그램만 추가 서류(Global Engineering·Social Work 등 개인 진술서·추천서, Population & Global Health 에세이)' },
      { item: '확인 못 함', content: '국제학생 학비 금액 — 학비 계산기(https://www.mcgill.ca/student-accounts/tuition-charges/fallwinter-term-tuition-and-fees/undergraduate-fees)에서 학위·국제 선택' },
    ],
  },
  {
    name: 'UBC', year: '2027', term: '9월',
    sourceUrl: 'https://you.ubc.ca/applying-ubc/dates-deadlines/',
    choices: [{ label: '1지망', n: 1 }, { label: '2지망', n: 1 }],
    requirements: [
      { item: '원서 포털', content: 'https://you.ubc.ca/applying-ubc/how-to-apply/application/' },
      { item: '지망', content: '1지망·2지망 학위 선택 (다른 학부·다른 캠퍼스 가능). EducationPlannerBC로 지원' },
      { item: '일정', content: '접수 2026년 10월 초 시작 / International Scholars 장학 지원 2026-11-15 23:59 PST / 지원 마감 2027-01-15 23:59 PST / International Scholars 서류·영어 1/31 / 영어 증빙(ELAS) 2/15 / 캐나다 밖 고교 서류 3/15 / 발표 2026년 11월~2027년 6월 수시 / 수락·예치금 5/1 또는 6/1 (합격 통지서 기준)' },
      { item: '전형료', content: '국제 학생 CAD 173.25 (환불 불가). 학위에 따라 추가 비용 있을 수 있음' },
      { item: 'Personal profile', content: '고교 지원자는 대부분 필수 (예외: Design in Architecture·Dental Hygiene·Music). 문항마다 50~500 words(500~2,100자)' },
      { item: '영어', content: 'IELTS Academic 6.5 (각 6.0) / TOEFL 90 (R22·L22·W21·S21) 또는 신 척도 4.5 (R4.5·L5·W4.5·S4) / Duolingo 125 / 2027 입학은 2025-01-01 이후 응시분만, 1회 응시 점수' },
      { item: '영어 면제', content: '영어 수업 국제학교라도 아래면 충족: IB Diploma 재학, CIS(Council of International Schools) 인증 학교 또는 미국 지역 인증 학교에서 4년 이상 + 12학년(비ESL) 이수. 4년 미만이면 AP English Lang/Lit 4 이상 또는 IB English A 5 이상' },
      { item: '보충 지원 (Vancouver)', content: 'Commerce: 개인 프로필 안 영상 인터뷰 / Computer Science·Design in Architecture·Media Studies·Midwifery·Sciences Po 복수학위: 보충 지원서 / Fine Arts: 전공별 포트폴리오 등 / Music·Nursing·Education: 보충 지원서+자료 / Pharmaceutical Sciences: 추가 전형료+녹화 인터뷰 / Food and Resource Economics: 학업 계획서' },
      { item: '확인 못 함', content: '학위·학력(국가)별 세부 요건 — https://you.ubc.ca/applying-ubc/requirements/international-high-schools/ 에서 국가·학위 선택. 국제학생 학비 — https://you.ubc.ca/financial-planning/tuition-fees/' },
    ],
  },
];
module.exports.MEMO = MEMO;
