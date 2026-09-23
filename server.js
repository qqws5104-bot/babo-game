const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { CONFIG, CARDS, generateRound, createPlayerState } = require('./gameLogic');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---- 전역 게임 상태 ----
let players = { 1: null, 2: null }; // socket id 보관용
let state = {
  running: false,
  phaseIndex: -1,
  phaseEndsAt: null,
  p1: createPlayerState(),
  p2: createPlayerState(),
  winner: null,
};
let roundTimers = { 1: null, 2: null };
let nextRoundTimers = { 1: null, 2: null };
let phaseTimer = null;
let log = [];

function addLog(event) {
  const entry = { t: Date.now(), ...event };
  log.push(entry);
  io.to('admin').emit('log', entry);
}

function currentPhase() {
  return CONFIG.phases[state.phaseIndex] || null;
}

function broadcastState() {
  io.to('admin').emit('state', publicState(true));
  io.emit('publicState', publicState(false));
}

function publicState(full) {
  const phase = currentPhase();
  return {
    running: state.running,
    phase: phase ? phase.id : null,
    phaseLabel: phase ? phase.label : '대기중',
    phaseEndsAt: state.phaseEndsAt,
    winner: state.winner,
    p1: sanitizePlayer(state.p1, full),
    p2: sanitizePlayer(state.p2, full),
  };
}

function sanitizePlayer(p, full) {
  const base = {
    gauge: full ? p.gauge : p.gauge, // 관제/본인 화면은 정확한 수치, 상대 화면은 클라에서 흐림 처리
    warning: p.warning,
    defeated: p.defeated,
    combo: p.combo,
    stack: p.stack,
    hasForcedCard: !!p.forcedCard,
  };
  return base;
}

function resetGame() {
  clearAllTimers();
  players = { 1: players[1], 2: players[2] };
  state = {
    running: false,
    phaseIndex: -1,
    phaseEndsAt: null,
    p1: createPlayerState(),
    p2: createPlayerState(),
    winner: null,
  };
  log = [];
  broadcastState();
}

function clearAllTimers() {
  [1, 2].forEach((id) => {
    clearTimeout(roundTimers[id]);
    clearTimeout(nextRoundTimers[id]);
  });
  clearTimeout(phaseTimer);
  clearAutoEvents();
}

function startGame() {
  resetGame();
  state.running = true;
  state.phaseIndex = 0;
  addLog({ type: 'session_start' });
  enterPhase();
}

function fireSpecialEvent(cardId, label) {
  if (!CARDS[cardId] || !state.running) return;
  [1, 2].forEach((id) => {
    const p = state[`p${id}`];
    if (!p.defeated) p.forcedCard = cardId;
  });
  addLog({ type: 'special_event', card: cardId, label: label || CARDS[cardId].name });
  io.emit('specialEvent', { cardName: CARDS[cardId].name, label: label || CARDS[cardId].name });
  broadcastState();
}

let autoEventTimers = [];
function clearAutoEvents() {
  autoEventTimers.forEach(clearTimeout);
  autoEventTimers = [];
}

const EVENT_LABELS = { double: '이중반전 폭탄', audio: '청각 이중부정 기습', colorword: '색상단어 몰아치기', number: '숫자 반전 습격' };

function scheduleAutoEvents(phase) {
  clearAutoEvents();
  const durMs = phase.durationSec * 1000;
  const pool = phase.cardPool.filter((id) => CARDS[id].tier >= 2);
  if (pool.length === 0) return;

  const plan = phase.id === 'boss' ? 2 : (phase.id === 'act2' ? 1 : 0);
  for (let i = 0; i < plan; i++) {
    const windowStart = Math.floor((durMs / (plan + 1)) * (i + 0.4));
    const windowEnd = Math.floor((durMs / (plan + 1)) * (i + 1.2));
    const delay = windowStart + Math.random() * Math.max(1000, windowEnd - windowStart);
    const timer = setTimeout(() => {
      const cardId = pool[Math.floor(Math.random() * pool.length)];
      fireSpecialEvent(cardId, EVENT_LABELS[cardId] || CARDS[cardId].name);
    }, delay);
    autoEventTimers.push(timer);
  }
}

