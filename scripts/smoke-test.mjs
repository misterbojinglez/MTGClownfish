// Plays a whole game against the bridge by always passing / taking the first option.
// Usage: node scripts/smoke-test.mjs [constructed|commander] [players]
const format = process.argv[2] ?? 'constructed';
const players = Number(process.argv[3] ?? (format === 'commander' ? 4 : 2));
const ws = new WebSocket('ws://127.0.0.1:7777');
const counts = {};
let lastPrompt = null;
let updates = 0, lastState = null, you = null, lastPromptKey = '';

ws.onopen = () => ws.send(JSON.stringify({ type: 'start', format, players }));
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  counts[msg.type] = (counts[msg.type] ?? 0) + 1;
  if (msg.type === 'starting') console.log('decks:', msg.decks.join(' | '));
  if (msg.type === 'gameStarted') you = msg.you[0];
  if (msg.type === 'notice' && msg.kind === 'gameFinished') finish(msg.text);
  if (msg.type === 'notice' && msg.kind !== 'gameFinished') console.log('notice:', msg.kind, msg.text ?? '');
  if (msg.type === 'request') {
    let value;
    if (msg.kind === 'choose') value = msg.options.slice(0, Math.max(msg.min, 0)).map((_, i) => i);
    else if (msg.kind === 'order') value = msg.options.map((_, i) => i);
    else if (msg.kind === 'confirm') value = 0;
    else if (msg.kind === 'input') value = msg.initial ?? '0';
    else value = null;
    ws.send(JSON.stringify({ type: 'response', id: msg.id, value }));
  }
  if (msg.type === 'update') {
    updates++;
    for (const e of msg.events) counts['ev:' + e.event] = (counts['ev:' + e.event] ?? 0) + 1;
    lastState = msg.state;
    if (msg.state.gameOver) finish(msg.state.winner);
    const p = msg.prompt;
    const key = `${p.message}|${p.ok?.enabled}|${msg.seq}`;
    lastPrompt = { prompt: p, selection: msg.selection };
    if (key === lastPromptKey) return;
    lastPromptKey = key;
    const sel = msg.selection;
    if (p.ok?.enabled) {
      setTimeout(() => ws.send(JSON.stringify({ type: 'action', action: 'ok' })), 5);
    } else if (sel.cards.length > 0) {
      const pick = sel.cards.find((id) => !sel.chosen.some((c) => c.card === id));
      if (pick !== undefined) setTimeout(() => ws.send(JSON.stringify({ type: 'action', action: 'card', id: pick })), 5);
    } else if (sel.targets.length > 0) {
      const t = sel.targets[0];
      if (t.player !== undefined) setTimeout(() => ws.send(JSON.stringify({ type: 'action', action: 'player', id: t.player })), 5);
    }
  }
};

let done = false;
function finish(winner) {
  if (done) return;
  done = true;
  console.log('winner:', winner, '| turn', lastState?.turn, '| updates', updates);
  console.log('life:', lastState?.players.map((p) => `${p.name}=${p.life}`).join(' '));
  console.log(JSON.stringify(counts));
  setTimeout(() => process.exit(0), 200);
}
setTimeout(() => { console.log('TIMEOUT', JSON.stringify(counts), 'turn', lastState?.turn); console.log('last prompt:', JSON.stringify(lastPrompt)); process.exit(1); }, 240000);
