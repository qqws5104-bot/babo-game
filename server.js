const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { CONFIG, CARDS, COLORS, CARD_SUBJECT, generateRound, createPlayerState, totalScore } = require('./gameLogic');

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
  ended: false,
};
let roundSeq = 0;
let botIds = new Set(); // 솔로 테스트용: 봇이 대신 플레이하는 플레이어 id
const isBot = (id) => botIds.has(id);
const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];
let roundTimers = { 1: null, 2: null };
let nextRoundTimers = { 1: null, 2: null };
let phaseTimer = null;
let log = [];

function addLog(event) {
  const entry = { t: Date.now(), ...event };
  log.push(entry);
  io.to('admin').emit('log', entry);
}

function emitSpec(event, data) {
  io.to('spectator').emit(event, data);
}

function optionLabels(round) {
  return round.options.map((o) => (typeof o === 'object' ? o.label : o));
}

function specRoundPayload(id, round) {
  return {
    player: id,
    cardId: round.cardId,
    cardName: round.cardName,
    subject: round.subject,
    tier: round.tier,
    stem: round.stem,
    visual: round.visual,
    options: round.options,
    paceMode: round.paceMode || null,
  };
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
    allowInterfere: phase ? !!phase.allowInterfere : false,
    isBreak: phase ? !!phase.isBreak : false,
    patrol: !!state.patrol,
    blind: isBlind(),
    multiplier: scoreMultiplier(),
    subject: phase && phase.subject ? phase.subject : null,
    timeline: CONFIG.phases.map((ph) => ({ id: ph.id, label: ph.label, isBreak: !!ph.isBreak })),
    winner: state.winner,
    ended: state.ended,
    p1: sanitizePlayer(state.p1, full),
    p2: sanitizePlayer(state.p2, full),
  };
}

function isBlind() {
  const ph = currentPhase();
  return !!(ph && ph.blind);
}

// 블라인드 피날레: 플레이어/관전자에게는 점수를 보내지 않음 (관제 화면만 실제 값)
function sanitizePlayer(p, full) {
  const blind = !full && isBlind();
  return {
    scores: blind ? null : { ...p.scores },
    total: blind ? null : totalScore(p),
    hidden: blind,
    warning: blind ? false : p.warning,
    defeated: p.defeated,
    combo: p.combo,
    stack: p.stack,
    hasForcedCard: !!p.forcedCard,
    isTrapped: !!p.trapColor,
  };
}

const shownTotal = (t) => (isBlind() ? null : t);

// 막판 2배: doubleLastMs 이내면 점수 2배
function scoreMultiplier() {
  const ph = currentPhase();
  if (ph && ph.doubleLastMs && state.phaseEndsAt && state.phaseEndsAt - Date.now() <= ph.doubleLastMs) return 2;
  return 1;
}

// 고민 벌점: 문제가 뜬 뒤 3초를 넘겨 고르면 초과 시간만큼 점수 상승 (순찰로 멈춘 시간은 제외)
function slowPenaltyFor(round) {
  const now = Date.now();
  const paused = (round.pausedMs || 0) + (round.pauseStart ? now - round.pauseStart : 0);
  const over = now - round.issuedAt - paused - CONFIG.thinkFreeMs;
  return over > 0 ? Math.min(Math.round((over / 1000) * CONFIG.slowPointsPerSec), 30) : 0;
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
    ended: false,
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
  clearAfkTimers();
  patrolTimers.forEach(clearTimeout);
  patrolTimers = [];
  clearTimeout(patrolEndTimer);
  stopTrapTimer(1);
  stopTrapTimer(2);
  if (state) state.patrol = null;
}

function startGame(opts) {
  resetGame();
  botIds = new Set(opts && opts.bot ? [2] : []);
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
  emitSpec('spec:event', { kind: 'special', label: label || CARDS[cardId].name });
  broadcastState();
}

let autoEventTimers = [];
let afkTimers = { 1: null, 2: null };

function clearAfkTimers() {
  clearTimeout(afkTimers[1]);
  clearTimeout(afkTimers[2]);
  afkTimers = { 1: null, 2: null };
}

function scheduleAfk(id, overrideMs) {
  clearTimeout(afkTimers[id]);
  if (state.patrol) return; // 순찰 중에는 제한시간 정지 (끝나면 endPatrol이 다시 건다)
  const phase = currentPhase();
  if (!state.running || !phase) return;
  const p = state[`p${id}`];
  if (!p || p.defeated) return;
  const ms = overrideMs || (p.pendingCardId ? CONFIG.paceTimeoutMs : CONFIG.roundTimeoutMs);
  afkTimers[id] = setTimeout(() => applyAfkPenalty(id), ms);
}

