// 위장 게이지 대결 — 학교 시험 컨셉 게임 로직
// 규칙: 모든 문제는 "정답 보기 + 오답 보기" 구조. 바보는 정답을 피하고 오답을 골라야 안전.
//       정답 보기를 고르면 그 과목 점수가 오른다(똑똑함 들통). 6교시가 끝났을 때 총점이 낮은 사람이 승리.
// 숫자는 전부 실측 전 추정치입니다.

const SUBJECTS = ['국어', '영어', '수학', '사회', '과학', '예체능'];

const CARD_SUBJECT = {
  korean: '국어',
  english: '영어',
  math: '수학',
  social: '사회',
  science: '과학',
  giboo: '예체능',
  leftright: '예체능',
};

const ALL_SUBJECT_CARDS = ['korean', 'english', 'math', 'social', 'science', 'giboo', 'leftright'];

const CONFIG = {
  scoreWarningMargin: 40, // 상대보다 이 점수 이상 뒤지면(총점이 더 높으면) "출근 위험" 경고
  comboBonusStackThreshold: 5,
  comboBonusStack: 1,
  turboBonusStack: 1,
  interferePreviewMs: 1800,
  roundTimeoutMs: 5000, // 한 문제 제한시간 (초과 시 실패 처리)
  paceTimeoutMs: 3500, // 안전/터보 선택 제한시간
  botMistakeRate: 0.2, // 솔로 테스트용 봇이 정답을 골라버릴 확률
  thinkFreeMs: 3000, // 이 시간 안에 고르면 벌점 없음 (넘기면 '고민 = 똑똑함 들통')
  slowPointsPerSec: 6, // 3초를 넘긴 시간 1초당 쌓이는 점수 (최대 30)
  patrolMs: 3000, // 선생님 순찰(멈춰!) 지속 시간
  patrolPenalty: 15, // 순찰 중 움직이면(컨닝) 쌓이는 점수
  rushMs: 2500, // '시간 단축' 방해: 남은 시간을 이만큼으로 줄임
  inkMs: 2500, // '잉크 번짐' 방해: 보기가 흐려지는 시간
  phases: [
    { id: 'warmup', label: '워밍업', durationSec: 30, cardPool: ['giboo'], hint: '외친 것이 아닌 걸 골라요 (점수 없음)' },
    { id: 'b0', label: '쉬는 시간', durationSec: 5, isBreak: true, cardPool: [] },
    { id: 'p1', label: '1교시 국어', subject: '국어', durationSec: 150, cardPool: ['korean'], hint: '글자색과 이름이 다른 하나를 찾아요' },
    { id: 'b1', label: '쉬는 시간', durationSec: 5, isBreak: true, cardPool: [] },
    { id: 'p2', label: '2교시 영어', subject: '영어', durationSec: 150, cardPool: ['english'], hint: '철자가 틀린 단어 하나를 찾아요 · 선생님이 순찰하면 손 떼기!', patrolCount: 1 },
    { id: 'b2', label: '쉬는 시간', durationSec: 5, isBreak: true, cardPool: [] },
    { id: 'p3', label: '3교시 수학', subject: '수학', durationSec: 150, cardPool: ['math'], allowInterfere: true, allowPace: true, hint: '나머지와 다른 하나를 찾아요 · 방해 3종(낙서·잉크·시간단축)·족보·안전/터보 등장!', patrolCount: 1 },
    { id: 'b3', label: '쉬는 시간', durationSec: 5, isBreak: true, cardPool: [] },
    { id: 'p4', label: '4교시 사회', subject: '사회', durationSec: 150, cardPool: ['social'], allowInterfere: true, allowPace: true, eventCount: 1, patrolCount: 1, hint: '막힌 길 / 틀린 수도를 찾아요' },
    { id: 'b4', label: '쉬는 시간', durationSec: 5, isBreak: true, cardPool: [] },
    { id: 'p5', label: '5교시 과학', subject: '과학', durationSec: 150, cardPool: ['science'], allowInterfere: true, allowPace: true, eventCount: 1, patrolCount: 1, hint: '물에 뜨는 것·자석에 붙는 것·곤충… 틀린 보기를 찾아요' },
    { id: 'b5', label: '쉬는 시간', durationSec: 5, isBreak: true, cardPool: [] },
    { id: 'p6', label: '6교시 예체능·종합', subject: '예체능', durationSec: 150, cardPool: ALL_SUBJECT_CARDS, allowInterfere: true, allowPace: true, eventCount: 1, patrolCount: 2, blind: true, doubleLastMs: 30000, hint: '점수 비공개! 마지막 30초는 점수 2배! 순찰도 두 번!' },
  ],
};

