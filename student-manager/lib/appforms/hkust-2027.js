'use strict';
/**
 * HKUST 학부 원서 (2027/28 입학, International Qualifications) — 원서 연습용 양식
 * 2026-10-31 HKUST Online Application(w5.ab.ust.hk)에 들어가 최고 학력 「SAT + AP Subjects/Subject Tests」로 원서를 만들고
 * 제출(Finalize and Submit) 전까지 칸 이름·필수(*)·글자 수 제한·선택 목록을 옮김. 선택 목록은 hkust-2027-lists.json (포털에서 그대로).
 *
 * 칸 t: text(기본) textarea date(dd-mm-yyyy) month(mm/yyyy) select list radio check info repeat exams
 * pre: Compass 학생 정보로 채울 수 있는 칸 (public/index.html 의 APF_PREFILL)
 */
const L = require('./hkust-2027-lists.json');

const SAL = ['Dr', 'Miss', 'Mr', 'Ms', 'Prof'];
const MODE = ['Full-time', 'Part-time', 'Online School / Distance Learning'];
const referee = (who, msgLabel) => [
  { k: who + 'Sal', l: 'Salutation', req: 1, t: 'radio', o: SAL },
  { k: who + 'Last', l: 'Name of Referee (in English) — Surname', req: 1, max: 30, pre: who + 'Last' },
  { k: who + 'First', l: 'Given Name', max: 30, pre: who + 'First' },
  { k: who + 'Title', l: 'Title and Position', req: 1, max: 60, pre: who + 'Title' },
  { k: who + 'School', l: 'Name of School / Institution', req: 1, max: 254, pre: 'schoolFull' },
  { k: who + 'Country', l: 'Country / Region', t: 'list', list: 'countries', max: 30 },
  { k: who + 'Disclose', l: 'Disclose application status', t: 'select', o: ['I agree to disclose my application status to the above organization.', 'I do not agree to disclose my application status to the above organization.'], full: 1 },
  { k: who + 'Email', l: 'Email', req: 1, max: 50, pre: who + 'Email' },
  { k: who + 'Phone', l: 'Phone Number (Country · Area · Number)', ph: '86 · 21 · 12345678' },
  { k: who + 'Msg', l: msgLabel, t: 'textarea', full: 1 },
];
const subjList = (map) => ({ by: 'exam', map });

