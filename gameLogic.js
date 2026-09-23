// 위장 게이지 대결 - 게임 로직
// 실측 전 초기값입니다. 숫자는 전부 admin 콘솔에서 테스트 중 조정 가능하도록 별도 config로 뺐습니다.

const CONFIG = {
  gaugeStart: 100,
  warningThreshold: 30,
  comboHealThreshold: 5,
  comboHealAmount: 10,
  interferePreviewMs: 1800, // "○○카드 도착!" 예고 후 유예시간
  roundTimeoutMs: 4000, // 한 라운드 응답 제한시간
  phases: [
    { id: 'warmup', label: '워밍업', durationSec: 120, allowInterfere: false, cardPool: ['giboo'] },
    { id: 'act1', label: '1막', durationSec: 300, allowInterfere: false, cardPool: ['giboo', 'leftright', 'colorword'] },
    { id: 'act2', label: '2막', durationSec: 360, allowInterfere: true, cardPool: ['giboo', 'leftright', 'colorword', 'number', 'audio'] },
    { id: 'boss', label: '보스전', durationSec: 300, allowInterfere: true, cardPool: ['giboo', 'leftright', 'colorword', 'number', 'audio', 'double'] },
  ],
};

// 카드 정의: 입력카드 5종 + 변형카드(double=이중반전, 보스전용)
const CARDS = {
  giboo: { id: 'giboo', name: '가위바위보 반전', tier: 1, penalty: 10, stackGain: 0.5, input: 'foot' },
  leftright: { id: 'leftright', name: '좌우 반전', tier: 1, penalty: 10, stackGain: 0.5, input: 'button2' },
  colorword: { id: 'colorword', name: '색상-단어 반전', tier: 2, penalty: 15, stackGain: 1, input: 'button4' },
  number: { id: 'number', name: '숫자 반전', tier: 2, penalty: 15, stackGain: 1, input: 'button3' },
  audio: { id: 'audio', name: '청각 이중부정', tier: 3, penalty: 20, stackGain: 1.5, input: 'button2' },
  double: { id: 'double', name: '이중반전', tier: 4, penalty: 25, stackGain: 2, input: 'button2' },
};

const COLORS = ['빨강', '파랑', '초록', '노랑'];

function randCard(pool) {
  const id = pool[Math.floor(Math.random() * pool.length)];
  return CARDS[id];
}

// 라운드 하나를 생성 (카드 종류에 따라 선택지/정답 구성)
function generateRound(cardId) {
  const card = CARDS[cardId];
  let options = [];
  let correct = null;
  let correctMode = 'exact'; // 'exact' | 'exclude'
  let excludeValue = null;
  let prompt = '';
  let bubble = null;

  if (card.input === 'foot') {
    // 가위바위보 반전: 외친 것과 "다른" 아무 패나 내면 성공, 외친 것과 "똑같이" 내면 본능이 나온 것(실패)
    const shout = ['가위', '바위', '보'][Math.floor(Math.random() * 3)];
    bubble = shout;
    prompt = `${shout}!`;
    options = shuffle(['가위', '바위', '보']); // 매 라운드 버튼 순서 랜덤
    correctMode = 'exclude';
    excludeValue = shout;
  } else if (card.id === 'leftright') {
    const dir = Math.random() < 0.5 ? '왼쪽' : '오른쪽';
    prompt = `화면이 ${dir}을 가리켜요`;
    options = shuffle(['왼쪽', '오른쪽']); // 항상 하나씩, 화면 배치 순서만 랜덤
    correct = dir === '왼쪽' ? '오른쪽' : '왼쪽';
  } else if (card.id === 'colorword') {
    const word = COLORS[Math.floor(Math.random() * 4)];
    const displayColor = COLORS[Math.floor(Math.random() * 4)];
    prompt = `글자 "${word}" (색: ${displayColor})`;
    options = shuffle([...COLORS]);
    correct = word; // 단어를 눌러야 함 (색 아님)
  } else if (card.id === 'number') {
    const shown = 1 + Math.floor(Math.random() * 4);
    prompt = `숫자 ${shown}`;
    const target = (shown % 4) + 1;
    options = shuffle([1, 2, 3, 4].filter((n) => Math.random() < 0.75 || n === target).slice(0, 3));
    if (!options.includes(target)) options[0] = target;
    correct = target; // 표시값+1(4는 1로 순환)
  } else if (card.id === 'audio') {
    const positive = Math.random() < 0.5;
    prompt = positive ? '음성: "누르세요"' : '음성: "누르지 마세요"';
    options = ['누름', '안누름'];
    correct = positive ? '안누름' : '누름'; // 이중부정: 반대로
  } else if (card.id === 'double') {
    // 이중반전: 기본 좌우반전 위에 "해제" 신호가 랜덤하게 얹힘
    const dir = Math.random() < 0.5 ? '왼쪽' : '오른쪽';
    const released = Math.random() < 0.5;
    prompt = released ? `화면이 ${dir} (해제 신호 있음!)` : `화면이 ${dir}`;
    options = ['왼쪽', '오른쪽'];
    correct = released ? dir : (dir === '왼쪽' ? '오른쪽' : '왼쪽');
  }

  return { cardId: card.id, cardName: card.name, tier: card.tier, penalty: card.penalty, stackGain: card.stackGain, prompt, bubble, options, correct, correctMode, excludeValue, issuedAt: Date.now() };
}

function pickRandomSlots(count) {
  const all = [0, 1, 2, 3];
  return shuffle(all).slice(0, count);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createPlayerState() {
  return {
    gauge: CONFIG.gaugeStart,
    stack: 0,
    combo: 0,
    warning: false,
    defeated: false,
    currentRound: null,
    incoming: null, // 상대가 던진 카드 예고 중이면 {cardName, cardId, deadline}
  };
}

module.exports = { CONFIG, CARDS, randCard, generateRound, createPlayerState };