// 제한시간 초과 처리: 생각만 하고 안 누르면 "정직하게 답한 것"으로 간주해 실패 처리 (멈춰있는 게 유리해지지 않도록)
function applyAfkPenalty(id) {
  const p = state[`p${id}`];
  if (!p || p.defeated || !state.running) return;
  if (p.trapColor) { scheduleAfk(id); return; } // 함정 탈출 중에는 시간초과 없음
  if (p.pendingCardId) { finishRoundWithPace(id, 'safe'); return; } // 선택 안 하면 자동 '안전'
  if (p.currentRound) {
    addLog({ type: 'timeout', player: id, card: p.currentRound.cardId });
    resolveAnswer(id, null);
    return;
  }
  scheduleAfk(id);
}

function clearAutoEvents() {
  autoEventTimers.forEach(clearTimeout);
  autoEventTimers = [];
}

// ---- 선생님 순찰: 3초간 "멈춰!" — 이때 입력하면 컨닝으로 걸려 점수 상승 ----
let patrolTimers = [];
let patrolEndTimer = null;
const PATROL_GRACE_MS = 300; // 순찰 시작 직후 네트워크 지연으로 늦게 도착한 입력은 봐줌

function schedulePatrols(phase) {
  patrolTimers.forEach(clearTimeout);
  patrolTimers = [];
  const n = phase.patrolCount || 0;
  if (!n) return;
  const durMs = phase.durationSec * 1000;
  for (let i = 0; i < n; i++) {
    const lo = durMs * (0.15 + (0.7 / n) * i);
    const hi = durMs * (0.15 + (0.7 / n) * (i + 1));
    patrolTimers.push(setTimeout(startPatrol, lo + Math.random() * (hi - lo)));
  }
}

function startPatrol() {
  const phase = currentPhase();
  if (!state.running || !phase || phase.isBreak || state.patrol) return;
  state.patrol = { since: Date.now(), until: Date.now() + CONFIG.patrolMs, caught: { 1: false, 2: false } };
  clearAfkTimers();
  [1, 2].forEach((id) => { const r = state[`p${id}`].currentRound; if (r) r.pauseStart = Date.now(); });
  addLog({ type: 'patrol_start' });
  io.emit('patrol', { ms: CONFIG.patrolMs, penalty: CONFIG.patrolPenalty });
  emitSpec('spec:event', { kind: 'patrol', ms: CONFIG.patrolMs });
  clearTimeout(patrolEndTimer);
  patrolEndTimer = setTimeout(endPatrol, CONFIG.patrolMs);
  broadcastState();
}

function endPatrol() {
  if (!state.patrol) return;
  [1, 2].forEach((id) => {
    const r = state[`p${id}`].currentRound;
    if (r && r.pauseStart) { r.pausedMs = (r.pausedMs || 0) + (Date.now() - r.pauseStart); r.pauseStart = null; }
  });
  state.patrol = null;
  clearTimeout(patrolEndTimer);
  addLog({ type: 'patrol_end' });
  io.emit('patrolEnd');
  emitSpec('spec:event', { kind: 'patrolEnd' });
  if (state.running) {
    [1, 2].forEach((id) => {
      const p = state[`p${id}`];
      if (p.currentRound || p.pendingCardId || p.trapColor) scheduleAfk(id);
    });
  }
  broadcastState();
}

// 순찰 중 입력 = 컨닝. 입력을 막아야 하면 true
function patrolBlocks(id) {
  const pt = state.patrol;
  if (!pt || Date.now() < pt.since + PATROL_GRACE_MS) return false;
  if (!pt.caught[id]) {
    pt.caught[id] = true;
    const p = state[`p${id}`];
    const phase = currentPhase();
    const subject = (p.currentRound && p.currentRound.subject) || (phase && phase.subject) || '예체능';
    const pts = CONFIG.patrolPenalty * scoreMultiplier();
    p.scores[subject] += pts;
    p.combo = 0;
    p.stats.caught++;
    updateWarnings();
    addLog({ type: 'patrol_caught', player: id, subject, total: totalScore(p) });
    io.to(`player${id}`).emit('patrolCaught', { points: pts, subject });
    emitSpec('spec:event', { kind: 'caught', player: id, points: pts });
    broadcastState();
  }
  return true;
}