module.exports = {
  id: 'hkust-2027',
  uni: 'HKUST',
  title: 'HKUST Online Application for Undergraduate Programs',
  intake: '2027',
  portal: 'https://join.hkust.edu.hk/apply',
  checkedAt: '2026-10-31',
  notes: [
    'International Qualifications 원서. 정부 지원 과정(International / Gaokao / SNDAS)은 그중 한 곳에만 1번 지원할 수 있습니다.',
    '원서를 처음 만들 때 최고 학력(예: SAT + AP Subjects/Subject Tests, IB Diploma, A-Level)을 고르고, 그에 따라 고를 수 있는 학과 목록이 달라집니다 (아래 학과 목록은 SAT + AP 기준).',
    'Personal Statement·성적표·시험 성적·여권 사본은 Step 2 Upload Documents에서 파일로 올립니다 (전체 6MB까지). 제출 후에는 고치거나 지울 수 없습니다.',
    'Priority Round 마감 2026년 11월 25일. 추천인 정보는 제출하면 바꿀 수 없고, 제출 때 추천인에게 이메일이 갑니다.',
  ],
  lists: L,
  tabs: [
    { key: 'personal', title: '1. Personal Particulars', intro: ['Please complete in English, unless otherwise specified. 이름·생년월일·신분증 번호·국적·비자 상태는 신분증과 똑같이.'], sections: [
      { title: 'Personal Particulars', fields: [
        { k: 'surname', l: 'Name — Surname (same as in identity documents)', req: 1, max: 30, pre: 'familyName' },
        { k: 'givenName', l: 'Given Name', req: 1, max: 30, pre: 'givenName' },
        { k: 'chineseName', l: 'Name in Chinese (if applicable)', max: 50 },
        { k: 'dob', l: 'Date of Birth', req: 1, t: 'date', pre: 'dob', help: '포털은 일 / 월(Jan…) / 년 따로' },
        { k: 'gender', l: 'Gender', req: 1, t: 'radio', o: ['Male', 'Female'] },
      ] },
      { title: 'Personal Identification Number(s) *', note: 'For applicants from Chinese Mainland, please enter your Chinese Mainland ID Card number in “Other National ID Number” field and Passport number in “Travel Document Number” field if you possess both identity documents.', fields: [
        { k: 'hkid', l: 'Hong Kong ID Card Number', ph: 'A123456(7)' },
        { k: 'otherId', l: 'Other National ID Number', max: 20 },
        { k: 'otherIdCountry', l: 'Issuing Country / Region', t: 'select', list: 'countries' },
        { k: 'passport', l: 'Travel Document Number', max: 15, pre: 'passport' },
        { k: 'passportCountry', l: 'Issuing Country / Region', t: 'select', list: 'countries' },
        { k: 'citizenship', l: 'Citizenship', req: 1, t: 'select', list: 'countries' },
        { k: 'nativePlace', l: 'Native Place (Chinese Mainland applicants)', t: 'select', list: 'provinces' },
        { k: 'residence', l: 'Residence (Chinese Mainland applicants)', t: 'select', list: 'provinces' },
      ] },
      { title: 'Visa / Right of Abode Status *', fields: [
        { k: 'visa', l: 'Do you need a student visa or entry permit to study in Hong Kong?', req: 1, t: 'radio', o: ['Yes', 'No'], full: 1 },
        { k: 'noVisaWhy', l: 'No, because:', t: 'select', full: 1, o: [
          'I hold a Hong Kong Permanent ID (香港永久性居民身份證)',
          'I hold a One-way Permit for entry to Hong Kong / Hong Kong Document of Identity (單程證 / 簽證身份書)',
          'I hold a Visa label for unconditional stay (無條件限制逗留簽證)',
          'I hold a Hong Kong Dependant Visa (香港受養人簽證)'] },
      ] },
      { title: 'Address and Contact', fields: [
        { k: 'address', l: 'Home Address', req: 1, t: 'textarea', full: 1, pre: 'addressEn' },
        { k: 'postal', l: 'Postal Code', max: 12 },
        { k: 'addrCountry', l: 'Country / Region', t: 'select', list: 'countries' },
        { k: 'mailAddress', l: 'Mailing Address (if different from address above)', t: 'textarea', full: 1 },
        { k: 'mailPostal', l: 'Postal Code', max: 12 },
        { k: 'mailCountry', l: 'Country / Region', t: 'select', list: 'countries' },
        { k: 'mailFrom', l: 'Valid from', t: 'date' }, { k: 'mailTo', l: 'To', t: 'date' },
        { k: 'phoneHome', l: 'Phone Number — Home (Country · Area · Number)', ph: '86 · 21 · 12345678', help: '포털 칸: 국가 3자 · 지역 6자 · 번호 17자' },
        { k: 'phoneMobile', l: 'Mobile (Country · Area · Number)', ph: '86 · 13012345678', pre: 'phone' },
        { k: 'sms', l: 'I wish to receive information from HKUST via SMS', req: 1, t: 'radio', o: ['Yes', 'No'] },
        { k: 'email', l: 'Email Address', help: '계정을 만들 때 쓴 이메일이 자동으로 들어감 (모든 알림이 이 주소로)', pre: 'email' },
        { k: 'ustId', l: 'HKUST Student Number (if applicable)', max: 8 },
      ] },
      { title: 'Parent / Guardian Information', note: 'The information collected in this section will be used for future communication, event invitation and/or information sharing in related to HKUST undergraduate recruitment and admissions.', fields: [
        { k: 'parTitle', l: 'Title', t: 'radio', o: ['Dr', 'Mr', 'Mrs', 'Miss', 'Ms'], full: 1 },
        { k: 'parSurname', l: 'Name — Surname', max: 30, pre: 'parentSurname' },
        { k: 'parGiven', l: 'Given Name', max: 30, pre: 'parentGiven' },
        { k: 'parRel', l: 'Relationship', t: 'radio', o: ['Father', 'Mother', 'Guardian', 'Others'], pre: 'parentRel' },
        { k: 'parRelOther', l: 'Others :', max: 40 },
        { k: 'parEmail', l: 'Email Address', max: 50, pre: 'parentEmail' },
        { k: 'parPhone', l: 'Contact Phone Number (Country · Area · Number)', pre: 'parentPhone' },
      ] },
    ] },
    { key: 'program', title: '2. Program Choice', intro: ['You can select up to two choices. The first choice will be considered as your highest priority. Please note that the available list of programs is based on the highest qualification which you have declared.'], sections: [
      { title: 'Program Choice', fields: [
        { k: 'highest', l: 'Self-declared Highest Qualification', help: '원서를 처음 만들 때 고름 (Modify Qualification으로 바꿀 수 있음)', ph: 'e.g. SAT + AP Subjects/Subject Tests', full: 1 },
        { k: 'choice1', l: 'First Choice', req: 1, t: 'select', list: 'programmes', full: 1 },
        { k: 'choice2', l: 'Second Choice', t: 'select', list: 'programmes', full: 1 },
      ] },
    ] },
    { key: 'secedu', title: '3. Secondary Education', intro: [
      'Please list all secondary education you attended/are attending in reverse chronological order (최근 학교부터, 최대 30개).',
      'If you attended/are attending high school(s) outside your home country and require a student visa for study, please upload a copy of your student visa in Step 2 (1. HKID card, passport, and/or other identity documents).',
      'If you attended/are attending online high school(s), please check “Online School / Distance Learning”. Gap year / extensive leave in the recent 3 years → 11. Additional Information.',
    ], sections: [
      { title: 'Secondary Education', fields: [
        { k: 'schools', t: 'repeat', add: 'School', pre: 'secSchools', cols: [
          { k: 'name', l: 'Name of School', req: 1, max: 254, full: 1 },
          { k: 'country', l: 'Country / Region', t: 'list', list: 'countries', max: 30 }, { k: 'prov', l: 'Province / State', max: 30 },
          { k: 'from', l: 'Period of Attendance — from', req: 1, t: 'month' }, { k: 'to', l: 'to', t: 'month' },
          { k: 'mode', l: 'Mode', t: 'select', o: MODE },
          { k: 'gFrom', l: 'From Grade', max: 20 }, { k: 'gTo', l: 'to Grade', max: 20 },
          { k: 'compl', l: 'Date / Expected Date of Completion', t: 'month' },
        ] },
      ] },
    ] },
    { key: 'postsec', title: '4. Post-Secondary Education', intro: ['Skip this section if not applicable. (대학·전문대 등 고등학교 이후 과정이 있을 때만)'], sections: [
      { title: 'Post-Secondary Education', fields: [
        { k: 'post', t: 'repeat', add: 'Institution', cols: [
          { k: 'level', l: 'Level of Qualification', req: 1, t: 'select', list: 'qualiLevel' }, { k: 'levelOther', l: 'If Others, please specify', max: 40 },
          { k: 'inst', l: 'Awarding Institution', req: 1, max: 254 }, { k: 'country', l: 'Country / Region', t: 'list', list: 'countries', max: 30 },
          { k: 'title', l: 'Program Title (e.g. BSc in Biology)', req: 1, max: 80 }, { k: 'dur', l: 'Program Duration (years)', req: 1, max: 4 },
          { k: 'from', l: 'Period of Attendance — from', req: 1, t: 'month' }, { k: 'to', l: 'to', t: 'month' },
          { k: 'mode', l: 'Mode of Study', req: 1, t: 'select', o: MODE }, { k: 'yrs', l: 'No. of Years Completed', req: 1, max: 4 },
          { k: 'complBefore', l: 'Do you expect to complete this program before commencing study in HKUST?', t: 'radio', o: ['Yes', 'No'], full: 1 },
          { k: 'compl', l: 'Date / Expected Date of Completion', t: 'month' },
          { k: 'gpa', l: 'Latest GPA / Average Mark', req: 1, max: 7 }, { k: 'scale', l: 'on a scale of', max: 7 },
          { k: 'gpaWhen', l: 'at the end of Semester / Term (or Final)', max: 20 },
          { k: 'honor', l: 'Classification of Award', t: 'select', list: 'honorClass' }, { k: 'honorOther', l: 'If Others, please specify', max: 40 },
        ] },
      ] },
    ] },
    { key: 'exams', title: '5. Examination Results', intro: [
      'Please provide details of all public examinations you have taken during senior and junior secondary school years. For any forthcoming exams, leave the "Results" column blank and DO NOT enter school grades or predicted results.',
      '포털에서는 시험 종류별 링크(American / IB / British / Others 등)를 눌러 들어가서 입력하고 「Save and Return」.',
    ], sections: [
      { title: 'American Qual (SAT / AP / ACT)', note: 'HKUST University Code — ACT: 6986, SAT/AP: 2787. 성적은 College Board·ACT에서 직접 보내야 함. SAT는 College Board ID (Record Locator 아님).', fields: [
        { k: 'us', t: 'exams', add: 'Attempt', pre: 'usExams', exam: { l: 'Examination', list: 'usExams' },
          cols: [{ k: 'cand', l: 'Candidate No. / AP ID / College Board ID', max: 9 }, { k: 'month', l: 'Exam Month', req: 1, t: 'month' }],
          subj: subjList({ 'ACT': 'usSubj.ACT', 'Advanced Placement': 'usSubj.Advanced Placement', 'SAT': 'usSubj.SAT', 'SAT Reasoning Test (Pre-March 2016)': 'usSubj.SAT Reasoning Test (Pre-March 2016)', 'SAT Subject Tests': 'usSubj.SAT Subject Tests' }),
          grades: { by: 'exam', map: { 'Advanced Placement': 'apGrades' } } },
      ] },
      { title: 'International Baccalaureate', note: 'School Code 6자리 숫자, Personal Code 6자(소문자 3 + 숫자 3). IBO에서 HKUST(Institute Code 000252)로 성적 공개 허락. 예상 점수는 넣지 않음.', fields: [
        { k: 'ib', t: 'exams', add: 'Attempt', exam: { l: 'Examination', list: 'ibExams' },
          cols: [{ k: 'school', l: 'School Code', req: 1, max: 6 }, { k: 'pcode', l: 'Personal Code', max: 6 }, { k: 'mon', l: 'Exam Month', req: 1, t: 'select', list: 'ibMonths' }, { k: 'yr', l: 'Year', req: 1, max: 4 }],
          level: ['HL', 'SL'], subj: { by: 'level', map: { HL: 'ibHL', SL: 'ibSL' } }, grades: 'ibGrades' },
      ] },
      { title: 'British Qual (GCE AL / IAL / BTEC)', fields: [
        { k: 'uk', t: 'exams', add: 'Attempt', exam: { l: 'Examination', list: 'ukExams' },
          cols: [{ k: 'board', l: 'Examination Board', t: 'select', list: 'ukBoards' }, { k: 'cand', l: 'Candidate No.' }, { k: 'mon', l: 'Exam Month', req: 1, t: 'select', list: 'ukMonths' }, { k: 'yr', l: 'Year', req: 1, max: 4 }],
          level: 'text', subj: subjList({ 'GCE A-Level / International A-Level': 'alSubj', 'Singapore-Cambridge GCE AL': 'alSubj', 'GCSE': 'igcseSubj', 'IGCSE/ GCE O-Level': 'igcseSubj' }) },
      ] },
      { title: 'Others', note: 'Please list all subjects using their official full names. (Australia·Canada·HKDSE·India 등 다른 시험은 포털에 따로 링크가 있음)', fields: [
        { k: 'otherExam', t: 'exams', add: 'Attempt', exam: { l: 'Examination', text: 1, max: 100 },
          cols: [{ k: 'country', l: 'Country / Region', req: 1, t: 'select', list: 'countries' }, { k: 'month', l: 'Exam Month', req: 1, t: 'month' }, { k: 'info', l: 'Information about this examination, if any', t: 'textarea', full: 1 }],
          level: 'text' },
      ] },
    ] },
    { key: 'english', title: '6. English Language Proficiency', intro: ['Click the links below to provide / update your English examination results. 공식 성적표는 나오면 Step 2에 올림.'], sections: [
      { title: 'IELTS', fields: [
        { k: 'ielts', t: 'repeat', add: 'IELTS', pre: 'ielts', cols: [
          { k: 'cand', l: 'Candidate No.', max: 6 }, { k: 'date', l: 'Date / Proposed Date of Test', req: 1, t: 'date' }, { k: 'trf', l: 'Test Report Form No.', max: 18 },
          { k: 'l', l: 'Listening', t: 'select', list: 'ielts' }, { k: 'r', l: 'Reading', t: 'select', list: 'ielts' }, { k: 'w', l: 'Writing', t: 'select', list: 'ielts' },
          { k: 's', l: 'Speaking', t: 'select', list: 'ielts' }, { k: 'o', l: 'Overall Band Score', t: 'select', list: 'ielts' },
        ] },
      ] },
      { title: 'TOEFL iBT (from 21/01/2026)', note: 'HKUST TOEFL code 0170-00. Registration No.와 시험일이 틀리면 성적 확인이 안 됨. 새 형식은 1–6점 (0.5 단위).', fields: [
        { k: 'toefl', t: 'repeat', add: 'TOEFL', pre: 'toefl', cols: [
          { k: 'reg', l: 'Registration No.', max: 16 }, { k: 'date', l: 'Date / Proposed Date of Test', req: 1, t: 'date' },
          { k: 'r', l: 'Reading', t: 'select', list: 'toefl2026' }, { k: 'l', l: 'Listening', t: 'select', list: 'toefl2026' }, { k: 's', l: 'Speaking', t: 'select', list: 'toefl2026' },
          { k: 'w', l: 'Writing', t: 'select', list: 'toefl2026' }, { k: 't', l: 'Total Score', t: 'select', list: 'toefl2026' },
        ] },
      ] },
      { title: 'TOEFL iBT (prior to 21/01/2026)', note: '예전 형식 — 포털에서 점수를 직접 입력', fields: [
        { k: 'toeflOld', t: 'repeat', add: 'TOEFL', pre: 'toeflOld', cols: [
          { k: 'reg', l: 'Registration No.', max: 16 }, { k: 'date', l: 'Date / Proposed Date of Test', req: 1, t: 'date' },
          { k: 'r', l: 'Reading', max: 6 }, { k: 'l', l: 'Listening', max: 6 }, { k: 's', l: 'Speaking', max: 6 }, { k: 'w', l: 'Writing', max: 6 }, { k: 't', l: 'Total Score', max: 6 },
        ] },
      ] },
      { title: 'Others', fields: [
        { k: 'engOther', t: 'repeat', add: 'Test', cols: [
          { k: 'date', l: 'Date / Proposed Date of Test', req: 1, t: 'date' }, { k: 'test', l: 'Title of Test / Subject', req: 1, t: 'select', list: 'engOther' },
          { k: 'other', l: 'Other English Examination (name)', max: 60 }, { k: 'result', l: 'Result', max: 20 },
        ] },
      ] },
    ] },
    { key: 'awards', title: '7. Prizes and Awards', intro: ['Please provide the 5 most significant prizes or awards. If you have additional information, please upload your CV in Step 2.'], sections: [
      { title: 'Prizes and Awards', fields: [
        { k: 'awards', t: 'repeat', add: 'Award', cols: [
          { k: 'level', l: 'Level of Award', t: 'select', list: 'awardLevel' }, { k: 'levelOther', l: 'If Others, please specify', max: 40 },
          { k: 'body', l: 'Name of Awarding Body', max: 80 }, { k: 'title', l: 'Qualification / Award', max: 80 },
          { k: 'basis', l: 'Basis of Award', t: 'select', list: 'awardBasis' }, { k: 'date', l: 'Date / Expected Date of Award', t: 'month' },
        ] },
      ] },
    ] },
    { key: 'activities', title: '8. Extra-curricular Activities', intro: ['Please provide the 5 most significant activities/voluntary services. If you have additional information, please upload your CV in Step 2.', 'HKUST non-academic scholarships: Future Leaders Award (NEW), Beyond Academic Admissions Scheme — 따로 신청.'], sections: [
      { title: 'Extra-curricular Activities or Voluntary Work', fields: [
        { k: 'acts', t: 'repeat', add: 'Activity', cols: [
          { k: 'title', l: 'Title', max: 60, full: 1 }, { k: 'from', l: 'Period — from', t: 'month' }, { k: 'to', l: 'to', t: 'month' },
          { k: 'desc', l: 'Description (max 750 characters)', t: 'textarea', max: 750, full: 1 },
        ] },
      ] },
    ] },
    { key: 'work', title: '9. Working Experience', intro: ['Please list in reverse chronological order, up to 5 entries. If you have more working experiences, please upload your CV in Step 2.'], sections: [
      { title: 'Working Experience', fields: [
        { k: 'jobs', t: 'repeat', add: 'Job', cols: [
          { k: 'from', l: 'Employment Period — from', t: 'month' }, { k: 'to', l: 'to', t: 'month' },
          { k: 'mode', l: 'Full-time / Part-time', t: 'select', o: ['Full-time', 'Part-time'] }, { k: 'current', l: 'Currently Employed', t: 'check' },
          { k: 'employer', l: 'Employer', max: 80 }, { k: 'title', l: 'Title', max: 60 },
        ] },
      ] },
    ] },
    { key: 'statement', title: '10. Personal Statement', practice: 1, intro: [
      'The personal statement is all about YOU. We expect to find in your personal statement your strength, your passion, your interest, your future goals, or any information you feel will be of interest to the selection panel.',
      '포털에는 글 쓰는 칸이 없고 Step 2 Upload Documents에서 파일로 올립니다 (「3. Personal Statement *」 필수). 글자 수 제한은 포털 화면에 적혀 있지 않음 — Notes for Applicants를 확인하세요.',
    ], sections: [
      { title: 'Personal Statement 초안', fields: [{ k: 'ps', l: 'Personal Statement 초안', t: 'textarea', full: 1, big: 1, words: 1 }] },
    ] },
    { key: 'addinfo', title: '11. Additional Information', sections: [
      { title: 'Availability for Interviews (for applicants residing outside Hong Kong only)', note: 'As part of the assessment, candidates may be invited to attend admissions interview. Please indicate your availability and schedule to be present in Hong Kong for an interview at HKUST.', fields: [
        { k: 'interview', l: 'Availability to be present in Hong Kong', t: 'textarea', full: 1 },
        { k: 'interviewOnline', l: 'Interview may also be conducted online. Preferred schedule (in GMT+8:00), if available', max: 80, full: 1 },
      ] },
      { title: 'Gap Year / Extensive Leave', note: 'If you have taken a gap year / an extensive leave period in the recent 3 years, please provide the details, including the period and activities that you were engaged in.', fields: [
        { k: 'gap', l: 'Gap Year / Extensive Leave', t: 'textarea', full: 1 },
      ] },
    ] },
    { key: 'reference', title: '12. Academic Reference', intro: [
      'Please nominate an academic referee from your current or most recently attended high school or post-secondary institution.',
      '추천인 정보는 제출하면 바꾸거나 지울 수 없고, 제출 때 추천인 이메일로 추천서 양식이 갑니다. 추가 추천서는 학교 레터헤드·서명이 있는 파일로 Step 2에 올림.',
    ], sections: [
      { title: 'Academic Referee', fields: referee('ref', 'Message to referee, if any').concat([
        { k: 'refPredict', l: 'Please check the box if the nominated referee will also provide the predicted grades for the upcoming GCE / IB / Indian High School Examinations attempts.', t: 'check', full: 1 },
      ]) },
      { title: 'IB Coordinator / Career Counselor', fields: referee('cc', 'Message to IB Coordinator / Career Counselor, if any') },
    ] },
    { key: 'upload', title: 'Step 2. Upload Documents', practice: 1, intro: [
      'Before uploading, make sure the filename describes the content (e.g. grade 11 transcript, US passport, IB transcript). 영어·중국어가 아니면 공인 영문 번역본을 함께. 제출 후에는 고치거나 지울 수 없음. 전체 6MB까지.',
      '# 표시는 Finalize and Submit 전에 꼭 올려야 함, * 는 필수. 아직 없는 서류는 「Expected Date」를 적어 둘 수 있음.',
    ], sections: [
      { title: 'I. Required documents', fields: [
        { k: 'docId', l: '1. HKID card, passport, and/or other identity documents #', t: 'check', full: 1 },
        { k: 'docVisa', l: '2. Visa / Entry Permit / Landing Slip issued by HKSAR Immigration Department (if any)', t: 'check', full: 1 },
        { k: 'docPs', l: '3. Personal Statement *', t: 'check', full: 1 },
        { k: 'docTranscript', l: '4. High school transcript from Grade 10 onwards', t: 'check', full: 1 },
        { k: 'docExam', l: '5. Certificates of public examinations', t: 'check', full: 1 },
        { k: 'docDegree', l: '6. Degree certificate(s) and official transcript(s)', t: 'check', full: 1 },
        { k: 'docEnglish', l: '7. English language proficiency proof', t: 'check', full: 1 },
      ] },
      { title: 'II. Other additional documents', fields: [
        { k: 'docOther', l: '추가로 올릴 서류 (CV, 추가 추천서, 수상 증명 등)', t: 'textarea', full: 1 },
      ] },
    ] },
  ],
};
