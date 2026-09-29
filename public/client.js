'use strict';

(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  let playerId = store.get('nuno.pid');
  if (!playerId) {
    playerId = uuid();
    store.set('nuno.pid', playerId);
  }

  const socket = io({ auth: { playerId } });

  let S = null; // latest room state from the server
  let pendingWildId = null; // wild card waiting for a color choice
  let colorMode = null; // 'play' | 'choose'
  let prevHandIds = null;
  let shownTurn = null; // whose turn the table currently highlights
  let lastEventId = null;
  // Animations are on by default (they're part of the game); players can switch them off.
  let animOn = store.get('nuno.anim') !== '0';
  document.body.classList.toggle('no-anim', !animOn);

  const COLOR_ORDER = ['red', 'yellow', 'green', 'blue', 'wild'];
  const VALUE_ORDER = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2', 'wild', 'wild4'];
  const LABELS = { skip: '⊘', reverse: '⇄', draw2: '+2', wild4: '+4' };
  const NAMES = { skip: 'Skip', reverse: 'Reverse', draw2: 'Draw Two', wild: 'Wild', wild4: 'Wild Draw Four' };
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  const describe = (c) => (c.color === 'wild' ? NAMES[c.value] : `${cap(c.color)} ${NAMES[c.value] || c.value}`);

  // ---------- Sound (synthesized, no assets) ----------
  const Sound = (() => {
    let ctx = null;
    let muted = store.get('nuno.muted') === '1';
    function ac() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function noise(dur, freq, gain) {
      const c = !muted && ac();
      if (!c) return;
      const len = Math.floor(c.sampleRate * dur);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
      const src = c.createBufferSource();
      src.buffer = buf;
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = freq;
      f.Q.value = 0.9;
      const g = c.createGain();
      g.gain.value = gain;
      src.connect(f).connect(g).connect(c.destination);
      src.start();
    }
    // Filtered noise swept from one pitch to another: a card-shuffling whoosh.
    function whoosh(dur, from, to, gain) {
      const c = !muted && ac();
      if (!c) return;
      const len = Math.floor(c.sampleRate * dur);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.sin((Math.PI * i) / len);
      const src = c.createBufferSource();
      src.buffer = buf;
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 1.4;
      f.frequency.setValueAtTime(from, c.currentTime);
      f.frequency.exponentialRampToValueAtTime(to, c.currentTime + dur);
      const g = c.createGain();
      g.gain.value = gain;
      src.connect(f).connect(g).connect(c.destination);
      src.start();
    }
    function tone(freqs, dur, type = 'triangle', gain = 0.1, gap = 0.08) {
      const c = !muted && ac();
      if (!c) return;
      freqs.forEach((fq, k) => {
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = type;
        o.frequency.value = fq;
        const t = c.currentTime + k * gap;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(c.destination);
        o.start(t);
        o.stop(t + dur + 0.05);
      });
    }
    return {
      play: () => noise(0.14, 1600, 0.6),
      draw: () => noise(0.09, 2800, 0.3),
      deal: () => noise(0.05, 3400, 0.18),
      uno: () => tone([660, 880, 1320], 0.2, 'square', 0.06, 0.07),
      skip: () => tone([520, 260], 0.16, 'sawtooth', 0.05, 0.09),
      reverse: () => tone([392, 587, 392, 587], 0.1, 'triangle', 0.1, 0.06),
      plus: () => tone([330, 247, 196], 0.18, 'sawtooth', 0.05, 0.08),
      color: () => tone([523, 784], 0.25, 'sine', 0.12, 0.07),
      swap: () => {
        whoosh(0.7, 400, 3200, 0.7);
        tone([392, 523, 392, 523], 0.12, 'triangle', 0.07, 0.09);
      },
      rotate: () => {
        whoosh(1, 300, 2400, 0.7);
        tone([262, 330, 392, 523, 659], 0.14, 'triangle', 0.07, 0.08);
      },
      turn: () => tone([880, 1175], 0.16, 'sine', 0.07, 0.1),
      win: () => tone([523, 659, 784, 1047, 1319, 1568], 0.35, 'triangle', 0.1, 0.11),
      lose: () => tone([440, 370, 311, 262], 0.35, 'triangle', 0.08, 0.2),
      tick: () => tone([1200], 0.06, 'square', 0.04),
      get muted() { return muted; },
      toggle() {
        muted = !muted;
        store.set('nuno.muted', muted ? '1' : '0');
        if (!muted) ac();
        return muted;
      },
      unlock() { if (!muted) ac(); },
    };
  })();
  document.addEventListener('pointerdown', () => Sound.unlock(), { once: true });

  // ---------- Cards ----------
  function cardEl(card) {
    const e = el('div', `card c-${card.color}`);
    e.dataset.id = card.id;
    e.title = describe(card) + (card.chosen ? ` (${card.chosen})` : '');
    // A Wild on the pile shows its chosen color in place of the black.
    if (card.chosen) e.classList.add('filled', `f-${card.chosen}`);
    e.appendChild(el('span', 'oval'));
    if (card.value === 'wild') {
      const tl = el('span', 'corner tl');
      tl.appendChild(el('span', 'mini-wild'));
      const br = el('span', 'corner br');
      br.appendChild(el('span', 'mini-wild'));
      e.append(tl, br);
      return e;
    }
    const label = LABELS[card.value] || card.value;
    let kind = ['skip', 'reverse'].includes(card.value) ? ' sym' : LABELS[card.value] ? ' txt' : '';
    if (card.value === '6' || card.value === '9') kind += ' ul';
    const center = el('span', 'pip');
    center.appendChild(el('span', `glyph${kind}`, label));
    e.append(el('span', 'corner tl', label), center, el('span', 'corner br', label));
    return e;
  }

  function backEl() {
    const e = el('div', 'card back');
    const oval = el('span', 'oval');
    oval.appendChild(el('span', 'brand', 'NUNO'));
    e.appendChild(oval);
    return e;
  }

  // Each card gets a stable, slightly random position on the discard pile.
  function pileTransform(id) {
    return { r: ((id * 47) % 31) - 15, x: ((id * 13) % 11) - 5, y: ((id * 7) % 9) - 4 };
  }

  // ---------- Helpers ----------
  function toast(text, kind = '', ms = 2600) {
    const t = el('div', `toast ${kind}`, text);
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), ms);
    while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  }

  function emit(event, data = {}) {
    return new Promise((resolve) => socket.emit(event, data, (r) => resolve(r || { ok: false })));
  }

  // One action in flight at a time; the lock clears once the resulting state is shown.
  let acting = false;
  async function act(type, data = {}) {
    if (acting) return { ok: false };
    acting = true;
    const r = await emit('game:action', { type, ...data });
    if (!r.ok) {
      acting = false;
      if (r.error) toast(r.error, 'error');
    }
    return r;
  }

  function show(id) {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
  }

  function openModal(id, open) {
    $(id).classList.toggle('hidden', !open);
  }

  function myName() {
    const n = $('#name').value.trim();
    if (!n) {
      toast('Enter your name first.', 'error');
      $('#name').focus();
      return null;
    }
    store.set('nuno.name', n);
    return n;
  }

  function enterRoom(code) {
    store.set('nuno.room', code);
    history.replaceState(null, '', `?room=${code}`);
  }

  function exitRoom() {
    clearTimer();
    S = null;
    queue.length = 0;
    store.del('nuno.room');
    history.replaceState(null, '', location.pathname);
    for (const m of document.querySelectorAll('.modal')) m.classList.add('hidden');
    $('#fx').replaceChildren();
    prevHandIds = lastEventId = null;
    show('home');
  }

  function avatar(name, idx) {
    return el('span', `avatar av${idx % 8}`, (name || '?').trim()[0].toUpperCase());
  }

  // ---------- Home ----------
  $('#name').value = store.get('nuno.name') || '';
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) $('#code').value = urlRoom.toUpperCase().slice(0, 4);

  $('#create').addEventListener('click', async () => {
    const name = myName();
    if (!name) return;
    const r = await emit('room:create', { name });
    if (r.ok) enterRoom(r.code);
    else toast(r.error || 'Could not create a table.', 'error');
  });

  async function join() {
    const name = myName();
    if (!name) return;
    const code = $('#code').value.trim().toUpperCase();
    if (code.length !== 4) return toast('Enter the 4-letter table code.', 'error');
    const r = await emit('room:join', { code, name });
    if (r.ok) enterRoom(r.code);
    else toast(r.error || 'Could not join.', 'error');
  }
  $('#join').addEventListener('click', join);
  $('#code').addEventListener('keydown', (e) => e.key === 'Enter' && join());
  $('#name').addEventListener('keydown', (e) => e.key === 'Enter' && ($('#code').value.trim() ? join() : $('#create').click()));

  // ---------- Lobby ----------
  function renderLobby(s) {
    show('lobby');
    const isHost = s.hostIndex === s.you;
    $('#lobby-code').textContent = s.code;
    const list = $('#seats');
    list.replaceChildren();
    for (let i = 0; i < s.maxSeats; i++) {
      const seat = s.seats[i];
      const li = el('li', seat ? '' : 'empty');
      if (!seat) {
        li.textContent = 'Open seat';
      } else {
        li.append(avatar(seat.name, i), el('span', 'seat-name', seat.name));
        if (i === s.you) li.appendChild(el('span', 'tag', 'You'));
        if (i === s.hostIndex) li.appendChild(el('span', 'tag host', 'Host'));
        if (!seat.connected) li.appendChild(el('span', 'tag off', 'Offline'));
        if (isHost && i !== s.you) {
          const b = el('button', 'btn small-btn', 'Remove');
          b.addEventListener('click', () => emit('room:kick', { seat: i }));
          li.appendChild(b);
        }
      }
      list.appendChild(li);
    }
    $('#host-controls').classList.toggle('hidden', !isHost);
    $('#add-bot').disabled = s.seats.length >= s.maxSeats;
    $('#start').classList.toggle('hidden', !isHost);
    $('#start').disabled = s.seats.length < 2;
    $('#lobby-hint').textContent = isHost
      ? s.seats.length < 2
        ? `Share the code with friends or add a bot — you need 2 to ${s.maxSeats} players.`
        : `Ready with ${s.seats.length} players.`
      : `Waiting for ${s.seats[s.hostIndex]?.name || 'the host'} to start…`;
  }

  $('#add-bot').addEventListener('click', async () => {
    const r = await emit('room:addBot');
    if (!r.ok) toast(r.error, 'error');
  });
  $('#start').addEventListener('click', async () => {
    Sound.unlock();
    const r = await emit('room:start');
    if (!r.ok) toast(r.error, 'error');
  });
  $('#copy-link').addEventListener('click', async () => {
    const link = `${location.origin}/?room=${S.code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied!');
    } catch {
      prompt('Copy this invite link:', link);
    }
  });

  async function leave() {
    if (S && S.game && S.game.phase !== 'gameOver' && !confirm('Leave the game? A bot will take your seat.')) return;
    await emit('room:leave');
    exitRoom();
  }
  $('#leave-lobby').addEventListener('click', leave);
  $('#leave-game').addEventListener('click', leave);

  // ---------- Board rendering ----------
  // 2–4 players keep the original three-spot layout. Bigger tables seat opponents clockwise
  // up the left, across the top and down the right in compact seats; on phones they share
  // a grid across the top.
  const SLOT_LAYOUT = { 2: ['top'], 3: ['left', 'right'], 4: ['left', 'top', 'right'] };
  const BIG_LAYOUT = { 5: [1, 2, 1], 6: [1, 3, 1], 7: [2, 2, 2], 8: [2, 3, 2] };
  const phoneQuery = window.matchMedia('(max-width: 700px)');

  function seatSlots(n) {
    if (n <= 4) return SLOT_LAYOUT[n];
    if (phoneQuery.matches) return Array(n - 1).fill('top');
    const [left, top, right] = BIG_LAYOUT[n];
    return [...Array(left).fill('left'), ...Array(top).fill('top'), ...Array(right).fill('right')];
  }

  function fillFan(fan, count, max = 10) {
    fan.replaceChildren();
    const shown = Math.min(count, max);
    for (let k = 0; k < shown; k++) {
      const b = backEl();
      b.style.setProperty('--rot', `${(k - (shown - 1) / 2) * 5}deg`);
      fan.appendChild(b);
    }
    if (count > shown) fan.appendChild(el('span', 'more', `+${count - shown}`));
  }

  function setOppCount(idx, count) {
    const box = document.querySelector(`.opp[data-seat="${idx}"]`);
    if (!box) return;
    fillFan(box.querySelector('.fan'), count, box.classList.contains('compact') ? 5 : 10);
    box.querySelector('.opp-meta').textContent = `${count} card${count === 1 ? '' : 's'}`;
  }

  function renderOpponent(s, g, idx, shownCount, compact) {
    const p = g.players[idx];
    const seat = s.seats[idx];
    const box = el('div', compact ? 'opp compact' : 'opp');
    box.dataset.seat = idx;
    if (idx === shownTurn) box.classList.add('active');

    const head = el('div', 'opp-head');
    head.append(avatar(p.name, idx), el('span', 'opp-name', p.name));
    if (idx === g.dealer) head.appendChild(el('span', 'chip dealer', 'D'));
    if (seat && !seat.connected) head.appendChild(el('span', 'tag off', 'Offline'));
    box.appendChild(head);
    box.appendChild(el('div', 'fan'));
    box.appendChild(el('div', 'opp-meta'));
    fillFan(box.querySelector('.fan'), shownCount, compact ? 5 : 10);
    box.querySelector('.opp-meta').textContent = `${shownCount} card${shownCount === 1 ? '' : 's'}`;

    if (p.saidUno) box.appendChild(el('span', 'badge-uno', 'UNO!'));
    if (g.unoVulnerable === idx) {
      const b = el('button', 'catch-btn', 'Catch! No UNO');
      b.addEventListener('click', () => act('catch', { target: idx }));
      box.appendChild(b);
    }
    // After your 7 the seats become swap targets (see renderControls).
    box.addEventListener('click', (e) => {
      if (box.classList.contains('swap-target') && !e.target.closest('.catch-btn')) act('swap', { target: idx });
    });
    return box;
  }

  function statusText(g) {
    const me = g.you;
    const who = g.players[g.turn]?.name;
    if (g.phase === 'chooseColor') return g.turn === me ? 'Choose the starting color' : `${who} is choosing the color`;
    if (g.phase === 'chooseSwap') return g.turn === me ? 'Pick a player to swap hands with' : `${who} is picking a hand to swap with`;
    if (g.phase === 'play') {
      if (g.drawStack > 0) {
        if (g.turn !== me) return `${who} must stack or take +${g.drawStack}`;
        const plus = g.stackType === 'wild4' ? '+4' : '+2';
        return g.playable.length ? `Stack a ${plus}, or take ${g.drawStack} cards` : `No ${plus} — take ${g.drawStack} cards`;
      }
      if (g.turn !== me) return `${who}’s turn`;
      if (g.pendingDrawn !== null) return 'Play the card you drew, or keep it';
      return g.playable.length ? 'Your turn — play a card or draw' : 'No match — draw a card';
    }
    return 'Game over';
  }

  function sortHand(hand) {
    return hand.slice().sort(
      (a, b) =>
        COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color) ||
        VALUE_ORDER.indexOf(a.value) - VALUE_ORDER.indexOf(b.value)
    );
  }

  // Lays the hand out as a gentle arc, overlapping cards when space runs out.
  function layoutHand() {
    const hand = $('#hand');
    const cards = [...hand.children];
    const n = cards.length;
    if (!n) return;
    const cw = cards[0].offsetWidth;
    const avail = hand.clientWidth - 24;
    const gap = 4;
    const need = n * cw + (n - 1) * gap;
    const margin = need > avail && n > 1 ? (avail - cw) / (n - 1) - cw : gap;
    const step = Math.min(4, 36 / Math.max(n, 1));
    const mid = (n - 1) / 2;
    cards.forEach((c, i) => {
      const off = i - mid;
      c.style.marginLeft = i === 0 ? '0' : `${margin}px`;
      c.style.setProperty('--rot', `${off * step}deg`);
      c.style.setProperty('--y', `${Math.abs(off) ** 2 * step * 0.35}px`);
    });
  }
  window.addEventListener('resize', layoutHand);

  function onCardClick(card) {
    const g = S.game;
    if (g.phase !== 'play' || g.turn !== g.you) return toast('It’s not your turn.', 'error');
    if (!g.playable.includes(card.id)) {
      if (g.pendingDrawn !== null) return toast('You can only play the card you just drew.', 'error');
      if (g.drawStack > 0) {
        const plus = g.stackType === 'wild4' ? '+4' : '+2';
        return toast(`Only a ${plus} can go on a ${plus} stack — or take the ${g.drawStack} cards.`, 'error');
      }
      return toast(`Match the ${g.currentColor} color or the ${describe(g.top).replace(/^\w+ /, '')}.`, 'error');
    }
    if (card.color === 'wild') {
      pendingWildId = card.id;
      colorMode = 'play';
      $('#color-cancel').classList.remove('hidden');
      openModal('#color-modal', true);
      return;
    }
    act('play', { cardId: card.id });
  }

  // `cards` shows a hand you're about to give away (a 7 or 0 in this update) instead of your current one.
  function renderHand(g, hidden, cards) {
    const hand = $('#hand');
    const live = !cards;
    hand.replaceChildren();
    hand.classList.toggle('my-turn', live && g.phase === 'play' && g.turn === g.you);
    for (const card of sortHand(cards || g.hand)) {
      const c = cardEl(card);
      if (live && g.playable.includes(card.id)) c.classList.add('playable');
      if (live && card.id === g.pendingDrawn) c.classList.add('drawn');
      if (hidden.has(card.id)) c.classList.add('incoming');
      c.addEventListener('click', () => onCardClick(card));
      hand.appendChild(c);
    }
    layoutHand();
  }

  // Wilds in `unfilled` stay black until their color event paints them.
  function renderDiscard(g, hidden, unfilled = new Set()) {
    const d = $('#discard');
    d.replaceChildren();
    for (const c of g.discardTail) {
      const pending = unfilled.has(c.id) && c.chosen;
      const e = cardEl(pending ? { ...c, chosen: null } : c);
      if (pending) e.dataset.fill = c.chosen;
      const t = pileTransform(c.id);
      e.style.transform = `translate(${t.x}px, ${t.y}px) rotate(${t.r}deg)`;
      if (hidden.has(c.id)) e.classList.add('incoming');
      d.appendChild(e);
    }
  }

  function renderBoard(s, hide) {
    show('game');
    const g = s.game;
    const me = g.you;
    const n = g.players.length;

    const big = n > 4;
    $('.table').classList.toggle('big', big);
    for (const slot of ['top', 'left', 'right']) $(`#opp-${slot}`).replaceChildren();
    seatSlots(n).forEach((slot, k) => {
      const idx = (me + k + 1) % n;
      const shown = Math.max(0, g.players[idx].count - (hide.opp[idx] || 0));
      $(`#opp-${slot}`).appendChild(renderOpponent(s, g, idx, shown, big));
    });

    $('#deck-count').textContent = `${g.deckCount} left`;
    renderDiscard(g, hide.pile, hide.fill);
    setStackBadge(hide.stack ?? g.drawStack);
    $('#direction').className = `direction ${g.currentColor || ''} ${g.direction === -1 ? 'ccw' : ''}`;

    const mine = g.players[me];
    $('#me-avatar').replaceChildren(avatar(mine.name, me));
    $('#me-name').textContent = mine.name + (me === g.dealer ? ' (dealer)' : '');
    setMeCount(hide.oldHand ? hide.oldHand.length : mine.count);
    renderHand(g, hide.hand, hide.oldHand);
    if (!hide.deferControls) renderControls(g);
  }

  function setMeCount(count) {
    $('#me-count').textContent = `${count} card${count === 1 ? '' : 's'}`;
  }

  // Turn controls (status, Take / Pass / UNO, drawable deck). While an update animates,
  // these wait so they don't jump ahead of the cards still in the air.
  function renderControls(g) {
    const me = g.you;
    const live = g.phase !== 'gameOver';
    shownTurn = live ? g.turn : null;
    $('.me').classList.toggle('active', shownTurn === me);
    for (const o of document.querySelectorAll('.opp')) o.classList.toggle('active', Number(o.dataset.seat) === shownTurn);
    // After playing a 7, every opponent's seat is a button (clicks handled in renderOpponent).
    const choosing = g.phase === 'chooseSwap' && g.turn === me;
    for (const o of document.querySelectorAll('.opp')) {
      o.classList.toggle('swap-target', choosing);
      o.querySelector('.swap-btn')?.remove();
      if (choosing) o.appendChild(el('button', 'swap-btn', '⇆ Swap'));
    }
    $('#deck').classList.toggle('can-draw', g.phase === 'play' && g.turn === me && g.pendingDrawn === null);
    const status = statusText(g);
    if ($('#status').textContent !== status) {
      $('#status').textContent = status;
      $('#status').classList.remove('flash');
      void $('#status').offsetWidth;
      $('#status').classList.add('flash');
    }
    $('#pass').classList.toggle('hidden', !(g.phase === 'play' && g.turn === me && g.pendingDrawn !== null));
    const mustAnswer = g.phase === 'play' && g.turn === me && g.drawStack > 0;
    $('#take').classList.toggle('hidden', !mustAnswer);
    $('#take').textContent = `Take +${g.drawStack}`;
    $('#deck').title = mustAnswer ? `Take ${g.drawStack} cards` : 'Draw a card';
    // Only before playing down to one card — forget, and it's too late to call it.
    const unoReady = live && g.hand.length === 2 && g.turn === me && !g.calledUno && g.playable.length > 0;
    $('#uno').disabled = !unoReady;
    $('#uno').classList.toggle('ready', unoReady);
    $('#uno').textContent = g.calledUno && g.hand.length <= 2 ? 'UNO ✓' : 'UNO!';
    renderTimer(g);
  }

  // Countdown bar on the seat whose turn it is (humans only). On your own turn it also shows
  // the seconds left and ticks for the last three. The server enforces the deadline.
  let timerJobs = [];
  function clearTimer() {
    for (const t of timerJobs) clearTimeout(t);
    timerJobs = [];
    for (const e of document.querySelectorAll('.turn-timer, .turn-secs')) e.remove();
  }

  function renderTimer(g) {
    clearTimer();
    if (g.turnMsLeft == null || g.phase === 'gameOver') return;
    const left = g.receivedAt + g.turnMsLeft - performance.now();
    if (left <= 0) return;
    const mine = g.turn === g.you;
    const host = mine ? $('.me-bar') : document.querySelector(`.opp[data-seat="${g.turn}"]`);
    if (!host) return;
    const total = g.turnMs;
    const bar = el('div', 'turn-timer');
    const fill = el('span', 'turn-timer-fill');
    bar.appendChild(fill);
    host.appendChild(bar);
    // The clock starts after the update's animations; until then the bar sits full.
    const wait0 = Math.max(0, left - total);
    const run = Math.min(left, total);
    fill.animate([{ transform: `scaleX(${run / total})` }, { transform: 'scaleX(0)' }], { duration: run, delay: wait0, easing: 'linear', fill: 'both' });
    timerJobs.push(setTimeout(() => bar.classList.add('warn'), Math.max(0, left - 3000)));
    if (!mine) return;
    const secs = el('span', 'turn-secs');
    $('.me-actions').prepend(secs);
    const show = () => {
      const remain = Math.min(total, g.receivedAt + g.turnMsLeft - performance.now());
      secs.textContent = String(Math.max(0, Math.ceil(remain / 1000)));
      secs.classList.toggle('warn', remain <= 3000);
    };
    show();
    for (let k = 1; k <= 10; k++) {
      const at = left - k * 1000;
      if (at > 0) timerJobs.push(setTimeout(show, at + 5));
      if (k <= 3 && at > 0) timerJobs.push(setTimeout(Sound.tick, at));
    }
    timerJobs.push(setTimeout(show, left));
  }

  // The running +2/+4 total sits next to the discard pile.
  function setStackBadge(total) {
    const b = $('#stack');
    b.classList.toggle('hidden', !total);
    if (total) b.textContent = `+${total}`;
  }

  // Dialogs open only after the animations for an update have played.
  function renderModals(s) {
    const g = s.game;
    const me = g.you;
    if (g.phase === 'chooseColor' && g.turn === me) {
      colorMode = 'choose';
      $('#color-cancel').classList.add('hidden');
      openModal('#color-modal', true);
    } else if (colorMode === 'choose' || (colorMode === 'play' && !g.playable.includes(pendingWildId))) {
      colorMode = null;
      pendingWildId = null;
      openModal('#color-modal', false);
    }
    renderResult(s, g);
  }

  function renderResult(s, g) {
    const over = g.phase === 'gameOver';
    openModal('#result-modal', over);
    if (!over) return;
    const res = g.result;
    const isHost = s.hostIndex === s.you;
    $('#result-title').textContent = res.winner === g.you ? 'You win!' : `${g.players[res.winner].name} wins!`;
    const order = g.players
      .map((p, i) => ({ i, p, cards: res.hands[i].cards }))
      .sort((a, b) => a.cards.length - b.cards.length);
    const list = $('#result-list');
    list.replaceChildren();
    order.forEach(({ i, p, cards }, k) => {
      const li = el('li', i === res.winner ? 'winner' : '');
      li.style.animationDelay = `${k * 90}ms`;
      li.appendChild(el('span', 'pos', i === res.winner ? '🥇' : String(k + 1)));
      li.appendChild(el('span', 'who', p.name + (i === g.you ? ' (you)' : '')));
      const mini = el('div', 'mini-hand');
      if (!cards.length) mini.textContent = 'Out!';
      for (const c of sortHand(cards)) mini.appendChild(cardEl(c));
      li.appendChild(mini);
      list.appendChild(li);
    });
    $('#rematch').classList.toggle('hidden', !isHost);
    $('#to-lobby').classList.toggle('hidden', !isHost);
    $('#result-wait').textContent = isHost ? '' : 'Waiting for the host to start a rematch…';
  }

  // ---------- Animation primitives ----------
  const fx = $('#fx');

  function point(elm, rot = 0) {
    const r = elm.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: elm.offsetWidth || r.width, rot };
  }

  function seatPoint(idx) {
    if (idx === S.game.you) return point($('#hand'));
    const fan = document.querySelector(`.opp[data-seat="${idx}"] .fan`);
    return fan ? { ...point(fan), w: fan.querySelector('.card')?.offsetWidth || 34 } : point($('#deck .card'));
  }

  function splashPoint(idx) {
    if (idx === S.game.you) return point($('.me-bar'));
    const box = document.querySelector(`.opp[data-seat="${idx}"]`);
    return box ? point(box) : point($('#discard'));
  }

  // Flies a card from one point to another. With `flip`, it turns from its back to its face
  // (or, with flip: 'out', from its face to its back). `bend` curves the path sideways, to the
  // left of travel, so two cards trading places orbit past each other.
  function fly({ card, from, to, flip = false, duration = 420, delay = 0, lift = 60, bend = 0, onStart, onLand }) {
    const w = to.w;
    const h = w * 1.5;
    const node = el('div', 'flyer');
    node.style.setProperty('--cw', `${w}px`);
    let inner;
    if (flip && card) {
      inner = el('div', 'flip3d');
      const spin = el('div', 'flip-inner');
      spin.append(cardEl(card), backEl());
      inner.appendChild(spin);
    } else {
      inner = card ? cardEl(card) : backEl();
    }
    node.appendChild(inner);
    node.style.visibility = 'hidden';
    fx.appendChild(node);

    const s0 = (from.w || w) / w;
    const dx = to.cx - from.cx;
    const dy = to.cy - from.cy;
    const len = Math.hypot(dx, dy) || 1;
    const mx = (from.cx + to.cx) / 2 + (bend * dy) / len;
    const my = (from.cy + to.cy) / 2 - lift - (bend * dx) / len;
    const frames = [
      { transform: `translate(${from.cx - w / 2}px, ${from.cy - h / 2}px) rotate(${from.rot || 0}deg) scale(${s0})` },
      { transform: `translate(${mx - w / 2}px, ${my - h / 2}px) rotate(${((from.rot || 0) + to.rot) / 2 + 8}deg) scale(${Math.max(s0, 1) * 1.08})`, offset: 0.5 },
      { transform: `translate(${to.cx - w / 2}px, ${to.cy - h / 2}px) rotate(${to.rot}deg) scale(1)` },
    ];
    const opts = { duration, delay, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'both' };
    const anim = node.animate(frames, opts);
    if (flip && card) {
      const turn = flip === 'out' ? ['rotateY(0deg)', 'rotateY(180deg)'] : ['rotateY(180deg)', 'rotateY(0deg)'];
      inner.firstChild.animate(turn.map((transform) => ({ transform })), { ...opts, easing: 'ease-in-out' });
    }
    setTimeout(() => {
      node.style.visibility = '';
      if (onStart) onStart();
    }, delay);
    return anim.finished.then(() => {
      if (onLand) onLand();
      node.remove();
    });
  }

  function splash(text, at, cls, duration = 900) {
    const n = el('div', `splash ${cls}`);
    n.appendChild(el('span', 'splash-inner', text));
    n.style.left = `${at.cx}px`;
    n.style.top = `${at.cy}px`;
    n.style.setProperty('--d', `${duration}ms`);
    fx.appendChild(n);
    setTimeout(() => n.remove(), duration + 50);
    return wait(duration * 0.75);
  }

  function ripple(color, at) {
    if (!color) return;
    for (const [cls, delay] of [['fill', 0], ['', 0], ['', 160]]) {
      const r = el('div', `ripple r-${color} ${cls}`);
      r.style.left = `${at.cx}px`;
      r.style.top = `${at.cy}px`;
      r.style.animationDelay = `${delay}ms`;
      fx.appendChild(r);
      setTimeout(() => r.remove(), 1100 + delay);
    }
  }

  function confetti() {
    const colors = ['#e5322d', '#f7c51e', '#2fa84f', '#1d6fd6', '#ffffff'];
    const W = window.innerWidth;
    const H = window.innerHeight;
    for (let i = 0; i < 120; i++) {
      const c = el('div', 'confetti');
      c.style.background = colors[i % colors.length];
      fx.appendChild(c);
      const x = Math.random() * W;
      const drift = (Math.random() - 0.5) * 300;
      const dur = 1800 + Math.random() * 1600;
      c.animate(
        [
          { transform: `translate(${x}px, -20px) rotate(0deg)` },
          { transform: `translate(${x + drift}px, ${H + 40}px) rotate(${720 + Math.random() * 720}deg)` },
        ],
        { duration: dur, delay: Math.random() * 500, easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'both' }
      ).finished.then(() => c.remove());
    }
  }

  function bump(elm, cls) {
    if (!elm) return;
    elm.classList.remove(cls);
    void elm.offsetWidth;
    elm.classList.add(cls);
  }

  // ---------- Event animations ----------
  function discardTarget(card) {
    const d = $('#discard');
    const t = pileTransform(card.id);
    const p = point(d, t.r);
    return { ...p, cx: p.cx + t.x, cy: p.cy + t.y };
  }

  function revealPile(id) {
    const c = document.querySelector(`#discard .card[data-id="${id}"]`);
    if (c) c.classList.remove('incoming');
    bump($('#discard'), 'land');
  }

  function revealHand(id) {
    const c = document.querySelector(`#hand .card[data-id="${id}"]`);
    if (c) c.classList.remove('incoming');
  }

  // Paints a Wild's black background in the chosen color, spreading out from the center.
  function fillWild(card, color) {
    card.classList.add('filled', `f-${color}`, 'fill-anim');
    delete card.dataset.fill;
  }

  // Where a whole hand lands: your hand area at full card size, or an opponent's fan.
  function seatTarget(idx) {
    if (idx !== S.game.you) return { ...seatPoint(idx), rot: 0 };
    const hand = $('#hand');
    return { ...point(hand), w: parseFloat(getComputedStyle(hand).getPropertyValue('--cw')) || 84 };
  }

  // Hands changing owners (7 swap, 0 rotate). `moves` lists [fromSeat, toSeat] pairs; all hands
  // fly at once as bundles of cards, fans empty on take-off and refill on landing, and your new
  // hand deals itself face up when it arrives.
  async function moveHands(e, moves, ctx) {
    const g = S.game;
    const me = g.you;
    // Every path bends the same way relative to its travel, so two hands trading places orbit
    // past each other and a rotation swirls round the table.
    const bend = 120;
    const lift = 0;
    for (const [from] of moves) {
      if (from !== me) setOppCount(from, 0);
      document.querySelector(from === me ? '.me-bar' : `.opp[data-seat="${from}"]`)?.classList.add('swapping');
    }
    const jobs = moves.map(([from, to]) => {
      const dest = seatTarget(to);
      const flights = [];
      if (from === me) {
        // Your own cards leave face up, turning over as they go.
        const byId = new Map((ctx.oldHand || g.hand).map((c) => [c.id, c]));
        [...$('#hand').children].forEach((node, j) => {
          const card = byId.get(Number(node.dataset.id));
          const rot = parseFloat(node.style.getPropertyValue('--rot')) || 0;
          flights.push(fly({
            card, from: point(node, rot), to: dest, flip: 'out', lift, bend,
            duration: 700, delay: Math.min(j * 30, 300),
            onStart: () => { node.style.visibility = 'hidden'; },
          }));
        });
        setMeCount(0);
      } else {
        const src = seatTarget(from);
        const n = Math.min(e.before[from], 8);
        for (let j = 0; j < n; j++) flights.push(fly({ from: src, to: dest, lift, bend, duration: 700, delay: j * 45 }));
      }
      return Promise.all(flights).then(() => {
        if (to === me) {
          ctx.handDealt = true;
          return dealNewHand(g);
        }
        ctx.shown[to] = e.after[to];
        setOppCount(to, e.after[to]);
        bump(document.querySelector(`.opp[data-seat="${to}"]`), 'land');
      });
    });
    await Promise.all(jobs);
    for (const s of document.querySelectorAll('.swapping')) s.classList.remove('swapping');
  }

  // Your freshly received hand fans out and flips face up, card by card.
  async function dealNewHand(g) {
    renderHand(g, new Set());
    setMeCount(g.hand.length);
    const cards = [...$('#hand').children];
    cards.forEach((c, j) => {
      c.style.animationDelay = `${Math.min(j * 40, 400)}ms`;
      c.classList.add('swap-in');
    });
    Sound.deal();
    await wait(Math.min(cards.length * 40, 400) + 450);
    for (const c of cards) c.classList.remove('swap-in');
  }

  async function dealTo(ctx, seat, delay) {
    const g = S.game;
    const deck = point($('#deck .card'));
    if (seat === g.you) {
      const id = ctx.mine.shift();
      const target = document.querySelector(`#hand .card[data-id="${id}"]`);
      if (!target) return;
      const card = g.hand.find((c) => c.id === id);
      const rot = parseFloat(target.style.getPropertyValue('--rot')) || 0;
      return fly({ card, from: deck, to: point(target, rot), flip: true, delay, duration: 420, lift: 40, onStart: Sound.deal, onLand: () => revealHand(id) });
    }
    return fly({
      from: deck, to: { ...seatPoint(seat), rot: 0 }, delay, duration: 380, lift: 30,
      onStart: Sound.deal,
      onLand: () => {
        ctx.shown[seat] = (ctx.shown[seat] || 0) + 1;
        setOppCount(seat, ctx.shown[seat]);
      },
    });
  }

  async function animateEvent(e, ctx) {
    const g = S.game;
    const me = g.you;
    const n = g.players.length;
    switch (e.type) {
      case 'deal': {
        const left = (e.dealer + 1) % n;
        const stagger = n <= 4 ? 70 : Math.round(280 / n);
        const jobs = [];
        let k = 0;
        for (let round = 0; round < 7; round++) {
          for (let s = 0; s < n; s++) jobs.push(dealTo(ctx, (left + s) % n, stagger * k++));
        }
        await Promise.all(jobs);
        break;
      }
      case 'flip':
        await fly({ card: e.card, from: point($('#deck .card')), to: discardTarget(e.card), flip: true, duration: 500, lift: 50, onStart: Sound.draw, onLand: () => { revealPile(e.card.id); Sound.play(); } });
        break;
      case 'play': {
        let from;
        if (e.player === me) {
          from = ctx.handRects.get(e.card.id) || point($('#hand'));
        } else {
          from = { ...seatPoint(e.player), rot: 0 };
        }
        // A Wild flies in black; its color event fills it once it's on the pile.
        await fly({
          card: { ...e.card, chosen: null }, from, to: discardTarget(e.card), flip: e.player !== me,
          duration: 450, lift: 70,
          onStart: Sound.draw,
          onLand: () => { revealPile(e.card.id); Sound.play(); },
        });
        if (e.card.value === 'wild4' || e.card.value === 'wild') await wait(80);
        break;
      }
      case 'color': {
        Sound.color();
        const wild = document.querySelector(`#discard .card[data-id="${e.cardId}"]`);
        if (wild) fillWild(wild, e.color);
        ripple(e.color, point($('#discard')));
        bump($('#direction'), 'burst');
        await wait(650);
        break;
      }
      case 'swap':
        Sound.swap();
        splash('⇆', point($('.center')), 'swap', 1100);
        await moveHands(e, [[e.player, e.target], [e.target, e.player]], ctx);
        break;
      case 'rotate': {
        Sound.rotate();
        bump($('#direction'), 'whirl');
        splash('0', point($('.center')), `rotate${e.direction === -1 ? ' ccw' : ''}`, 1200);
        const step = (s) => (((s + e.direction) % n) + n) % n;
        await moveHands(e, g.players.map((_, s) => [s, step(s)]), ctx);
        break;
      }
      case 'skip':
        Sound.skip();
        bump(document.querySelector(`.opp[data-seat="${e.player}"]`), 'hit');
        await splash('⊘', splashPoint(e.player), 'skip', 850);
        break;
      case 'reverse':
        Sound.reverse();
        bump($('#direction'), 'burst');
        await splash('⇄', point($('.center')), 'reverse', 900);
        break;
      case 'stack':
        Sound.plus();
        setStackBadge(e.total);
        bump($('#stack'), 'grow');
        bump(document.querySelector(`.opp[data-seat="${e.target}"]`), 'hit');
        await splash(`+${e.total}`, point($('#discard')), 'plus', 750);
        break;
      case 'draw': {
        if (e.reason === 'draw2' || e.reason === 'stack') {
          Sound.plus();
          setStackBadge(0);
          bump(document.querySelector(`.opp[data-seat="${e.player}"]`), 'hit');
          await splash(`+${e.count}`, splashPoint(e.player), 'plus', 800);
        }
        const jobs = [];
        for (let k = 0; k < e.count; k++) {
          if (e.player === me) {
            jobs.push(dealTo(ctx, me, k * 130));
          } else {
            jobs.push(dealTo(ctx, e.player, k * 130));
          }
        }
        await Promise.all(jobs);
        break;
      }
      case 'uno':
        Sound.uno();
        await splash('UNO!', splashPoint(e.player), 'uno', 1000);
        break;
      case 'timeout':
        Sound.skip();
        bump(document.querySelector(`.opp[data-seat="${e.player}"]`), 'hit');
        await splash('Time’s up!', splashPoint(e.player), 'timeup', 900);
        break;
      case 'catch':
        Sound.skip();
        bump(document.querySelector(`.opp[data-seat="${e.player}"]`), 'hit');
        await splash('Caught!', splashPoint(e.player), 'caught', 900);
        break;
      case 'reshuffle': {
        const jobs = [];
        for (let k = 0; k < 5; k++) {
          jobs.push(fly({ from: point($('#discard')), to: point($('#deck .card')), delay: k * 60, duration: 350, lift: 30 }));
        }
        Sound.deal();
        await Promise.all(jobs);
        break;
      }
      case 'win': {
        const won = e.player === me;
        if (won) {
          Sound.win();
          confetti();
        } else {
          Sound.lose();
        }
        await splash(won ? 'YOU WIN!' : `${g.players[e.player].name} wins!`, point($('.center')), won ? 'win' : 'lose', 1800);
        break;
      }
    }
  }

  // Works out which cards must stay hidden until an animation delivers them.
  function planHidden(g, events, newIds, prevStack, prevHand) {
    const hide = { hand: new Set(), pile: new Set(), opp: {}, fill: new Set() };
    if (events.some((e) => e.type === 'stack')) hide.stack = prevStack;
    for (const e of events) {
      if (e.type === 'play' || e.type === 'flip') hide.pile.add(e.card.id);
      else if (e.type === 'color' && e.cardId != null) hide.fill.add(e.cardId);
    }

    // Opponents' fans start from what they held before the update: walk back from the final
    // counts. (A played card already counts as gone while it flies to the pile.)
    const start = g.players.map((p) => p.count);
    for (const e of events.slice().reverse()) {
      if (e.type === 'draw') start[e.player] -= e.count;
      else if (e.type === 'swap' || e.type === 'rotate') start.splice(0, start.length, ...e.before);
      else if (e.type === 'deal') start.fill(0);
    }
    const shown = {};
    g.players.forEach((p, i) => {
      if (i === g.you) return;
      shown[i] = Math.max(0, start[i]);
      hide.opp[i] = p.count - shown[i];
    });

    // If your hand is about to be swapped away, keep showing it until the animation takes it.
    const mine = [];
    const handMoves = events.some((e) => e.type === 'rotate' || (e.type === 'swap' && (e.player === g.you || e.target === g.you)));
    if (handMoves) {
      const played = new Set(events.filter((e) => e.type === 'play' && e.player === g.you).map((e) => e.card.id));
      hide.oldHand = prevHand.filter((c) => !played.has(c.id));
      return { hide, mine, shown };
    }
    let needMine = 0;
    for (const e of events) {
      if (e.type === 'deal') needMine += 7;
      else if (e.type === 'draw' && e.player === g.you) needMine += e.count;
    }
    const newest = sortHand(g.hand).filter((c) => newIds.has(c.id)).map((c) => c.id);
    for (const id of newest.slice(0, needMine)) {
      hide.hand.add(id);
      mine.push(id);
    }
    return { hide, mine, shown };
  }

  // ---------- State pipeline ----------
  const queue = [];
  let busy = false;

  phoneQuery.addEventListener('change', () => {
    if (!busy && S && S.game && S.game.players.length > 4) {
      renderBoard(S, { hand: new Set(), pile: new Set(), opp: {} });
    }
  });

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const s = queue.shift();
        await apply(s, queue.length > 2);
      }
    } finally {
      busy = false;
    }
  }

  async function apply(s, fast) {
    acting = false;
    const prev = S;
    S = s;
    const g = s.game;
    if (!g) {
      clearTimer();
      prevHandIds = lastEventId = null;
      for (const m of ['#color-modal', '#result-modal']) openModal(m, false);
      fx.replaceChildren();
      renderLobby(s);
      return;
    }

    const pg = prev && prev.game;
    const sameGame = pg && pg.id === g.id;
    let events = [];
    if (prev && sameGame) events = g.events.filter((e) => e.id > lastEventId);
    else if (prev) events = g.events.slice(); // a new game just started
    lastEventId = g.events.length ? g.events[g.events.length - 1].id : 0;

    const skip = fast || !animOn || document.hidden || events.length > 14;
    const handRects = new Map();
    for (const c of $('#hand').children) {
      handRects.set(Number(c.dataset.id), point(c, parseFloat(c.style.getPropertyValue('--rot')) || 0));
    }
    const known = sameGame && prevHandIds ? prevHandIds : new Set();
    const newIds = new Set(g.hand.filter((c) => !known.has(c.id)).map((c) => c.id));
    prevHandIds = new Set(g.hand.map((c) => c.id));

    const plan = skip
      ? { hide: { hand: new Set(), pile: new Set(), opp: {} }, mine: [], shown: {} }
      : planHidden(g, events, newIds, sameGame ? pg.drawStack : 0, sameGame ? pg.hand : []);
    plan.hide.deferControls = !skip && events.length > 0;
    renderBoard(s, plan.hide);

    if (!skip) {
      const ctx = { handRects, mine: plan.mine, shown: plan.shown, oldHand: plan.hide.oldHand };
      for (const e of events) {
        try {
          await animateEvent(e, ctx);
        } catch (err) {
          console.error(err);
        }
      }
      // Anything an animation didn't deliver gets shown now.
      for (const c of document.querySelectorAll('.incoming')) c.classList.remove('incoming');
      for (const c of document.querySelectorAll('#discard [data-fill]')) fillWild(c, c.dataset.fill);
      if (plan.hide.oldHand && !ctx.handDealt) renderHand(g, new Set());
      g.players.forEach((p, i) => i !== g.you && setOppCount(i, p.count));
      setMeCount(g.players[g.you].count);
      setStackBadge(g.drawStack);
      renderControls(g);
    }

    const myTurnNow = g.phase !== 'gameOver' && g.turn === g.you;
    const myTurnBefore = sameGame && pg.phase !== 'gameOver' && pg.turn === pg.you;
    if (myTurnNow && !myTurnBefore) Sound.turn();

    renderModals(s);
  }

  // ---------- Game controls ----------
  $('#deck').addEventListener('click', () => {
    const g = S && S.game;
    if (!g || g.phase !== 'play' || g.turn !== g.you) return;
    if (g.pendingDrawn !== null) return toast('You already drew — play it or keep it.', 'error');
    act('draw');
  });
  $('#pass').addEventListener('click', () => act('pass'));
  $('#take').addEventListener('click', () => act('draw'));
  $('#uno').addEventListener('click', () => act('uno'));
  for (const b of document.querySelectorAll('.wedge')) {
    b.addEventListener('click', () => {
      const color = b.dataset.color;
      if (colorMode === 'choose') act('chooseColor', { color });
      else if (colorMode === 'play' && pendingWildId !== null) act('play', { cardId: pendingWildId, color });
      colorMode = null;
      pendingWildId = null;
      openModal('#color-modal', false);
    });
  }
  $('#color-cancel').addEventListener('click', () => {
    colorMode = null;
    pendingWildId = null;
    openModal('#color-modal', false);
  });
  $('#rematch').addEventListener('click', async () => {
    const r = await emit('game:rematch');
    if (!r.ok && r.error) toast(r.error, 'error');
  });
  $('#to-lobby').addEventListener('click', () => emit('game:backToLobby'));

  $('#sound').textContent = Sound.muted ? '🔇' : '🔊';
  $('#sound').addEventListener('click', () => {
    $('#sound').textContent = Sound.toggle() ? '🔇' : '🔊';
  });

  const syncAnimBtn = () => {
    $('#anim').textContent = animOn ? '✨' : '✨ off';
    $('#anim').title = animOn ? 'Turn animations off' : 'Turn animations on';
  };
  syncAnimBtn();
  $('#anim').addEventListener('click', () => {
    animOn = !animOn;
    store.set('nuno.anim', animOn ? '1' : '0');
    document.body.classList.toggle('no-anim', !animOn);
    syncAnimBtn();
  });

  // Keyboard: U to call UNO, D to draw (or take a stack), P to keep & pass
  document.addEventListener('keydown', (e) => {
    if (!S || !S.game || e.target.matches('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'u' && !$('#uno').disabled) act('uno');
    if (k === 'd') $('#deck').click();
    if (k === 'p' && !$('#pass').classList.contains('hidden')) act('pass');
  });

  // Rules
  for (const b of document.querySelectorAll('.rules-open')) b.addEventListener('click', () => openModal('#rules-modal', true));
  $('#rules-close').addEventListener('click', () => openModal('#rules-modal', false));
  $('#rules-modal').addEventListener('click', (e) => e.target.id === 'rules-modal' && openModal('#rules-modal', false));

  // ---------- Connection ----------
  socket.on('state', (s) => {
    if (s.game) s.game.receivedAt = performance.now(); // turn clock is relative to arrival
    queue.push(s);
    pump();
  });
  socket.on('left', (msg) => {
    exitRoom();
    toast(msg || 'You left the table.', 'error');
  });
  socket.on('disconnect', () => $('#conn').classList.remove('hidden'));
  socket.on('connect', async () => {
    $('#conn').classList.add('hidden');
    const code = store.get('nuno.room');
    if (!code) return;
    const r = await emit('room:join', { code, name: store.get('nuno.name') || 'Player' });
    if (!r.ok) {
      exitRoom();
      if (urlRoom) $('#code').value = '';
      toast(r.error === 'Room not found.' ? 'That table has closed.' : r.error, 'error');
    }
  });

  show('home');
})();