function scheduleAutoEvents(phase) {
  clearAutoEvents();
  const plan = phase.eventCount || 0;
  if (!plan) return;
  // 지금까지 배운 과목 중에서 "돌발 쪽지시험" 출제 (난이도 2 이상)
  const seen = new Set();
  CONFIG.phases.slice(0, state.phaseIndex + 1).forEach((ph) => ph.cardPool.forEach((c) => seen.add(c)));
  const pool = [...seen].filter((c) => CARDS[c].tier >= 2);
  if (pool.length === 0) return;
  const durMs = phase.durationSec * 1000;
  for (let i = 0; i < plan; i++) {
    const windowStart = Math.floor((durMs / (plan + 1)) * (i + 0.4));
    const windowEnd = Math.floor((durMs / (plan + 1)) * (i + 1.2));
    const delay = windowStart + Math.random() * Math.max(1000, windowEnd - windowStart);
    const timer = setTimeout(() => {
      const cardId = pickOne(pool);
      fireSpecialEvent(cardId, `돌발 쪽지시험: ${CARDS[cardId].subject}`);
    }, delay);
    autoEventTimers.push(timer);
  }
}

function scheduleFinalRush(phase) {
  if (!phase.doubleLastMs) return;
  const delay = Math.max(0, phase.durationSec * 1000 - phase.doubleLastMs);
  autoEventTimers.push(setTimeout(() => {
    addLog({ type: 'final_rush' });
    io.emit('finalRush', { ms: phase.doubleLastMs });
    emitSpec('spec:event', { kind: 'finalRush', ms: phase.doubleLastMs });
    broadcastState();
  }, delay));
}

function startBreak(phase) {
  clearAutoEvents();
  patrolTimers.forEach(clearTimeout);
  patrolTimers = [];
  if (state.patrol) endPatrol();
  const idx = state.phaseIndex;
  const prev = CONFIG.phases[idx - 1];
  const next = CONFIG.phases[idx + 1];
  [1, 2].forEach((id) => {
    const p = state[`p${id}`];
    p.currentRound = null;
    p.pendingCardId = null;
    p.forcedCard = null;
    clearTimeout(afkTimers[id]);
    clearTimeout(nextRoundTimers[id]);
  });
  const t1 = totalScore(state.p1);
  const t2 = totalScore(state.p2);
  const payload = {
    endedLabel: prev ? prev.label : '',
    isWarmup: !!(prev && prev.id === 'warmup'),
    nextLabel: next ? next.label : '',
    nextHint: next ? next.hint || '' : '',
    p1Delta: t1 - state.p1.periodStartTotal,
    p2Delta: t2 - state.p2.periodStartTotal,
    p1Total: t1,
    p2Total: t2,
    seconds: phase.durationSec,
  };
  addLog({ type: 'break', ...payload });
  io.emit('breakTime', payload);
  broadcastState();
}

function enterPhase() {
  const phase = currentPhase();
  if (!phase) {
    endGame();
    return;
  }
  state.phaseEndsAt = Date.now() + phase.durationSec * 1000;
  addLog({ type: 'phase_start', phase: phase.id });
  if (phase.isBreak) {
    startBreak(phase);
  } else {
    [1, 2].forEach((id) => { state[`p${id}`].periodStartTotal = totalScore(state[`p${id}`]); });
    broadcastState();
    scheduleAutoEvents(phase);
    schedulePatrols(phase);
    scheduleFinalRush(phase);
    [1, 2].forEach((id) => {
      const p = state[`p${id}`];
      if (!p.defeated) issueRound(id);
    });
  }
  clearTimeout(phaseTimer);
  phaseTimer = setTimeout(() => {
    state.phaseIndex += 1;
    enterPhase();
  }, phase.durationSec * 1000);
}

function takeRoundTimeout(p) {
  if (p.rushNext) { p.rushNext = false; return CONFIG.rushMs; }
  return CONFIG.roundTimeoutMs;
}

