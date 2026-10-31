'use strict';
/**
 * HKU 학부 원서 (2027 입학) — 원서 연습용 양식
 * 2026-10-31 HKU Application System(ug.hku.hk)의 연습 계정으로 결제 직전까지 들어가 칸 이름·필수(*)·글자 수 제한·선택 목록을 옮김
 * + 공식 Step by Step Guide(2027 Intake). 선택 목록은 hku-2027-lists.json (포털에서 그대로).
 *
 * 칸 t: text(기본) textarea date(dd-mm-yyyy) select list(목록에서 고르거나 직접) radio check number info quals repeat
 * pre: Compass 학생 정보로 채울 수 있는 칸 (public/index.html 의 APF_PREFILL)
 */
const L = require('./hku-2027-lists.json');

const YES_NO = ['Yes', 'No'];
const DUAL = [
  'Dual Degree with Peking University in Bachelor of Economics and Finance (Application Deadline: January 31, 2027)',
  'Dual Degree with Peking University Dual Degree in Bachelor of Laws (Application Deadline: January 31, 2027)',
  'Dual Degree with Peking University in Politics, Philosophy and Economics (PPE) (Application Deadline: January 31, 2027)',
  'Dual Degree with Sciences Po in Bachelors of Arts, Business and Administration, and Social Sciences (Application Deadline: March 1, 2027)',
  'Dual Degree with University of British Columbia Sauder School of Business in Business and Administration (Application Deadline: January 31, 2027)',
  'Dual Degree with University of California Berkeley in Bachelors of Arts and Social Sciences (Application Deadline: November 30, 2026)',
  'Dual Degree with University College London in Bachelor of Laws (Application Deadline: January 31, 2027)',
  'HKU-Cambridge Undergraduate Recruitment Scheme (Engineering)',
];
const DECLARATION = [
  'I declare that the information to be given in support of this application is accurate and complete, and I understand that any misrepresentation will disqualify my application to the University and the University has the right to make a report to the relevant law enforcement agencies which may result in criminal prosecution.',
  'I authorize The University of Hong Kong to obtain, and the relevant examination authorities, assessment bodies or academic institutions in Hong Kong and elsewhere to release any and all information about my public examination results, records of studies or professional qualifications. I also authorize the University to use my data in this form for the purpose of obtaining such information.',
  'I accept that all the data in this form and those the University is authorized to obtain will be used for purposes related to the processing and administration of my application in the university context.',
  "I understand that if I am a current full-time Bachelor's degree student studying UGC-funded programme in one of the local tertiary institutions or a de-registered or discontinued student of the University and I fail to declare this, I may be disqualified even after being offered admission.",
  'I note the general points pursuant to the Personal Data (Privacy) Ordinance as set out in the Personal Information Collection Statement and the General Data Protection Regulation.',
  'I have read the General Information and agreed to the information, terms and conditions stated.',
  'I declare that I only submit one application for admission in any one academic year, and I fully understand submitting duplicate applications will result in immediate account suspension. The university may disqualify the application and any offer(s) made by the University may be withdrawn.',
  'I understand and agree that I am personally responsible for the authenticity of the application materials submitted to the University, whether by myself or an agent/intermediary appointed by me.',
  "I understand that The University of Hong Kong is a 'public body' and is therefore subject to the Prevention of Bribery Ordinance.",
];
const prevHku = (k, label, noLabel, noMax) => [
  { k: k, l: label, t: 'check', full: 1 },
  { k: k + 'Prog', l: 'Programme', max: 80 }, { k: k + 'Year', l: 'Year' }, { k: k + 'No', l: noLabel, max: noMax },
];