// 테스트용: PHASE_SPEED=10 이면 전체 교시표가 10배 빨리 진행됩니다 (예: PHASE_SPEED=10 npm start → 16분이 약 1.6분)
const SPEED = Number(process.env.PHASE_SPEED) > 0 ? Number(process.env.PHASE_SPEED) : 1;
if (SPEED !== 1) {
  CONFIG.phases.forEach((ph) => { ph.durationSec = Math.max(1, Math.round(ph.durationSec / SPEED)); });
  CONFIG.patrolMs = Math.max(800, Math.round(CONFIG.patrolMs / SPEED));
  CONFIG.phases.forEach((ph) => { if (ph.doubleLastMs) ph.doubleLastMs = Math.max(500, Math.round(ph.doubleLastMs / SPEED)); });
}
if (process.env.NO_PATROL) CONFIG.phases.forEach((ph) => { ph.patrolCount = 0; }); // 테스트용

// 카드(=과목별 문제 유형): tier 1~3, penalty = 정답을 골라버렸을 때 그 과목에 쌓이는 점수
const CARDS = {
  giboo: { id: 'giboo', name: '예체능 · 가위바위보', subject: '예체능', tier: 1, penalty: 18, stackGain: 0.5 },
  leftright: { id: 'leftright', name: '예체능 · 구령', subject: '예체능', tier: 1, penalty: 18, stackGain: 0.5 },
  korean: { id: 'korean', name: '국어', subject: '국어', tier: 2, penalty: 24, stackGain: 1 },
  math: { id: 'math', name: '수학', subject: '수학', tier: 2, penalty: 24, stackGain: 1 },
  english: { id: 'english', name: '영어', subject: '영어', tier: 3, penalty: 30, stackGain: 1.5 },
  social: { id: 'social', name: '사회', subject: '사회', tier: 3, penalty: 30, stackGain: 1.5 },
  science: { id: 'science', name: '과학', subject: '과학', tier: 2, penalty: 24, stackGain: 1 },
};

const COLORS = ['빨강', '파랑', '초록'];
const COLOR_HEX = { 빨강: '#E24B4A', 파랑: '#378ADD', 초록: '#639922' };

const NUM_FORMS = {
  1: { digit: '1', kr: '일', en: 'one', hanja: '一' },
  2: { digit: '2', kr: '이', en: 'two', hanja: '二' },
  3: { digit: '3', kr: '삼', en: 'three', hanja: '三' },
  4: { digit: '4', kr: '사', en: 'four', hanja: '四' },
};

const ENGLISH_WORDS = ['apple', 'banana', 'orange', 'grape', 'lemon', 'melon', 'tiger', 'horse', 'rabbit', 'monkey', 'school', 'teacher', 'pencil', 'window', 'friend', 'family', 'garden', 'summer', 'winter', 'purple'];

const CAPITALS = [
  ['한국', '서울'], ['일본', '도쿄'], ['중국', '베이징'], ['프랑스', '파리'], ['영국', '런던'], ['독일', '베를린'],
  ['이탈리아', '로마'], ['스페인', '마드리드'], ['미국', '워싱턴'],
  ['이집트', '카이로'], ['태국', '방콕'], ['러시아', '모스크바'],
];

// 과학: 전문 지식 없이 1~2초에 보이는 생활 상식만 (웃으면서 풀 수 있어야 함)
const PLANETS = ['수성', '금성', '지구', '화성', '목성', '토성', '천왕성', '해왕성'];
const NOT_PLANETS = ['달', '태양', '별', 'UFO'];
const FLOATS = ['나무토막', '스티로폼', '튜브', '오리 인형', '코르크', '풍선'];
const SINKS = ['돌멩이', '쇠못', '동전', '벽돌', '열쇠'];
const MAGNETIC = ['쇠못', '클립', '나사', '철사'];
const NON_MAGNETIC = ['종이', '나무젓가락', '고무줄', '유리컵', '비닐', '플라스틱 자'];
const INSECTS = ['개미', '나비', '벌', '파리', '모기', '잠자리', '메뚜기', '매미', '무당벌레'];
const NON_INSECTS = ['고양이', '토끼', '금붕어', '참새', '코끼리'];
const HOT = ['불', '용암', '난로', '불꽃', '끓는 물'];
const COLD = ['얼음', '눈사람', '아이스크림'];