function issueRound(id) {
  const p = state[`p${id}`];
  if (p.defeated || !state.running || p.trapColor || p.pendingCardId || p.currentRound) return;
  const phase = currentPhase();
  if (!phase || phase.isBreak || !phase.cardPool.length) return;

  let cardId;
  let forced = false;
  if (p.forcedCard) {
    cardId = p.forcedCard;
    p.forcedCard = null;
    forced = true;
  } else {
    const pool = phase.cardPool;
    cardId = pool[Math.floor(Math.random() * pool.length)];
  }
  p.forcedByOpponent = forced;

  // 안전/터보 선택은 allowPace 구간(2막~)의 일반 라운드에만 (규칙을 단계적으로 소개)
  if (!phase.allowPace || forced) {
    const round = generateRound(cardId);
    round.id = ++roundSeq;
    round.timeoutMs = takeRoundTimeout(p);
    round.freeMs = CONFIG.thinkFreeMs;
    if (state.patrol) round.pauseStart = Date.now();
    p.currentRound = round;
    io.to(`player${id}`).emit('round', round);
    emitSpec('spec:round', specRoundPayload(id, round));
    broadcastState();
    scheduleAfk(id, round.timeoutMs);
    if (isBot(id)) botAnswer(id, round);
    return;
  }

  p.pendingCardId = cardId;
  const cardMeta = CARDS[cardId];
  io.to(`player${id}`).emit('choosePace', { cardName: cardMeta.name, tier: cardMeta.tier, timeoutMs: CONFIG.paceTimeoutMs });
  emitSpec('spec:pace', { player: id, cardName: cardMeta.name });
  broadcastState();
  scheduleAfk(id);
  if (isBot(id)) botChoosePace(id);
}

function finishRoundWithPace(id, mode) {
  const p = state[`p${id}`];
  if (!p.pendingCardId || p.defeated || !state.running) return;
  const cardId = p.pendingCardId;
  p.pendingCardId = null;

  const round = generateRound(cardId);
  if (mode === 'safe') {
    round.penalty = Math.round(round.penalty * 0.6);
    round.stackGain = round.stackGain * 0.5;
    round.paceMode = 'safe';
    p.stats.safe++;
  } else {
    round.penalty = Math.round(round.penalty * 1.5);
    round.stackGain = round.stackGain * 2;
    round.paceMode = 'turbo';
    p.stats.turbo++;
    round.turboBonusStack = CONFIG.turboBonusStack;
  }
  round.id = ++roundSeq;
  round.timeoutMs = takeRoundTimeout(p);
  round.freeMs = CONFIG.thinkFreeMs;
  if (state.patrol) round.pauseStart = Date.now();
  p.currentRound = round;
  io.to(`player${id}`).emit('round', round);
  emitSpec('spec:round', specRoundPayload(id, round));
  broadcastState();
  scheduleAfk(id, round.timeoutMs);
  if (isBot(id)) botAnswer(id, round);
}

// ---- 솔로 테스트용 봇 (사람처럼 1.2~3초 고민하고, 일정 확률로 정답을 골라버림) ----
function botAnswer(id, round) {
  setTimeout(() => {
    const p = state[`p${id}`];
    if (!p || !p.currentRound || p.currentRound.id !== round.id) return;
    if (state.patrol) { botAnswer(id, round); return; } // 순찰 중엔 얌전히 대기
    const safe = round.options.filter((o) => !round.excludeValues.includes(o.key));
    const right = round.options.filter((o) => round.excludeValues.includes(o.key));
    const mistake = Math.random() < CONFIG.botMistakeRate && right.length > 0;
    resolveAnswer(id, pickOne(mistake ? right : safe).key, round.id);
  }, 1200 + Math.random() * 2800);
}

function botChoosePace(id) {
  setTimeout(() => {
    const p = state[`p${id}`];
    if (state.patrol) { botChoosePace(id); return; }
    if (p && p.pendingCardId) finishRoundWithPace(id, Math.random() < 0.4 ? 'turbo' : 'safe');
  }, 800 + Math.random() * 1200);
}

function botEscapeTrap(id) {
  const iv = setInterval(() => {
    if (!state.running || !state[`p${id}`].trapColor) { clearInterval(iv); return; }
    if (state.patrol) return;
    mashTrap(id);
  }, 140);
}

function outcomeInfo(round, answer) {
  const safeOpts = round.options.filter((o) => !round.excludeValues.includes(o.key));
  const single = safeOpts.length === 1 ? safeOpts[0] : null;
  const pressed = round.options.find((o) => String(o.key) === String(answer));
  return { safeLabels: safeOpts.map((o) => o.desc || o.label), single, pressedLabel: pressed ? pressed.desc || pressed.label : null };
}