module.exports = {
  id: 'hku-2027',
  uni: 'HKU',
  title: 'HKU Application System for Undergraduate Programmes',
  intake: '2027',
  portal: 'https://ug.hku.hk/hku-applicant/hku/index/login.xhtml',
  checkedAt: '2026-10-31',
  notes: [
    '지원 학과는 최대 3개(1지망 + 그 밖 2개, 1지망 외에는 같은 순위). 학과 변경은 2026년 11월 25일 정오(홍콩 시간)까지.',
    'Personal Statement(1편, 학과 수와 상관없이)·성적표·CV·수상 증명은 포털에 글로 쓰는 칸이 없고, 원서비 결제 후 PDF로 올립니다 (파일 1개 10MB 이하).',
    '마지막 Declaration 단계에는 손글씨 서명란이 있습니다 (마우스로 직접 서명).',
  ],
  lists: L,
  tabs: [
    { key: 'personal', title: 'Personal Particulars', sections: [
      { title: 'Personal Information', note: 'Please enter your name in English exactly as it appears on your Identification Card or passport.', fields: [
        { k: 'familyName', l: 'Family Name / Surname / Last Name', req: 1, pre: 'familyName' },
        { k: 'givenName', l: 'Given Name / First Name', req: 1, pre: 'givenName' },
        { k: 'chineseName', l: 'Chinese Name' },
        { k: 'dob', l: 'Date of Birth', req: 1, t: 'date', pre: 'dob' },
        { k: 'nationality', l: 'Nationality / Place of Domicile', req: 1, t: 'select', list: 'countriesHK' },
        { k: 'sex', l: 'Sex', req: 1, t: 'select', o: ['Male', 'Female'] },
        { k: 'email', l: 'E-mail', req: 1, pre: 'email', help: '계정을 만들 때 쓴 이메일 (바꿀 수 없음)' },
        { k: 'email2', l: 'Secondary E-mail', req: 1 },
        { k: 'residence', l: 'Country / Region of Residence', req: 1, t: 'select', list: 'countries' },
      ] },
      { title: 'Identity', fields: [
        { k: 'visa', l: 'For your studies at HKU in the 2027/28 admission year (commencement date: 1 September 2027), will you need a Student Visa / Entry Permit?', t: 'radio', o: YES_NO, full: 1 },
        { t: 'info', text: '(I understand I will be required to provide the latest copy of my identification document for entry to Hong Kong to the University prior to registration)' },
        { k: 'hkid', l: 'HKID Card No.', ph: 'A123456(7)', max: 12 },
        { k: 'cnid', l: 'China Identity Card No.' },
        { k: 'passport', l: 'Passport No.', max: 20, pre: 'passport' },
        { k: 'noPassport', l: 'I do not have my passport.', t: 'check' },
      ] },
      { title: 'Contact', fields: [
        { k: 'phoneCode', l: "Student's Contact Number — country", req: 1, t: 'select', list: 'dial' },
        { k: 'phoneArea', l: 'Area Code', max: 8 },
        { k: 'phone', l: "Student's Contact Number", req: 1, max: 30, pre: 'phone' },
        { k: 'phone2Code', l: 'Alternate / Secondary Contact Number — country', t: 'select', list: 'dial' },
        { k: 'phone2Area', l: 'Area Code', max: 8 },
        { k: 'phone2', l: 'Alternate / Secondary Contact Number', max: 30 },
        { k: 'address', l: 'Correspondence Street Address', req: 1, full: 1, pre: 'addressEn' },
        { k: 'addrCountry', l: 'Country / Region', req: 1, t: 'select', list: 'countries' },
        { k: 'addrProvince', l: 'Province / State', req: 1, t: 'list', list: 'provinces', help: '중국 본토를 고르면 목록이 나옴' },
        { k: 'addrCity', l: 'City / District', req: 1, t: 'list', list: 'citiesShanghai', help: '목록은 상해(Shanghai)를 골랐을 때 기준' },
      ] },
    ] },
    { key: 'profile', title: 'Academic Profile', intro: [
      'Please provide information on your academic history starting with your secondary / junior high school studies. This information should include any course that is in progress, interrupted, or otherwise.',
      'This information will be used for processing and evaluation of your application to the University. Omission of your academic history may lead to disqualification of your application or withdrawal or any offers given.',
    ], sections: [
      { title: 'Academic History and Course Enrollment between September 2026 to June 2027', fields: [
        { k: 'notEnrolled', l: 'I am not enrolled in any course of academic study between September 2026 to June 2027', t: 'check', full: 1 },
        { k: 'studyCountry', l: 'Country / Region in which your study is pursued', req: 1, t: 'select', list: 'countries' },
        { k: 'studyProvince', l: 'Province / State', t: 'list', list: 'provinces' },
        { k: 'studyCity', l: 'City / District', t: 'list', list: 'citiesShanghai' },
        { k: 'school', l: 'Name of Institution / School', req: 1, t: 'list', list: 'schoolsShanghai', pre: 'schoolFull', help: '목록은 상해 학교 기준 (도시를 고르면 그 도시 학교가 나옴)' },
      ] },
      { title: 'Current Programme of Study', fields: [
        { k: 'curriculum', l: 'Type of Programme / Curriculum', req: 1, t: 'select', list: 'curricula' },
        { k: 'level', l: 'Level of Study', req: 1, t: 'select', list: 'levels' },
        { k: 'completed', l: 'Have you completed this study?', req: 1, t: 'radio', o: YES_NO },
        { k: 'mode', l: 'Study Mode', req: 1, t: 'select', list: 'studyModes' },
        { k: 'startDate', l: 'Start Date', req: 1, t: 'date' },
        { k: 'currentLevel', l: 'Current Level of Study', req: 1, max: 50, ph: 'e.g. Grade 12', pre: 'gradeEn' },
        { k: 'gradDate', l: 'Expected Date of Completion / Graduation', req: 1, t: 'date' },
      ] },
      { title: 'Previous Studies', note: '「+ Institution」로 이전 학교를 하나씩 추가 (중·고등학교부터)', fields: [
        { k: 'prev', t: 'repeat', add: 'Institution', cols: [
          { k: 'school', l: 'Name of Institution' }, { k: 'type', l: 'Type of Programme', t: 'list', list: 'curricula' },
          { k: 'country', l: 'Country / Region', t: 'select', list: 'countries' }, { k: 'title', l: 'Programme Title' },
          { k: 'mode', l: 'Study Mode', t: 'select', list: 'studyModes' }, { k: 'gpa', l: 'GPA' },
          { k: 'from', l: 'Study Period — from', t: 'date' }, { k: 'to', l: 'Study Period — to', t: 'date' },
        ], pre: 'prevSchools' },
      ] },
      { title: 'Year of Schooling', note: 'Please indicate below your highest level of qualification to be obtained by September for our evaluation purpose.', fields: [
        { k: 'highest', l: 'Highest Qualification to be obtained by August 2027', req: 1, t: 'list', list: 'highest', help: '포털에서는 위에 입력한 교육 과정에 따라 선택지가 바뀜' },
        { k: 'bachelor', l: "Have you enrolled in any bachelor's degree programme(s)?", req: 1, t: 'select', list: 'bachelor', full: 1 },
        { t: 'info', text: 'Please confirm below the years of education you have received in the primary / secondary / post-secondary level by August 31, 2027. This should take into account only your regular school. Short courses / summer courses / repeated studies should not be counted in this calculation. If any of the level of study is not applicable, please enter "0"' },
        { k: 'yPrimary', l: 'Primary Education', req: 1, t: 'number', suffix: 'years full-time study or its equivalent' },
        { k: 'ySecondary', l: 'Secondary / Junior & Senior High School Education', req: 1, t: 'number', suffix: 'years full-time study or its equivalent' },
        { k: 'yTertiary', l: 'Tertiary / University-level Education', req: 1, t: 'number', suffix: 'years full-time study or its equivalent' },
      ] },
    ] },
    { key: 'quals', title: 'Academic Qualifications', intro: [
      "1. Click the '+Qualification' button and input BOTH predicted and actual grades/scores (if applicable).",
      '2. Inform your counsellor to enter your predicted or actual grades/scores into the system. If they are unable to do so in the system, please ask them to contact the Admissions Office via email at counsellors@hku.hk.',
      '3. Make sure to complete the above for ALL the qualifications you have already finished OR are still in progress.',
    ], sections: [
      { title: 'Qualifications', note: '시험마다 「+ Qualification」 → 과목마다 「+ Subject」. 점수가 아직 없으면 Pending. 실제 점수는 결과 발표일(Date of Result Release) 이후에만 넣을 수 있음.', fields: [
        { k: 'quals', t: 'quals', pre: 'quals' },
      ] },
    ] },
    { key: 'choice', title: 'Choice of Programme', intro: [
      'You may submit an application for UP TO 3 undergraduate programmes at the University. With the exception of your top programme choices, all other programmes will be considered as equally ranked. Evaluation will take place concurrently and independently for all your programme choices. Changes to your programme choices will be allowed until 12:00 noon, Nov 25, 2026 (HKT).',
    ], sections: [
      { title: '1st Choice Programme', fields: [{ k: 'choice1', l: 'Programme', t: 'select', list: 'programmes', full: 1 }] },
      { title: 'Other Programme Choices', fields: [{ k: 'choice2', l: 'Programme', t: 'select', list: 'programmes', full: 1 }, { k: 'choice3', l: 'Programme', t: 'select', list: 'programmes', full: 1 }] },
      { title: 'Dual Degree and University Collaborative Programmes (separate application REQUIRED)', note: 'Each of these programmes will have a separate application (except for the HKU-PKU Dual Degree Programme in Law and Dual Degree with University College London in Bachelor of Law) and may also have additional entrance requirements. Indication of interest on this form DOES NOT replace an application to be submitted separately.',
        fields: DUAL.map((l, i) => ({ k: 'dual' + (i + 1), l: l, t: 'check', full: 1 })) },
      { title: 'Sports Scholarship Scheme', note: 'Please ensure that you complete and submit the APPLICATION FORM for the HKU Sports Scholarship Scheme 2027/28 by December 6, 2026 (Hong Kong Time).', fields: [
        { k: 'sports', l: 'I understand that I must submit the APPLICATION FORM by the above-mentioned deadline in order to be considered under the Sports Scholarship Scheme. Additionally, I understand that I will only be considered for my 1st programme choice under my admissions application to HKU.', t: 'check', full: 1 }] },
      { title: 'Talent Search Scheme (previously known as School Nominations Direct Admission Scheme (SNDAS))', note: 'Students pursuing the final year of the respective high-school curriculum are eligible for self-nomination. Have your school write a reference letter and upload all required documents to the application form for the Talent Search Scheme by December 7, 2026 (Hong Kong Time).', fields: [
        { k: 'talent', l: 'I would like to be considered under Talent Search Scheme and I understand that my school will support my self-nomination.', t: 'check', full: 1 }] },
      { title: 'Special Scholarships for Incoming Applicants', note: 'Students who wish to be considered MUST submit the Application Form for Special Scholarship by January 31, 2027 (Hong Kong Time). The selection is on a rolling basis.', fields: [
        { k: 'sch1', l: 'I would like to apply for the HeforShe Impact Champion Scholarship', t: 'check', full: 1 },
        { k: 'sch2', l: 'I would like to apply for the Hon Ping Entrance Scholarship for Nigerian Students', t: 'check', full: 1 },
        { k: 'sch3', l: 'I would like to apply for Hong Kong Scholarships for Belt and Road countries', t: 'check', full: 1 }] },
    ] },
    { key: 'reference', title: 'Reference', intro: [
      'You may nominate your counsellor to support your application to the University by providing predicted / anticipated result(s), transcripts, and reference documents. You may also nominate referees who may provide additional information to support your application.',
      "In the case that you are not able to find your counsellor under the 'Counsellor' list, please provide your counsellors' contact information as a referee and we will be in touch accordingly.",
      '추천인·카운슬러 정보는 원서 제출 후에는 고칠 수 없음. 추천인에게는 제출 후 이메일이 감. 카운슬러·추천인은 2026년 12월 1일까지 작성 권장.',
    ], sections: [
      { title: 'Referee / Counselor', note: 'School Counselor는 위 Academic Profile에서 고른 학교의 카운슬러 목록에서 고름 (목록에 없으면 Referee로 이름·이메일 직접 입력)', fields: [
        { k: 'refs', t: 'repeat', add: 'Referee', pre: 'refs', cols: [
          { k: 'rel', l: 'Relationship', t: 'select', o: ['School Counselor', 'Referee'], req: 1 },
          { k: 'name', l: 'Name', max: 200, req: 1 }, { k: 'email', l: 'Email', max: 120, req: 1 },
          { k: 'desc', l: 'Relationship Description (Referee)', max: 120 },
          { k: 'disclose', l: 'I agree to disclose programme decision to counsellors (Counselor)', t: 'select', o: YES_NO },
        ] },
      ] },
    ] },
    { key: 'others', title: 'Others', sections: [
      { title: 'Disability Information', fields: [
        { k: 'disType', l: 'Type of Disability', t: 'select', list: 'disability' },
        { k: 'disDegree', l: 'Degree of Impairment', max: 30 },
        { k: 'disDesc', l: 'Description', t: 'textarea', max: 400, full: 1 },
      ] },
      { title: 'Previous Programme of Study at the University of Hong Kong', fields: [].concat(
        prevHku('hkuDereg', 'I have been de-registered by the University due to outstanding fee payment. (Outstanding fees must be settled before an offer of admission can be made.)', 'University No.', 10),
        prevHku('hkuReg', 'I have registered with the University before.', 'University No.', 10),
        prevHku('hkuDisc', 'I was discontinued from studies by the University. (By regulation, you cannot be re-admitted to the same programme of study. This will not however affect your chance of admission to other programmes.)', 'University No.', 10),
        prevHku('hkuPrevApp', 'I have previously submitted an application to the University and was not successful', 'Application No.', 30)) },
      { title: 'Declaration', note: '「Proceed to Payment for Submission of Application」을 누르면 나오는 단계 — 체크하고 손글씨 서명 후 Accept → 결제', fields: [
        { t: 'info', list: DECLARATION },
        { k: 'declare', l: 'I have read and understood the above stated terms and conditions.', t: 'check', full: 1 },
      ] },
    ] },
    { key: 'upload', title: '결제 후 올릴 서류', practice: 1, intro: [
      '포털에는 글로 쓰는 칸이 없고, 원서비를 낸 뒤 「Upload Supporting Document」에서 PDF로 올리는 것들. 여기서는 미리 준비 상태를 체크하고 Personal Statement 초안을 써 둡니다.',
      '파일은 PDF만, 1개 10MB 이하. 여러 장이면 하나로 합침. 올린 파일은 지우거나 볼 수 없고, 다시 올리면 최신 것이 공식. 이름 규칙을 따를 것.',
    ], sections: [
      { title: 'Personal Statement', note: '학과 수와 상관없이 1편. 글자 수 제한은 포털·안내서에 적혀 있지 않음 — HKU 학과 안내를 확인하세요.', fields: [
        { k: 'ps', l: 'Personal Statement 초안', t: 'textarea', full: 1, big: 1, words: 1 },
      ] },
      { title: '준비할 서류', fields: [
        { k: 'docTranscript', l: 'High school transcript (성적표)', t: 'check', full: 1 },
        { k: 'docCv', l: 'CV, certificates and awards (이력서·수상 증명)', t: 'check', full: 1 },
        { k: 'docExam', l: 'Certificates of public examinations and proof of English language and second language proficiency (시험 성적표·어학 증빙)', t: 'check', full: 1 },
        { k: 'docDegree', l: 'Degree certificates and official transcripts (for current university students)', t: 'check', full: 1 },
        { k: 'docOther', l: 'Any other required documents (그 밖의 서류)', t: 'check', full: 1 },
      ] },
    ] },
  ],
};