const DIRS = ['위', '아래', '왼쪽', '오른쪽'];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN(arr, n) {
  return shuffle(arr).slice(0, n);
}

// items: [{label, type, color?, dir?, desc?, right:boolean}] → 셔플 후 키 부여
function buildRound(card, { stem, visual, items }) {
  const shuffled = shuffle(items);
  const options = shuffled.map((it, i) => ({
    key: 'k' + i,
    label: it.label,
    type: it.type || 'text',
    color: it.color || null,
    dir: it.dir || null,
    desc: it.desc || it.label,
  }));
  const excludeValues = shuffled.map((it, i) => (it.right ? 'k' + i : null)).filter(Boolean); // 정답 보기 = 피해야 할 것
  return {
    cardId: card.id,
    cardName: card.name,
    subject: card.subject,
    tier: card.tier,
    penalty: card.penalty,
    stackGain: card.stackGain,
    stem,
    visual: visual || null,
    options,
    correctMode: 'excludeMulti',
    excludeValues,
    issuedAt: Date.now(),
  };
}

function misspell(word) {
  const vowels = 'aeiou';
  const methods = [
    () => {
      const idxs = [];
      for (let i = 0; i < word.length - 1; i++) if (word[i] !== word[i + 1]) idxs.push(i);
      if (!idxs.length) return null;
      const i = pick(idxs);
      const c = word.split('');
      [c[i], c[i + 1]] = [c[i + 1], c[i]];
      return c.join('');
    },
    () => {
      if (word.length < 5) return null;
      const i = 1 + Math.floor(Math.random() * (word.length - 2));
      const c = word.split('');
      c.splice(i, 1);
      return c.join('');
    },
    () => {
      const i = 1 + Math.floor(Math.random() * (word.length - 1));
      const c = word.split('');
      c.splice(i, 0, c[i]);
      return c.join('');
    },
    () => {
      const idxs = word.split('').map((ch, i) => (vowels.includes(ch) ? i : -1)).filter((i) => i >= 0);
      if (!idxs.length) return null;
      const i = pick(idxs);
      const c = word.split('');
      c[i] = pick(vowels.split('').filter((v) => v !== c[i]));
      return c.join('');
    },
  ];
  for (let t = 0; t < 30; t++) {
    const r = pick(methods)();
    if (r && r !== word && !ENGLISH_WORDS.includes(r)) return r;
  }
  return word.split('').reverse().join('');
}