function resolveAnswer(id, answer, roundId) {
  const p = state[`p${id}`];
  if (!p.currentRound || p.defeated) return;
  const round = p.currentRound;
  // 이미 넘어간 라운드에 대한 늦은 입력은 무시 (라운드 id 불일치 = 엉뚱한 채점 방지)
  if (roundId !== undefined && roundId !== null && roundId !== round.id) return;
  clearTimeout(roundTimers[id]);
  scheduleAfk(id);

  const isCorrect = answer !== null && (
    round.correctMode === 'exclude'
      ? String(answer) !== String(round.excludeValue)
      : round.correctMode === 'excludeMulti'
        ? !round.excludeValues.map(String).includes(String(answer))
        : String(answer) === String(round.correct)
  );
  const phase = currentPhase();
  const isWarmup = phase && phase.id === 'warmup';

  if (isWarmup) {
    // 워밍업: 게이지/스택/콤보 전부 미적용, 룰 습득용 연습 라운드
    addLog({ type: isCorrect ? 'warmup_success' : 'warmup_fail', player: id, card: round.cardId });
    const wi = outcomeInfo(round, answer);
    const warmupReason = answer === null ? '시간 초과! 5초 안에 눌러야 해요' : (isCorrect ? '좋아요! 정답이 아닌 걸 골랐어요' : '앗, 정답을 골라버렸어요 (연습이라 괜찮아요)');
    io.to(`player${id}`).emit('result', { success: isCorrect, timeout: answer === null, reason: warmupReason, warmup: true });
    emitSpec('spec:result', { player: id, success: isCorrect, timeout: answer === null, reason: warmupReason, cardName: round.cardName, points: 0, warmup: true, safeLabels: wi.safeLabels, pressed: wi.pressedLabel });
    p.currentRound = null;
    broadcastState();
    nextRoundTimers[id] = setTimeout(() => issueRound(id), 700);
    return;
  }
  const wasForced = p.forcedByOpponent;
  const opponentId = id === 1 ? 2 : 1;
  const opp = state[`p${opponentId}`];

  if (isCorrect) {
    // 위장 성공: 해당 과목 점수 안 오름. 콤보/스택/간섭 메타만 영향받음.
    p.combo += 1;
    p.stats.successes++;
    p.stats.maxCombo = Math.max(p.stats.maxCombo, p.combo);
    p.stack = Math.min(p.stack + round.stackGain, 6);
    if (p.combo > 0 && p.combo % CONFIG.comboBonusStackThreshold === 0) {
      p.stack = Math.min(p.stack + CONFIG.comboBonusStack, 6);
    }
    if (round.paceMode === 'turbo' && round.turboBonusStack) {
      p.stack = Math.min(p.stack + round.turboBonusStack, 6);
    }
    if (wasForced) {
      // 역관광 페널티: 던진 쪽(상대) 스택 손해
      opp.stack = Math.max(0, opp.stack - 1);
    }
    // 고민 벌점: 성공해도 3초 넘게 고민했으면 점수 상승 (똑똑한 사람이나 하는 짓)
    const slowRaw = slowPenaltyFor(round);
    const slow = slowRaw * scoreMultiplier();
    if (slow > 0) {
      const sj = CARD_SUBJECT[round.cardId] || '예체능';
      p.scores[sj] += slow;
      p.stats.slowPoints += slow;
      updateWarnings();
    }
    addLog({ type: 'success', player: id, card: round.cardId, total: totalScore(p), forced: wasForced, slow });
    const oi = outcomeInfo(round, answer);
    const okReason = (oi.single ? `오답 "${oi.single.desc || oi.single.label}"를 찾아 안전!` : '정답이 아닌 걸 골라 안전!') + (slow > 0 ? ` 근데 너무 고민했어요 (+${slow})` : '');
    io.to(`player${id}`).emit('result', { success: true, timeout: false, reason: okReason, slow });
    emitSpec('spec:result', { player: id, success: true, timeout: false, reason: okReason, cardName: round.cardName, points: slow, slow, total: shownTotal(totalScore(p)), forced: wasForced, safeLabels: oi.safeLabels, pressed: oi.pressedLabel });
  } else {
    // 본능 발각: 해당 과목에 "정답"으로 점수가 쌓임 (시험 잘 본 셈 = 출근에 가까워짐)
    p.combo = 0;
    p.stats.fails++;
    if (answer === null) p.stats.timeouts++;
    const subject = CARD_SUBJECT[round.cardId] || '예체능';
    const mult = scoreMultiplier();
    const pts = round.penalty * mult;
    p.scores[subject] += pts;
    const total = totalScore(p);
    updateWarnings();
    addLog({ type: 'fail', player: id, card: round.cardId, subject, total, forced: wasForced });
    // 실패는 새로운 상황을 만든다: 들킨 틈에 상대가 방해 기회(스택)를 얻음
    let gift = false;
    if (phase && phase.allowInterfere && !opp.defeated) {
      opp.stack = Math.min(opp.stack + 0.5, 6);
      gift = true;
    }
    const fi = outcomeInfo(round, answer);
    const failReason = answer === null
      ? '시간 초과! 생각이 너무 많았어요'
      : (fi.single ? `정답을 골라버렸어요! 오답은 "${fi.single.desc || fi.single.label}"였어요` : '정답을 골라버렸어요 (똑똑함 들통)');
    io.to(`player${id}`).emit('result', { success: false, timeout: answer === null, reason: failReason, subject, points: pts, mult, gift, safeLabels: fi.safeLabels });
    emitSpec('spec:result', { player: id, success: false, timeout: answer === null, reason: failReason, cardName: round.cardName, subject, points: pts, mult, total: shownTotal(total), forced: wasForced, gift, safeLabels: fi.safeLabels, pressed: fi.pressedLabel });
  }

  // 봇: 안전 구간(방해 허용)에서 스택이 있으면 가끔 방해공작
  if (isBot(id) && phase && phase.allowInterfere && p.stack >= 1 && Math.random() < 0.35) {
    setTimeout(() => throwInterference(id, pickOne(['doodle', 'ink', 'rush'])), 500);
  }

  p.currentRound = null;
  broadcastState();

  nextRoundTimers[id] = setTimeout(() => issueRound(id), 700);
}