function enterPhase() {
  const phase = currentPhase();
  if (!phase) {
    endGame();
    return;
  }
  state.phaseEndsAt = Date.now() + phase.durationSec * 1000;
  addLog({ type: 'phase_start', phase: phase.id });
  broadcastState();
  scheduleAutoEvents(phase);
  [1, 2].forEach((id) => {
    const p = state[`p${id}`];
    if (!p.defeated) issueRound(id);
  });
  clearTimeout(phaseTimer);
  phaseTimer = setTimeout(() => {
    state.phaseIndex += 1;
    enterPhase();
  }, phase.durationSec * 1000);
}

function issueRound(id) {
  const p = state[`p${id}`];
  if (p.defeated || !state.running) return;
  const phase = currentPhase();
  if (!phase) return;

  let cardId;
  if (p.forcedCard) {
    cardId = p.forcedCard;
    p.forcedCard = null;
    p.forcedByOpponent = true;
  } else {
    const pool = phase.cardPool;
    cardId = pool[Math.floor(Math.random() * pool.length)];
    p.forcedByOpponent = false;
  }
  const round = generateRound(cardId);
  p.currentRound = round;
  io.to(`player${id}`).emit('round', round);
  broadcastState();
  // 시간제한 없음: 실제로 답을 누르기 전까지는 이 라운드가 그대로 유지됩니다.
}

function resolveAnswer(id, answer) {
  const p = state[`p${id}`];
  if (!p.currentRound || p.defeated) return;
  const round = p.currentRound;
  clearTimeout(roundTimers[id]);

  const isCorrect = answer !== null && (
    round.correctMode === 'exclude'
      ? String(answer) !== String(round.excludeValue)
      : String(answer) === String(round.correct)
  );
  const phase = currentPhase();
  const isWarmup = phase && phase.id === 'warmup';

  if (isWarmup) {
    // 워밍업: 게이지/스택/콤보 전부 미적용, 룰 습득용 연습 라운드
    addLog({ type: isCorrect ? 'warmup_success' : 'warmup_fail', player: id, card: round.cardId });
    p.currentRound = null;
    broadcastState();
    nextRoundTimers[id] = setTimeout(() => issueRound(id), 700);
    return;
  }
  const wasForced = p.forcedByOpponent;
  const opponentId = id === 1 ? 2 : 1;
  const opp = state[`p${opponentId}`];

  if (isCorrect) {
    p.combo += 1;
    p.stack = Math.min(p.stack + round.stackGain, 6);
    if (p.combo > 0 && p.combo % CONFIG.comboHealThreshold === 0) {
      p.gauge = Math.min(100, p.gauge + CONFIG.comboHealAmount);
    }
    if (wasForced) {
      // 역관광 페널티: 던진 쪽(상대) 스택 손해
      opp.stack = Math.max(0, opp.stack - 1);
    }
    addLog({ type: 'success', player: id, card: round.cardId, gauge: p.gauge, forced: wasForced });
  } else {
    p.combo = 0;
    p.gauge -= round.penalty;
    if (p.gauge <= CONFIG.warningThreshold && p.gauge > 0) {
      p.warning = true;
    }
    if (p.gauge <= 0 || (p.warning && p.gauge <= CONFIG.warningThreshold)) {
      p.gauge = Math.max(0, p.gauge);
    }
    addLog({ type: 'fail', player: id, card: round.cardId, gauge: p.gauge, forced: wasForced });

    if (p.gauge <= 0) {
      handleDefeat(id);
      return;
    }
  }

  p.currentRound = null;
  broadcastState();

  nextRoundTimers[id] = setTimeout(() => issueRound(id), 700);
}

function handleDefeat(id) {
  const p = state[`p${id}`];
  p.defeated = true;
  p.currentRound = null;
  const winnerId = id === 1 ? 2 : 1;
  addLog({ type: 'defeat', player: id });
  io.to(`player${id}`).emit('defeated');
  io.to(`player${winnerId}`).emit('opponentDefeated');
  broadcastState();

  const otherStillPlaying = !state[`p${winnerId}`].defeated;
  if (otherStillPlaying) {
    // 승자는 계속 진행, 패자는 관전 모드
  }
  checkGameEnd();
}