function generateRound(cardId) {
  const card = CARDS[cardId];

  if (cardId === 'giboo') {
    const shout = pick(['가위', '바위', '보']);
    return buildRound(card, {
      stem: '외친 것은?',
      visual: { type: 'bubble', text: `${shout}!` },
      items: ['가위', '바위', '보'].map((h) => ({ label: h, type: 'hand', right: h === shout })),
    });
  }

  if (cardId === 'leftright') {
    const dir = pick(['왼쪽', '오른쪽']);
    return buildRound(card, {
      stem: '화살표가 가리키는 쪽은?',
      visual: { type: 'arrow', dir },
      items: ['왼쪽', '오른쪽'].map((d) => ({ label: d, type: 'arrow', dir: d, right: d === dir })),
    });
  }

  if (cardId === 'korean') {
    const matched = COLORS.map((c) => ({ label: c, type: 'colorword', color: COLOR_HEX[c], desc: `${c}(글자색: ${c})`, right: true }));
    const name = pick(COLORS);
    const color = pick(COLORS.filter((c) => c !== name));
    const odd = { label: name, type: 'colorword', color: COLOR_HEX[color], desc: `${name}(글자색: ${color})`, right: false };
    return buildRound(card, { stem: '글자색과 이름이 같은 것은?', items: [...matched, odd] });
  }

  if (cardId === 'english') {
    const words = pickN(ENGLISH_WORDS, 4);
    const oddIdx = Math.floor(Math.random() * 4);
    const items = words.map((w, i) => ({ label: i === oddIdx ? misspell(w) : w, type: 'text', right: i !== oddIdx }));
    return buildRound(card, { stem: '철자가 맞는 단어는?', items });
  }

  if (cardId === 'math') {
    const variant = pick(['forms', 'forms', 'parity', 'multiples']);
    if (variant === 'forms') {
      const nums = [1, 2, 3, 4];
      const target = pick(nums);
      const other = pick(nums.filter((n) => n !== target));
      const same = pickN(Object.values(NUM_FORMS[target]), 3).map((l) => ({ label: l, type: 'text', right: true }));
      const odd = { label: pick(Object.values(NUM_FORMS[other])), type: 'text', right: false };
      return buildRound(card, { stem: '같은 수를 나타내는 것은?', items: [...same, odd] });
    }
    if (variant === 'parity') {
      const wantOdd = Math.random() < 0.5; // true면 "홀수는?" (정답 3개=홀수, 오답=짝수)
      const pool = [];
      for (let n = 11; n <= 99; n++) pool.push(n);
      const same = pickN(pool.filter((n) => (n % 2 === 1) === wantOdd), 3);
      const odd = pick(pool.filter((n) => (n % 2 === 1) !== wantOdd));
      return buildRound(card, {
        stem: wantOdd ? '홀수는?' : '짝수는?',
        items: [...same.map((n) => ({ label: String(n), type: 'text', right: true })), { label: String(odd), type: 'text', right: false }],
      });
    }
    const k = pick([3, 4, 5, 6, 7]);
    const multiples = [];
    for (let m = 2; m <= 9; m++) multiples.push(k * m);
    const nonMultiples = [];
    for (let n = 10; n <= 60; n++) if (n % k !== 0) nonMultiples.push(n);
    const same = pickN(multiples, 3);
    const odd = pick(nonMultiples);
    return buildRound(card, {
      stem: `${k}의 배수는?`,
      items: [...same.map((n) => ({ label: String(n), type: 'text', right: true })), { label: String(odd), type: 'text', right: false }],
    });
  }

  if (cardId === 'social') {
    if (Math.random() < 0.5) {
      const blocked = pick(DIRS);
      return buildRound(card, {
        stem: '갈 수 있는 길은?',
        visual: { type: 'cross', blocked },
        items: DIRS.map((d) => ({ label: d, type: 'arrow', dir: d, right: d !== blocked })),
      });
    }
    const four = pickN(CAPITALS, 4);
    const oddIdx = Math.floor(Math.random() * 4);
    const items = four.map(([country, capital], i) => {
      if (i !== oddIdx) return { label: `${country} - ${capital}`, type: 'text', right: true };
      const wrongCap = pick(CAPITALS.filter(([c]) => c !== country))[1];
      return { label: `${country} - ${wrongCap}`, type: 'text', right: false };
    });
    return buildRound(card, { stem: '수도가 맞는 것은?', items });
  }

  if (cardId === 'science') {
    const v = pick(['planet', 'float', 'float', 'magnet', 'insect', 'hot']);
    const mk = (stem, good, bad) => buildRound(card, {
      stem,
      items: [...pickN(good, 3).map((l) => ({ label: l, type: 'text', right: true })), { label: pick(bad), type: 'text', right: false }],
    });
    if (v === 'planet') return mk('태양계 행성은?', PLANETS, NOT_PLANETS);
    if (v === 'float') return mk('물에 뜨는 것은?', FLOATS, SINKS);
    if (v === 'magnet') return mk('자석에 붙는 것은?', MAGNETIC, NON_MAGNETIC);
    if (v === 'insect') return mk('곤충은?', INSECTS, NON_INSECTS);
    return mk('뜨거운 것은?', HOT, COLD);
  }

  throw new Error('unknown card ' + cardId);
}

function createPlayerState() {
  const scores = {};
  SUBJECTS.forEach((s) => { scores[s] = 0; });
  return {
    scores,
    stack: 0,
    combo: 0,
    warning: false,
    defeated: false, // 세션 종료 시 총점이 더 높은 쪽에만 true
    currentRound: null,
    incoming: null,
    trapColor: null,
    trapProgress: 0,
    trapTarget: 0,
    pendingCardId: null,
    periodStartTotal: 0,
    rushNext: false,
    stats: { fails: 0, successes: 0, timeouts: 0, turbo: 0, safe: 0, throws: { doodle: 0, ink: 0, rush: 0 }, defendOk: 0, trapEscapes: 0, maxCombo: 0, caught: 0, hints: 0, slowPoints: 0 },
  };
}

function totalScore(p) {
  return Object.values(p.scores).reduce((a, b) => a + b, 0);
}

module.exports = { CONFIG, CARDS, COLORS, COLOR_HEX, SUBJECTS, CARD_SUBJECT, generateRound, createPlayerState, totalScore };