function updateWarnings() {
  const t1 = totalScore(state.p1);
  const t2 = totalScore(state.p2);
  state.p1.warning = t1 - t2 >= CONFIG.scoreWarningMargin;
  state.p2.warning = t2 - t1 >= CONFIG.scoreWarningMargin;
}

function titlesFor(p) {
  const st = p.stats;
  const throws = st.throws.doodle + st.throws.ink + st.throws.rush;
  const out = [];
  if (st.fails === 0 && st.successes >= 8) out.push({ name: '완벽한 바보', desc: '한 번도 안 들켰다' });
  if (st.timeouts >= 3) out.push({ name: '생각 많은 모범생', desc: `시간 초과 ${st.timeouts}번` });
  if (st.slowPoints >= 30) out.push({ name: '고민 많은 바보', desc: `고민하다 +${st.slowPoints}점` });
  if (st.turbo >= 4) out.push({ name: '터보 중독자', desc: `터보 ${st.turbo}번` });
  if (throws >= 4) out.push({ name: '방해공작 천재', desc: `방해 ${throws}번` });
  if (st.defendOk >= 2) out.push({ name: '철벽 방어', desc: `방어 성공 ${st.defendOk}번` });
  if (st.trapEscapes >= 2) out.push({ name: '먹물 탈출 전문가', desc: `${st.trapEscapes}번 탈출` });
  if (st.caught >= 1) out.push({ name: '순찰에 움찔한 사람', desc: `순찰 때 ${st.caught}번 걸림` });
  if (st.hints >= 3) out.push({ name: '족보 마니아', desc: `족보 ${st.hints}번` });
  if (st.maxCombo >= 10) out.push({ name: '연속 바보 장인', desc: `${st.maxCombo}연속 위장` });
  if (!out.length) out.push({ name: '평범한 바보', desc: '무난하게 바보였다' });
  return out.slice(0, 2);
}

function endGame() {
  clearAllTimers();
  state.running = false;
  state.ended = true;
  const t1 = totalScore(state.p1);
  const t2 = totalScore(state.p2);
  // 총점이 더 높은 쪽(시험을 더 잘 본 쪽 = 똑똑함이 들통난 쪽)이 출근 확정(패배)
  if (t1 > t2) { state.winner = 2; state.p1.defeated = true; }
  else if (t2 > t1) { state.winner = 1; state.p2.defeated = true; }
  else { state.winner = null; } // 동점 처리 (실측 후 타이브레이커 규칙 추가 필요)
  addLog({ type: 'session_end', winner: state.winner, p1Total: t1, p2Total: t2 });
  io.emit('gameOver', { winner: state.winner, p1Total: t1, p2Total: t2, p1Scores: state.p1.scores, p2Scores: state.p2.scores, p1Titles: titlesFor(state.p1), p2Titles: titlesFor(state.p2) });
  broadcastState();
}