function checkGameEnd() {
  const bothDefeated = state.p1.defeated && state.p2.defeated;
  if (bothDefeated) endGame();
}

function endGame() {
  clearAllTimers();
  state.running = false;
  if (state.p1.defeated && !state.p2.defeated) state.winner = 2;
  else if (state.p2.defeated && !state.p1.defeated) state.winner = 1;
  else state.winner = state.p1.gauge >= state.p2.gauge ? 1 : 2;
  addLog({ type: 'session_end', winner: state.winner });
  io.emit('gameOver', { winner: state.winner, p1Gauge: state.p1.gauge, p2Gauge: state.p2.gauge });
  broadcastState();
}

function throwInterference(fromId) {
  const p = state[`p${fromId}`];
  if (p.stack < 1 || p.defeated) return;
  const toId = fromId === 1 ? 2 : 1;
  const opp = state[`p${toId}`];
  if (opp.defeated) return;

  p.stack -= 1;
  const pool = currentPhase() ? currentPhase().cardPool : Object.keys(CARDS);
  const cardId = pool[Math.floor(Math.random() * pool.length)];
  const card = CARDS[cardId];

  addLog({ type: 'interfere_throw', from: fromId, to: toId, card: cardId });
  io.to(`player${toId}`).emit('incoming', { cardId, cardName: card.name, previewMs: CONFIG.interferePreviewMs });
  broadcastState();

  const deadline = setTimeout(() => {
    opp.forcedCard = cardId;
  }, CONFIG.interferePreviewMs);
}

function defend(id) {
  const p = state[`p${id}`];
  if (p.stack < 1) return;
  p.stack -= 1;
  p.forcedCard = null; // 무효화
  addLog({ type: 'defend', player: id });
  broadcastState();
}

// ---- 소켓 연결 ----
io.on('connection', (socket) => {
  const { role } = socket.handshake.query;

  if (role === 'admin') {
    socket.join('admin');
    socket.emit('state', publicState(true));
    socket.emit('fullLog', log);

    socket.on('admin:start', startGame);
    socket.on('admin:reset', resetGame);
    socket.on('admin:skipPhase', () => {
      if (!state.running) return;
      clearTimeout(phaseTimer);
      state.phaseIndex += 1;
      enterPhase();
    });
    socket.on('admin:setGauge', ({ playerId, value }) => {
      const p = state[`p${playerId}`];
      if (!p) return;
      p.gauge = Math.max(0, Math.min(100, value));
      p.warning = p.gauge <= CONFIG.warningThreshold;
      addLog({ type: 'admin_set_gauge', player: playerId, value: p.gauge });
      if (p.gauge <= 0 && !p.defeated) handleDefeat(Number(playerId));
      broadcastState();
    });
    socket.on('admin:forceCard', ({ playerId, cardId }) => {
      const p = state[`p${playerId}`];
      if (!p || !CARDS[cardId]) return;
      p.forcedCard = cardId;
      addLog({ type: 'admin_force_card', player: playerId, card: cardId });
    });
    return;
  }

  const id = role === '2' ? 2 : 1;
  players[id] = socket.id;
  socket.join(`player${id}`);
  socket.emit('assigned', { id });
  socket.emit('publicState', publicState(false));

  socket.on('answer', (answer) => resolveAnswer(id, answer));
  socket.on('throwInterference', () => throwInterference(id));
  socket.on('defend', () => defend(id));

  socket.on('disconnect', () => {
    if (players[id] === socket.id) players[id] = null;
  });
});

app.get('/config', (req, res) => res.json(CONFIG));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`위장 게이지 대결 서버 실행 중: http://localhost:${PORT}`);
  console.log(`  플레이어1: http://localhost:${PORT}/player.html?role=1`);
  console.log(`  플레이어2: http://localhost:${PORT}/player.html?role=2`);
  console.log(`  관제 콘솔: http://localhost:${PORT}/admin.html`);
});
