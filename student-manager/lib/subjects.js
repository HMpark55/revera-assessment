'use strict';
/**
 * 커리큘럼별 과목 목록 (목록 관리 › 과목의 처음 값). 2026-10 확인:
 *   AP — College Board 과목 목록 (apstudents.collegeboard.org/courses), 'AP ' 앞머리는 뺌
 *   IB — DP 과목 그룹 1~6 (+ 코어). 언어 과목은 우리 학생이 많이 듣는 언어 위주 (다른 언어는 목록 관리에서 추가)
 *   MYP — 8개 과목군 (실제 과목명은 학교마다 달라서 과목군으로 고르고 메모에 학교 과목명)
 *   IGCSE (Cambridge) — cambridgeinternational.org Cambridge IGCSE subjects, (9-1)판은 같은 과목으로 합침
 *   IGCSE (Edexcel) — Pearson Edexcel International GCSE 과목표
 *   A-Level (Cambridge) — Cambridge International AS & A Level subjects
 *   A-Level (Edexcel) — Pearson Edexcel International Advanced Level 과목표 (Mathematics 계열은 Further·Pure 포함)
 */
const SUBJECTS = {
  AP: ['2-D Art and Design', '3-D Art and Design', 'Drawing', 'Art History', 'Music Theory',
    'English Language and Composition', 'English Literature and Composition',
    'African American Studies', 'Comparative Government and Politics', 'European History', 'Human Geography', 'Macroeconomics', 'Microeconomics',
    'Psychology', 'United States Government and Politics', 'United States History', 'World History: Modern',
    'Calculus AB', 'Calculus BC', 'Computer Science A', 'Computer Science Principles', 'Precalculus', 'Statistics',
    'Biology', 'Chemistry', 'Environmental Science', 'Physics 1: Algebra-Based', 'Physics 2: Algebra-Based',
    'Physics C: Electricity and Magnetism', 'Physics C: Mechanics',
    'Chinese Language and Culture', 'French Language and Culture', 'German Language and Culture', 'Italian Language and Culture',
    'Japanese Language and Culture', 'Latin', 'Spanish Language and Culture', 'Spanish Literature and Culture',
    'Research', 'Seminar', 'Business with Personal Finance', 'Cybersecurity'],
  IB: [
    // Group 1
    'English A: Language and Literature', 'English A: Literature', 'Korean A: Language and Literature', 'Korean A: Literature',
    'Chinese A: Language and Literature', 'Chinese A: Literature', 'Japanese A: Language and Literature', 'Japanese A: Literature', 'Literature and Performance',
    // Group 2
    'English B', 'Chinese B (Mandarin)', 'Japanese B', 'French B', 'Spanish B', 'German B',
    'Mandarin ab initio', 'Spanish ab initio', 'French ab initio', 'Japanese ab initio', 'Latin', 'Classical Greek',
    // Group 3
    'Business Management', 'Economics', 'Geography', 'Global Politics', 'History', 'Philosophy', 'Psychology',
    'Social and Cultural Anthropology', 'World Religions', 'Digital Society',
    // Group 4
    'Biology', 'Chemistry', 'Physics', 'Computer Science', 'Design Technology', 'Sports, Exercise and Health Science',
    'Environmental Systems and Societies',
    // Group 5
    'Mathematics: Analysis and Approaches', 'Mathematics: Applications and Interpretation',
    // Group 6
    'Dance', 'Film', 'Music', 'Theatre', 'Visual Arts',
    // 코어·총점
    'Theory of Knowledge (TOK)', 'Extended Essay (EE)', 'Total (45점 만점)'],
  MYP: ['Language and literature', 'Language acquisition', 'Individuals and societies', 'Sciences', 'Mathematics', 'Arts',
    'Physical and health education', 'Design', 'Personal Project', 'Interdisciplinary'],
  'IGCSE (Cambridge)': ['Accounting', 'Afrikaans - Second Language', 'Agriculture', 'Arabic - First Language', 'Arabic - Foreign Language', 'Art & Design',
    'Bahasa Indonesia', 'Biology', 'Business', 'Business Studies', 'Chemistry', 'Chinese - First Language', 'Chinese - Second Language',
    'Chinese (Mandarin) - Foreign Language', 'Commerce', 'Computer Science', 'Design & Technology', 'Drama', 'Economics',
    'English - First Language', 'English - First Language (US)', 'English - Literature in English', 'English (as an Additional Language)',
    'English as a Second Language', 'Enterprise', 'Environmental Management', 'Food & Nutrition', 'French - First Language', 'French - Foreign Language',
    'Geography', 'German - First Language', 'German - Foreign Language', 'Global Perspectives', 'Hindi as a Second Language', 'History',
    'History - American (US)', 'Information and Communication Technology', 'IsiZulu as a Second Language', 'Islamiyat', 'Italian - Foreign Language',
    'Japanese - Foreign Language', 'Latin', 'Malay - First Language', 'Malay - Foreign Language', 'Marine Science', 'Mathematics',
    'Mathematics - Additional', 'Mathematics - International', 'Mathematics (US)', 'Music', 'Pakistan Studies', 'Physical Education',
    'Physical Science', 'Physics', 'Portuguese - First Language', 'Psychology', 'Religious Studies', 'Sanskrit', 'Science - Combined',
    'Sciences - Co-ordinated', 'Sciences - Co-ordinated (Double)', 'Setswana - First Language', 'Sociology', 'Spanish - First Language',
    'Spanish - Foreign Language', 'Spanish - Literature in Spanish', 'Statistics', 'Swahili', 'Thai - First Language', 'Travel & Tourism',
    'Turkish - First Language', 'Urdu as a Second Language', 'Vietnamese - First Language', 'World Literature'],
  'IGCSE (Edexcel)': ['Accounting', 'Arabic (First Language)', 'Art and Design', 'Bangla', 'Bangladesh Studies', 'Biology', 'Business', 'Chemistry',
    'Chinese', 'Commerce', 'Computer Science', 'Economics', 'English as a Second Language', 'English Language Specification A',
    'English Language Specification B', 'English Literature', 'French', 'Further Pure Mathematics', 'Geography', 'German', 'Global Citizenship',
    'Greek (First Language)', 'History', 'Human Biology', 'Information and Communication Technology (ICT)', 'Islamic Studies',
    'Mathematics Specification A', 'Mathematics Specification B', 'Pakistan Studies', 'Physics', 'Religious Studies', 'Science Single Award',
    'Science Double Award', 'Sinhala', 'Spanish', 'Swahili', 'Tamil'],
  'A-Level (Cambridge)': ['Accounting', 'Afrikaans - Language (AS only)', 'Arabic', 'Arabic - Language (AS only)', 'Art & Design', 'Biblical Studies',
    'Biology', 'Business', 'Chemistry', 'Chinese - Language & Literature (A Level only)', 'Chinese Language (AS only)', 'Classical Studies',
    'Computer Science', 'Design & Technology', 'Digital Media & Design', 'Drama', 'Economics', 'English - Language and Literature (AS only)',
    'English - Literature', 'English General Paper (AS only)', 'English Language', 'Environmental Management (AS only)', 'European History',
    'French Language & Literature', 'French Language (AS only)', 'Geography', 'German - Language (AS only)',
    'German Language & Literature (A Level only)', 'Global Perspectives & Research', 'Hinduism', 'History', 'Information Technology',
    'International History', 'Islamic Studies', 'Law', 'Marine Science', 'Mathematics', 'Further Mathematics', 'Media Studies', 'Music',
    'Physics', 'Portuguese - Language (AS only)', 'Portuguese (A Level only)', 'Psychology', 'Sociology',
    'Spanish - Language & Literature (A Level only)', 'Spanish Language (AS only)', 'Sport & Physical Education (AS only)', 'Tamil',
    'Thinking Skills', 'Travel & Tourism', 'Urdu', 'US Government & Politics', 'US History since 1877', 'US History to 1877'],
  'A-Level (Edexcel)': ['Accounting', 'Arabic', 'Biology', 'Business', 'Chemistry', 'Economics', 'English Language', 'English Literature', 'French',
    'Geography', 'German', 'Greek', 'History', 'Information Technology', 'Law', 'Mathematics', 'Further Mathematics', 'Pure Mathematics',
    'Physics', 'Psychology', 'Spanish'],
};

/** 성적 종류(scores.kind) · 수강 과목 레벨(courses.level) → 고를 과목 목록 */
const KIND_CATS = {
  AP: ['AP'], IB: ['IB'], 'IB Predicted': ['IB'], MYP: ['MYP'],
  IGCSE: ['IGCSE (Cambridge)', 'IGCSE (Edexcel)'], 'A-Level': ['A-Level (Cambridge)', 'A-Level (Edexcel)'],
};
const LEVEL_CATS = {
  AP: ['AP'], 'IB HL': ['IB'], 'IB SL': ['IB'], MYP: ['MYP'],
  IGCSE: ['IGCSE (Cambridge)', 'IGCSE (Edexcel)'], 'A-Level': ['A-Level (Cambridge)', 'A-Level (Edexcel)'], 'AS-Level': ['A-Level (Cambridge)', 'A-Level (Edexcel)'],
};

module.exports = { SUBJECTS, KIND_CATS, LEVEL_CATS };