const INTERFERE_KINDS = { doodle: '먹물 폭탄', ink: '흐려짐', rush: '시간 단축' };

function throwInterference(fromId, kind) {
  kind = INTERFERE_KINDS[kind] ? kind : 'doodle';
  const p = state[`p${fromId}`];
  const ph = currentPhase();
  if (!ph || !ph.allowInterfere || ph.isBreak || state.patrol) return;
  if (p.stack < 1 || p.defeated) return;
  const toId = fromId === 1 ? 2 : 1;
  const opp = state[`p${toId}`];
  if (opp.defeated || opp.incomingPending || opp.trapColor) return; // 이미 방해 진행 중이면 중복 투척 불가
  scheduleAfk(fromId);

  p.stack -= 1;
  p.stats.throws[kind]++;
  opp.incomingPending = true;
  opp.shielded = false;

  addLog({ type: 'interfere_throw', from: fromId, to: toId, kind });
  emitSpec('spec:event', { kind: 'throw', from: fromId, to: toId, label: INTERFERE_KINDS[kind] });
  io.to(`player${toId}`).emit('incoming', { cardName: INTERFERE_KINDS[kind], kind, previewMs: CONFIG.interferePreviewMs });
  broadcastState();

  if (isBot(toId) && opp.stack >= 1 && Math.random() < 0.5) {
    setTimeout(() => defend(toId), 500 + Math.random() * 700);
  }

  setTimeout(() => {
    if (state[`p${toId}`] !== opp) return; // 그 사이 리셋됨
    opp.incomingPending = false;
    if (opp.defeated || !state.running) return;
    if (opp.shielded) {
      opp.shielded = false;
      opp.stats.defendOk++;
      addLog({ type: 'defend_success', player: toId });
      emitSpec('spec:event', { kind: 'defendOk', player: toId });
      io.to(`player${toId}`).emit('defendOk');
      io.to(`player${fromId}`).emit('throwBlocked');
      broadcastState();
      return;
    }
    applyInterference(toId, kind);
  }, CONFIG.interferePreviewMs);
}

function applyInterference(toId, kind) {
  const opp = state[`p${toId}`];
  if (kind === 'ink') {
    addLog({ type: 'ink', player: toId });
    emitSpec('spec:event', { kind: 'ink', player: toId });
    io.to(`player${toId}`).emit('ink', { ms: CONFIG.inkMs });
    return;
  }
  if (kind === 'rush') {
    addLog({ type: 'rush', player: toId });
    emitSpec('spec:event', { kind: 'rush', player: toId });
    if (opp.currentRound) {
      opp.currentRound.timeoutMs = CONFIG.rushMs;
      scheduleAfk(toId, CONFIG.rushMs);
      io.to(`player${toId}`).emit('rush', { ms: CONFIG.rushMs });
    } else {
      opp.rushNext = true; // 문제 사이였다면 다음 문제가 짧아짐
      io.to(`player${toId}`).emit('rush', { ms: 0 });
    }
    return;
  }
  startTrap(toId);
}

// 족보: 스택 1개로 이번 문제의 오답(안전한 보기) 하나를 힌트로 확인
function useHint(id) {
  const p = state[`p${id}`];
  const ph = currentPhase();
  if (!ph || !ph.allowInterfere || ph.isBreak) return;
  if (!p.currentRound || p.currentRound.hinted || p.stack < 1) return;
  const round = p.currentRound;
  const safe = round.options.filter((o) => !round.excludeValues.includes(o.key));
  if (!safe.length) return;
  p.stack -= 1;
  round.hinted = true;
  p.stats.hints++;
  addLog({ type: 'hint', player: id });
  io.to(`player${id}`).emit('hint', { roundId: round.id, key: pickOne(safe).key });
  emitSpec('spec:event', { kind: 'hint', player: id });
  broadcastState();
}

// 먹물 방해: 화면이 검은 잉크로 덮임 → 빠르게 연타해서 닦아내야 함 (천천히 누르면 도로 번짐)
let trapTimers = { 1: null, 2: null };

function stopTrapTimer(id) {
  clearInterval(trapTimers[id]);
  trapTimers[id] = null;
}

