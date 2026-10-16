'use strict';
/**
 * 대학 정보 초기 자료 (2026-10-16 조사).
 * 공식 사이트·공식 PDF를 인용한 검색 결과와 학원 Drive의 서울대 모집요강을 바탕으로 정리했습니다.
 * 모든 연도 정보는 "확인 필요" 상태로 들어가며, 선생님이 공식 사이트에서 확인한 뒤 "확인 완료"로 바꾸는 것을 전제로 합니다.
 * 처음 한 번만(대학 목록이 비어 있을 때) DB에 들어갑니다.
 */
const NOTE = 'Compass 초기 자료(2026-10-16 조사). 공식 사이트에서 확인한 뒤 "확인 완료"로 바꿔주세요.';

module.exports = [
  // ---------------- 홍콩 ----------------
  {
    country: '홍콩', name: 'HKU', fullName: 'The University of Hong Kong', aliases: '홍콩대, 홍콩대학교, University of Hong Kong',
    website: 'https://admissions.hku.hk/apply/international-qualifications',
    tips: '[내부 기록 — 학생 트래커에서 옮김]\n· 입학 후 전과 불가 → 지원 시 전공을 확정해야 함\n· HKU Engineering: 최저 SAT 1400 + AP 4점 3개 (김지성 트래커 메모)\n· Business School 최소요건 미충족 시 경영 지원 보류 사례 있음 (전승주)',
    cycles: [{
      year: '2027', term: '9월',
      sourceUrl: 'https://admissions.hku.hk/apply/international-qualifications',
      memo: NOTE + '\n1차 마감은 대부분 자료가 2026-11-25 12:00(HKT)로 표기하지만 일부 자료(Grove Education)는 11-26으로 표기 — 공식 확인 필요.\n참고: https://ug.hkubs.hku.hk/admission-key-date/non-jupas',
      requirements: [
        { item: '지원 경로', content: 'International / Non-JUPAS 온라인 지원 (2026-09-23 접수 시작)' },
        { item: 'Personal Statement', content: '필수 (분량·문항은 지원 포털에서 확인 필요)' },
        { item: '제출 서류', content: '학교 성적(School record), 영어 시험 점수, 번역 성적표(해당 시)' },
        { item: '면접', content: '1차 라운드 선발자 대상 2026년 12월 ~ 2027년 3월 (전공별)' },
        { item: '결과 발표', content: '1차 라운드 결과 2026년 12월 말부터' },
        { item: '전공 목록', content: 'https://admissions.hku.hk/programmelist' },
      ],
      rounds: [
        { name: '1차 라운드 (Early)', deadline: '2026-11-25', memo: '12:00 noon HKT. 이후 접수분은 롤링 심사' },
        { name: '최종 마감 (Rolling)', deadline: '2027-08-25', memo: '일부 자료는 2027-08-21로 표기 — 확인 필요' },
      ],
    }],
    majors: [{ name: 'Psychology (BPsych)', code: '6705', faculty: 'Faculty of Social Sciences', detail: '확인 필요 — 전공별 요건은 공식 전공 페이지 참고' }],
  },
  {
    country: '홍콩', name: 'HKUST', fullName: 'The Hong Kong University of Science and Technology', aliases: '홍콩과기대, 홍콩과학기술대, Hong Kong University of Science and Technology',
    website: 'https://join.hkust.edu.hk/admissions/international-qualifications',
    tips: '',
    cycles: [{
      year: '2027', term: '9월',
      sourceUrl: 'https://join.hkust.edu.hk/admissions/international-qualifications',
      memo: NOTE + '\n공식 페이지에는 Priority Round(2026-11-25)와 롤링 심사만 확인됨. Main Round 2027-01-08은 제3자 자료(Grove Education)에만 있어 넣지 않았음.',
      requirements: [
        { item: '지원 경로', content: 'International Qualifications 온라인 지원' },
        { item: '심사 방식', content: '2026-11-26부터 롤링 심사, 오퍼는 2026년 12월 말부터' },
        { item: '장학금', content: '입학 장학금은 지원 시 자동 심사 (Future Leaders Award는 별도 신청)' },
        { item: '입학 예치금', content: 'HKD 20,000 (비현지 학생, 2026학년도 공식 페이지 기준)' },
      ],
      rounds: [
        { name: 'Priority Round (Early)', deadline: '2026-11-25', memo: '' },
        { name: '최종 마감 (Rolling)', deadline: '2027-06-30', memo: '지원 시스템 마감' },
      ],
    }],
    majors: [{ name: 'Innovation Design and Technology (IDT)', detail: '확인 필요' }],
  },
  {
    country: '홍콩', name: 'CUHK', fullName: 'The Chinese University of Hong Kong', aliases: '중문대, 홍콩중문대, Chinese University of Hong Kong',
    website: 'https://admission.cuhk.edu.hk/',
    tips: '',
    cycles: [{
      year: '2027', term: '9월',
      sourceUrl: 'https://admission.cuhk.edu.hk/application/non-jupas/faq/',
      memo: NOTE + '\n날짜는 Non-JUPAS FAQ 기준. 국제학생 전형 가이드(https://www.cuhk.edu.hk/adm/ApplicationGuide/ApplicationGuide_International.pdf)와 같은지 확인 필요. Advance Offer 결과 시점은 가이드(1월 중순)와 중요일정 페이지(12월부터)가 상충.',
      requirements: [
        { item: '전형료', content: 'HK$500 (2027 entry, 환불 불가)' },
        { item: 'Advance Offer', content: '11월 마감 지원자 대상 확정/조건부 오퍼. 의대(MBChB)는 해당 없음' },
        { item: 'Regular Round 이후', content: '정원이 남은 경우에만 추가 접수' },
      ],
      rounds: [
        { name: 'Advance Offer Round (Early)', deadline: '2026-11-12', memo: '' },
        { name: 'Regular Round', deadline: '2027-01-07', memo: '' },
      ],
    }],
    majors: [],
  },
  {
    country: '홍콩', name: 'CityU', fullName: 'City University of Hong Kong', aliases: '시티대, 홍콩시티대, CityUHK, City University of Hong Kong',
    website: 'https://www.cityu.edu.hk/admo/application-period',
    tips: '',
    cycles: [{
      year: '2027', term: '9월',
      sourceUrl: 'https://cityu.edu.hk/admo/news/2027_Flyer_INTL_Admission.pdf',
      memo: NOTE + '\nEarly 2026-11-15는 Non-JUPAS 안내문 레이아웃상 날짜-라벨 대응이 불확실함(국제 안내문에는 Regular만 표기). TOEFL 기준은 안내문 표기가 이상해 공식 확인 필요.',
      requirements: [
        { item: '전형료', content: '약 HKD 600 (USD 77)' },
        { item: '지원 전공 수', content: '최대 2개' },
        { item: '학업 기준', content: 'IB 30점 이상 / A-level 3과목 E 이상 / 미국계: 고교 졸업 + SAT 1190 이상 또는 AP 2과목 3점 이상' },
        { item: '영어', content: 'IELTS 6.5 이상 (TOEFL 기준은 공식 확인 필요)' },
        { item: 'Regular 이후', content: '일부 전공은 마감 후에도 접수' },
      ],
      rounds: [
        { name: 'Early Round', deadline: '2026-11-15', memo: '확인 필요 (위 메모 참고)' },
        { name: 'Regular Round', deadline: '2027-01-15', memo: '' },
      ],
    }],
    majors: [],
  },
  {
    country: '홍콩', name: 'PolyU', fullName: 'The Hong Kong Polytechnic University', aliases: '이공대, 홍콩이공대, Hong Kong Polytechnic University',
    website: 'https://www.polyu.edu.hk/study/ug/admissions/international-other-qualifications',
    tips: '',
    cycles: [{
      year: '2027', term: '9월',
      sourceUrl: 'https://www.polyu.edu.hk/saso/docdrive/Public/AdmissionLeaflets/infosheet_non_jupas_2027.pdf',
      memo: NOTE,
      requirements: [
        { item: '지원 경로', content: 'IB / A-level 등 국제 학력 소지자는 eAdmission으로 직접 지원 (2026-09-23 접수 시작)' },
        { item: '전형료', content: 'HK$600' },
        { item: '학업 기준(참고)', content: '최근 기준 A-level 3과목 B 이상 또는 IB 32점 이상. IB 예상 30점 이상이면 면접 대상 가능' },
        { item: 'Extended Round', content: '국제학생만 해당' },
      ],
      rounds: [
        { name: 'Early Round', deadline: '2026-11-17', memo: '' },
        { name: 'Main Round', deadline: '2027-02-11', memo: '' },
        { name: 'Extended Round', deadline: '2027-05-14', memo: '국제학생만' },
      ],
    }],
    majors: [],
  },
  // ---------------- 싱가폴 ----------------
  {
    country: '싱가폴', name: 'NUS', fullName: 'National University of Singapore', aliases: '싱가포르국립대, National University of Singapore',
    website: 'https://www.nus.edu.sg/oam/admissions/important-dates',
    tips: '[내부 기록] 에세이 7개 (허세진 트래커 메모 — 공식 문항 수는 확인 필요)',
    cycles: [{
      year: '2027', term: '8월',
      sourceUrl: 'https://www.nus.edu.sg/oam/admissions/important-dates',
      memo: NOTE + '\n공식 페이지의 AY2027/28 "International Qualifications (IB Diploma 제외)" 기간. IB Diploma 지원 기간은 별도라 확인 필요.',
      requirements: [
        { item: '지원 기간', content: '2026-12-16 ~ 2027-02-17 (IB Diploma 제외 국제 학력)' },
        { item: '결과 발표', content: '대부분 5월 셋째 주 / 2027년 5월 IB 응시자는 7월 셋째 주' },
      ],
      rounds: [{ name: 'Regular', deadline: '2027-02-17', memo: 'IB Diploma 제외' }],
    }],
    majors: [],
  },
  {
    country: '싱가폴', name: 'NTU', fullName: 'Nanyang Technological University', aliases: '난양공대, Nanyang Technological University',
    website: 'https://www.ntu.edu.sg/admissions/undergraduate/admissions',
    tips: '',
    cycles: [{
      year: '2027', term: '8월',
      sourceUrl: 'https://www.ntu.edu.sg/admissions/undergraduate/admissions',
      memo: NOTE + '\n접수 시작(2026-10-15)은 공식 페이지에서 확인됨. 마감 2027-03-19는 제3자 자료 기준(러시아·중앙아시아 학력은 2027-01-20이라는 자료도 있음) — 공식 확인 필요.',
      requirements: [{ item: '지원 기간', content: '2026-10-15 접수 시작 (IB Diploma 포함 국제 학력)' }],
      rounds: [{ name: 'Regular', deadline: '2027-03-19', memo: '확인 필요' }],
    }],
    majors: [],
  },
  {
    country: '싱가폴', name: 'SUTD', fullName: 'Singapore University of Technology and Design', aliases: 'Singapore University of Technology and Design, 싱가포르기술디자인대',
    website: 'https://www.sutd.edu.sg/admissions/undergraduate/',
    tips: '',
    cycles: [{
      year: '2027', term: '9월',
      sourceUrl: 'https://www.sutd.edu.sg/admissions/undergraduate/',
      memo: NOTE + '\n2027 입학 공식 일정과 에세이 문항을 찾지 못했음. 참고로 작년(AY2026) 국제학생 마감은 2026-03-02였다는 자료가 있음.',
      requirements: [{ item: '상태', content: '2027 공식 일정·에세이 요건 미확인 — 공식 사이트 확인 후 입력' }],
      rounds: [],
    }],
    majors: [],
  },
  {
    country: '싱가폴', name: 'SMU', fullName: 'Singapore Management University', aliases: 'Singapore Management University, 싱가포르경영대',
    website: 'https://admissions.smu.edu.sg/admissions-requirements/important-dates',
    tips: '',
    cycles: [{
      year: '2027', term: '8월',
      sourceUrl: 'https://admissions.smu.edu.sg/admissions-requirements/important-dates',
      memo: NOTE + '\n2027 일정은 아직 찾지 못했음. 아래는 작년(AY2026-27) 기준: 접수 2025-11-17 ~ 2026-03-19 23:59(싱가포르 시간), 시험 성적 제출 2026-03-31.',
      requirements: [
        { item: '국제 학력', content: 'SMU 목록에 있는 국제 학력만 인정' },
        { item: '시험 기준(작년)', content: 'SAT 1350 이상, IELTS Academic 7.0 이상' },
      ],
      rounds: [],
    }],
    majors: [],
  },
  // ---------------- 캐나다 ----------------
  {
    country: '캐나다', name: 'McGill', fullName: 'McGill University', aliases: 'McGill University, 맥길, 맥길대',
    website: 'https://www.mcgill.ca/undergraduate-admissions/',
    tips: '[내부 기록] 기본 장학금은 지원 시 자동 심사, Major Entrance Scholarship은 합격 통지 후 McGill Applicant Portal에서 별도 신청 (전승주 트래커)',
    cycles: [{
      year: '2027', term: '9월',
      sourceUrl: 'https://www.mcgill.ca/undergraduate-admissions/',
      memo: NOTE + '\n날짜·전형료는 제3자 자료 기준. 의대·치대는 별도의 더 이른 마감.',
      requirements: [
        { item: '대상', content: '캐나다·미국 외 고교 출신 지원자' },
        { item: '전형료', content: 'CAD 140.16 (제3자 자료, 환불 불가)' },
        { item: '접수 시작', content: '2026-10-01' },
      ],
      rounds: [{ name: 'Regular', deadline: '2027-01-15', memo: 'Arts, Science, Engineering, Management 등 대부분 학과' }],
    }],
    majors: [{ name: '심리학 (Psychology)', detail: '확인 필요' }],
  },
  {
    country: '캐나다', name: 'UBC', fullName: 'The University of British Columbia', aliases: 'University of British Columbia, 브리티시컬럼비아대',
    website: 'https://you.ubc.ca/applying-ubc/',
    tips: '',
    cycles: [{
      year: '2027', term: '9월',
      sourceUrl: 'https://you.ubc.ca/applying-ubc/',
      memo: NOTE + '\n날짜는 제3자 자료 기준. Early 2026-12-01은 한 곳에만 있어 넣지 않았음. International Major Entrance Scholarship은 마감 내 지원 시 자동 심사.',
      requirements: [{ item: '장학금', content: 'International Scholars Program(need+merit)은 일반 마감보다 이른 11월 마감' }],
      rounds: [
        { name: 'International Scholars Program 마감', deadline: '2026-11-15', memo: '23:59 PST, 장학 프로그램 지원자만' },
        { name: 'Regular', deadline: '2027-01-15', memo: '' },
      ],
    }],
    majors: [{ name: '심리학 (Psychology)', detail: '확인 필요' }],
  },
  {
    country: '캐나다', name: 'University of Toronto', fullName: 'University of Toronto', aliases: 'UofT, U of T, Toronto, 토론토대',
    website: 'https://future.utoronto.ca/apply/',
    tips: '[내부 기록] TOEFL 최저 89 (전승주 트래커에서 정정 확인)',
    cycles: [{
      year: '2027', term: '9월',
      sourceUrl: 'https://future.utoronto.ca/apply/',
      memo: NOTE + '\n2027-28 공식 안내: OUAC 지원 2026년 9월 말 시작. 해외 거주·캐나다 수학 경험 없는 지원자는 U of T International Application 사용 가능. 일부 학과는 다른 마감(제3자 자료) — 학과별 확인 필요.',
      requirements: [{ item: '지원 경로', content: 'OUAC 또는 U of T International Application' }],
      rounds: [
        { name: '조기 심사 권장일 (Early)', deadline: '2026-11-07', memo: '이날까지 제출하면 가장 이른 심사 라운드에 포함' },
        { name: '최종 마감 (Regular)', deadline: '2027-01-15', memo: '' },
      ],
    }],
    majors: [{ name: '심리학 (Psychology)', detail: '확인 필요' }],
  },
  // ---------------- 한국 ----------------
  {
    country: '한국', name: '서울대', fullName: '서울대학교 (Seoul National University)', aliases: '서울대학교, SNU, Seoul National University',
    website: 'https://admission.snu.ac.kr',
    tips: '',
    cycles: [
      {
        year: '2027', term: '3월',
        sourceUrl: 'https://drive.google.com/file/d/1skoDz9oC_SSVIo4U5sQFrx9CvnEQ1GeL/view',
        memo: NOTE + '\n출처: 학원 Drive의 「[서울대] 2027학년도 전기 글로벌인재특별전형 학사 모집안내(안)」. 이 전형(2027 전기)의 접수는 이미 끝남 — 다음 해 요강 비교용.',
        requirements: [
          { item: '전형', content: '글로벌인재특별전형 Ⅰ(부모 모두 외국인인 외국인) / Ⅱ(전 교육과정 해외 이수자)' },
          { item: '자기소개서 및 수학계획서', content: '온라인 입력, 띄어쓰기 포함 4,000 byte 이내 (한국어 약 2,000자, 영어 약 800단어). 부모·친인척 성명·직장명 등 기재 금지' },
          { item: '교사 추천서', content: '온라인 추천서 사이트로만 제출, 3,000 byte 이내 (한국어 약 1,500자, 영어 약 600단어)' },
          { item: '어학', content: 'TOEFL iBT 80 이상(2026-01-21 이후 응시는 4.0 이상) / IELTS Academic 6.0 이상 / TEPS 269 이상 / TOPIK 3급 이상 중 하나 (응시일 2024-07-09 이후). TOEFL MyBest·Home Edition 인정, ITP 불인정' },
          { item: '전형료', content: '70,000원' },
          { item: '면접', content: '서류 검토 결과 필요한 경우에만 실시 (단과대학별). 글로벌인재특별전형Ⅱ는 화상면접' },
          { item: '주요 일정(2027 전기)', content: '원서접수 2026-07-06 ~ 07-09 17:00 / 추천서 ~07-10 17:00 / 예비합격 10-16 / 원본서류 ~11-03 / 합격 발표 11-20' },
        ],
        rounds: [
          { name: '원서접수 (전기)', deadline: '2026-07-09', memo: '17:00 KST (마감됨)' },
          { name: '추천서 제출', deadline: '2026-07-10', memo: '17:00 KST (마감됨)' },
        ],
      },
      {
        year: '2027', term: '9월',
        sourceUrl: 'https://admission.snu.ac.kr',
        memo: NOTE + '\n2027학년도 후기(9월 입학) 모집요강이 나오면 일정과 요건을 입력하세요. 전기 요강의 요건을 참고로 복사해 두었습니다.',
        requirements: [
          { item: '상태', content: '후기 모집요강 미발표 — 발표 후 확인' },
          { item: '참고(전기 기준) 자기소개서 및 수학계획서', content: '4,000 byte 이내 (영어 약 800단어)' },
          { item: '참고(전기 기준) 교사 추천서', content: '3,000 byte 이내 (영어 약 600단어)' },
        ],
        rounds: [],
      },
    ],
    majors: [
      { name: '자연과학대학 생명과학부', detail: '확인 필요' },
      { name: '공과대학 재료공학부', detail: '확인 필요' },
      { name: '공과대학 에너지자원공학과', detail: '확인 필요' },
    ],
  },
  {
    country: '한국', name: 'KAIST', fullName: 'Korea Advanced Institute of Science and Technology', aliases: '카이스트, 한국과학기술원',
    website: 'https://admission.kaist.ac.kr',
    tips: '',
    cycles: [{
      year: '2027', term: '9월',
      sourceUrl: 'https://admission.kaist.ac.kr',
      memo: NOTE + '\n아래는 외국인(International) 전형 기준. 한국 국적(이중국적 포함)은 이 전형 지원 불가 — 재외국민(12특 등) 전형은 별도 요강 확인 필요. Regular 일정은 제3자 자료이며 봄학기만이라는 보도도 있어 상충.',
      requirements: [
        { item: '대상', content: '외국인 전형: 한국 국적·이중국적자 지원 불가. 2027-08-31까지 고교 졸업 필요(가을 입학)' },
        { item: 'Early', content: '2026-09-22 ~ 10-22 18:00 KST, 추천서 10-29까지. Spring/Fall 2027 입학 선택 가능' },
      ],
      rounds: [
        { name: 'Early (외국인 전형)', deadline: '2026-10-22', memo: '18:00 KST, 추천서 2026-10-29' },
        { name: 'Regular (외국인 전형)', deadline: '2027-01-14', memo: '제3자 자료 — 확인 필요' },
      ],
    }],
    majors: [],
  },
];