function startTrap(id) {
  const p = state[`p${id}`];
  p.currentRound = null; // 진행 중이던 라운드는 취소, 함정부터 탈출해야 함
  p.pendingCardId = null; // 선택 대기 중이었다면 그것도 취소 (탈출 후 새로 발급)
  emitSpec('spec:event', { kind: 'trap', player: id });
  p.trapColor = 'ink'; // 함정 진행 중 표시 (색 개념은 폐기)
  p.trapProgress = 0;
  p.trapTarget = CONFIG.trapTarget;
  addLog({ type: 'trap_start', player: id });
  io.to(`player${id}`).emit('trapped', { target: p.trapTarget });
  broadcastState();
  scheduleAfk(id);
  stopTrapTimer(id);
  trapTimers[id] = setInterval(() => {
    const q = state[`p${id}`];
    if (!state.running || !q.trapColor) { stopTrapTimer(id); return; }
    if (state.patrol || q.trapProgress <= 0) return;
    q.trapProgress = Math.max(0, q.trapProgress - CONFIG.trapDecay);
    io.to(`player${id}`).emit('trapProgress', { progress: q.trapProgress, target: q.trapTarget });
  }, CONFIG.trapTickMs);
  if (isBot(id)) botEscapeTrap(id);
}

function mashTrap(id) {
  const p = state[`p${id}`];
  if (!p.trapColor) return;
  p.trapProgress = Math.min(p.trapTarget, p.trapProgress + 1);
  scheduleAfk(id);
  io.to(`player${id}`).emit('trapProgress', { progress: p.trapProgress, target: p.trapTarget });
  if (p.trapProgress >= p.trapTarget) {
    addLog({ type: 'trap_cleared', player: id });
    p.stats.trapEscapes++;
    emitSpec('spec:event', { kind: 'trapFreed', player: id });
    stopTrapTimer(id);
    p.trapColor = null;
    p.trapProgress = 0;
    p.trapTarget = 0;
    io.to(`player${id}`).emit('trapFreed');
    broadcastState();
    if (!p.defeated && state.running) issueRound(id);
  }
}

function defend(id) {
  const p = state[`p${id}`];
  // 방해가 날아오는 예고 시간 중에만, 스택 1개로 방어 태세
  if (!p.incomingPending || p.shielded || p.stack < 1) return;
  scheduleAfk(id);
  p.stack -= 1;
  p.shielded = true;
  addLog({ type: 'defend', player: id });
  emitSpec('spec:event', { kind: 'defend', player: id });
  broadcastState();
}

// ---- 소켓 연결 ----
io.on('connection', (socket) => {
  const { role } = socket.handshake.query;

  if (role === 'admin') {
    socket.join('admin');
    socket.emit('state', publicState(true));
    socket.emit('fullLog', log);

    socket.on('admin:start', (opts) => startGame(opts));
    socket.on('admin:reset', resetGame);
    socket.on('admin:patrol', startPatrol); // 테스트용 훅 (실제 진행에서는 자동 발동)
    socket.on('admin:skipPhase', () => {
      if (!state.running) return;
      clearTimeout(phaseTimer);
      state.phaseIndex += 1;
      enterPhase();
    });
    socket.on('admin:forceCard', ({ playerId, cardId }) => {
      const p = state[`p${playerId}`];
      if (!p || !CARDS[cardId]) return;
      p.forcedCard = cardId;
      addLog({ type: 'admin_force_card', player: playerId, card: cardId });
    });
    return;
  }

  if (role === 'spectator') {
    socket.join('spectator');
    socket.emit('publicState', publicState(false));
    return;
  }

  const id = role === '2' ? 2 : 1;
  players[id] = socket.id;
  socket.join(`player${id}`);
  socket.emit('assigned', { id });
  socket.emit('publicState', publicState(false));

  socket.on('answer', (payload) => {
    if (patrolBlocks(id)) return;
    if (payload && typeof payload === 'object' && 'value' in payload) resolveAnswer(id, payload.value, payload.id);
    else resolveAnswer(id, payload);
  });
  socket.on('throwInterference', (kind) => { if (patrolBlocks(id)) return; throwInterference(id, kind); });
  socket.on('defend', () => { if (patrolBlocks(id)) return; defend(id); });
  socket.on('mash', () => { if (patrolBlocks(id)) return; mashTrap(id); });
  socket.on('choosePace', (mode) => { if (patrolBlocks(id)) return; finishRoundWithPace(id, mode === 'turbo' ? 'turbo' : 'safe'); });
  socket.on('hint', () => { if (patrolBlocks(id)) return; useHint(id); });

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
  console.log(`  관전 화면: http://localhost:${PORT}/spectator.html`);
});
