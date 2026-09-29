'use strict';

// Authoritative UNO rules engine. One hand per game: the first player to empty
// their hand wins. Players are addressed by seat index; seat order is clockwise.
// Plays with the 7-0 rule: a 7 swaps hands with a chosen player, a 0 passes every
// hand along in the direction of play.

const crypto = require('crypto');

const COLORS = ['red', 'yellow', 'green', 'blue'];
const ACTION_VALUES = ['skip', 'reverse', 'draw2'];
const HAND_SIZE = 7;
const MAX_PLAYERS = 8;
const DECK_SIZE = 108;

const VALUE_NAMES = {
  skip: 'Skip',
  reverse: 'Reverse',
  draw2: 'Draw Two',
  wild: 'Wild',
  wild4: 'Wild Draw Four',
};

// 108 cards: per color one 0, two each of 1-9, Skip, Reverse, Draw Two;
// plus four Wild and four Wild Draw Four.
function buildDeck() {
  const deck = [];
  let id = 0;
  for (const color of COLORS) {
    deck.push({ id: id++, color, value: '0' });
    for (let n = 1; n <= 9; n++) {
      deck.push({ id: id++, color, value: String(n) });
      deck.push({ id: id++, color, value: String(n) });
    }
    for (const value of ACTION_VALUES) {
      deck.push({ id: id++, color, value });
      deck.push({ id: id++, color, value });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ id: id++, color: 'wild', value: 'wild' });
    deck.push({ id: id++, color: 'wild', value: 'wild4' });
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function describe(card) {
  if (card.color === 'wild') return VALUE_NAMES[card.value];
  const color = card.color[0].toUpperCase() + card.color.slice(1);
  return `${color} ${VALUE_NAMES[card.value] || card.value}`;
}

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error) => ({ ok: false, error });

class Game {
  constructor(names) {
    if (names.length < 2 || names.length > MAX_PLAYERS) throw new Error(`UNO needs 2-${MAX_PLAYERS} players`);
    this.id = crypto.randomUUID();
    this.players = names.map((name) => ({ name, hand: [], calledUno: false }));
    // Officially everyone draws a card and the highest deals; a random dealer is equivalent.
    this.dealer = crypto.randomInt(names.length);
    this.log = [];
    this.logSeq = 0;
    // Structured events drive the client's animations.
    this.events = [];
    this.eventSeq = 0;
    this.turnId = 0;
    this.deal();
  }

  // Every hand-off of the turn gets a new id, so the turn timer restarts even when the
  // same player goes again (e.g. Skip with two players).
  get turn() {
    return this._turn;
  }

  set turn(i) {
    this._turn = i;
    this.turnId++;
  }

  get n() {
    return this.players.length;
  }

  top() {
    return this.discard[this.discard.length - 1];
  }

  next(i, steps = 1) {
    return (((i + this.direction * steps) % this.n) + this.n) % this.n;
  }

  name(i) {
    return this.players[i].name;
  }

  addLog(text, kind = 'info') {
    this.log.push({ id: ++this.logSeq, text, kind });
    if (this.log.length > 80) this.log.shift();
  }

  event(type, data = {}) {
    this.events.push({ id: ++this.eventSeq, type, ...data });
    if (this.events.length > 60) this.events.shift();
  }

  deal() {
    this.deck = shuffle(buildDeck());
    this.discard = [];
    this.direction = 1;
    this.pendingDrawn = null; // id of a just-drawn playable card
    this.drawStack = 0; // cards owed by the current player from stacked +2s or +4s
    this.stackType = null; // 'draw2' or 'wild4' — a stack only takes more of the same card
    this.unoVulnerable = null; // seat that is down to one card without calling UNO
    this.result = null;

    const left = (this.dealer + 1) % this.n;
    for (let k = 0; k < HAND_SIZE; k++) {
      for (let s = 0; s < this.n; s++) this.players[(left + s) % this.n].hand.push(this.deck.pop());
    }
    this.addLog(`${this.name(this.dealer)} deals.`, 'round');
    this.event('deal', { dealer: this.dealer });

    // A Wild Draw Four can't start the discard pile: return it and flip again.
    let first = this.deck.pop();
    while (first.value === 'wild4') {
      this.addLog('Wild Draw Four flipped as the first card — reshuffled.');
      this.deck.push(first);
      shuffle(this.deck);
      first = this.deck.pop();
    }
    this.discard.push(first);
    this.currentColor = first.color;
    this.turn = left;
    this.phase = 'play';
    this.addLog(`First card: ${describe(first)}.`);
    this.event('flip', { card: first });

    switch (first.value) {
      case 'wild':
        this.currentColor = null;
        this.phase = 'chooseColor';
        this.addLog(`${this.name(left)} chooses the starting color.`);
        break;
      case 'skip':
        this.addLog(`${this.name(left)} is skipped.`);
        this.event('skip', { player: left });
        this.turn = this.next(left);
        break;
      case 'reverse':
        this.direction = -1;
        this.turn = this.dealer;
        this.addLog(`Play goes the other way — ${this.name(this.dealer)} starts.`);
        this.event('reverse', { direction: -1 });
        break;
      case 'draw2':
        this.drawCards(left, 2, 'draw2');
        this.addLog(`${this.name(left)} draws 2 and is skipped.`);
        this.turn = this.next(left);
        break;
    }
  }

  drawOne() {
    if (!this.deck.length) {
      if (this.discard.length <= 1) return null;
      const top = this.discard.pop();
      // Wilds going back into the deck are black again.
      for (const c of this.discard) delete c.chosen;
      this.deck = shuffle(this.discard);
      this.discard = [top];
      this.addLog('Draw pile empty — discard pile reshuffled.');
      this.event('reshuffle');
    }
    return this.deck.pop();
  }

  drawCards(i, count, reason = 'draw') {
    const p = this.players[i];
    const drawn = [];
    for (let k = 0; k < count; k++) {
      const card = this.drawOne();
      if (!card) break;
      p.hand.push(card);
      drawn.push(card);
    }
    if (drawn.length) this.event('draw', { player: i, count: drawn.length, reason });
    if (p.hand.length > 1) {
      p.calledUno = false;
      if (this.unoVulnerable === i) this.unoVulnerable = null;
    }
    return drawn;
  }

  stackLabel() {
    return this.stackType === 'wild4' ? '+4' : '+2';
  }

  isPlayable(card) {
    // Facing a stack, only the same kind of card can be added: +2 on +2, +4 on +4.
    if (this.drawStack > 0) return card.value === this.stackType;
    if (card.color === 'wild') return true;
    return card.color === this.currentColor || card.value === this.top().value;
  }

  playableIds(i) {
    if (this.phase !== 'play' || this.turn !== i) return [];
    const hand = this.players[i].hand;
    if (this.pendingDrawn !== null) {
      return hand.some((c) => c.id === this.pendingDrawn) ? [this.pendingDrawn] : [];
    }
    return hand.filter((c) => this.isPlayable(c)).map((c) => c.id);
  }

  // Once the next player starts their turn, the window to catch a missed UNO closes.
  beginAction(i) {
    if (this.unoVulnerable !== null && this.unoVulnerable !== i) this.unoVulnerable = null;
  }

  playCard(i, cardId, color) {
    if (this.phase !== 'play') return fail('You can’t play a card right now.');
    if (this.turn !== i) return fail('It’s not your turn.');
    const p = this.players[i];
    const idx = p.hand.findIndex((c) => c.id === cardId);
    if (idx === -1) return fail('That card isn’t in your hand.');
    const card = p.hand[idx];
    if (this.pendingDrawn !== null && this.pendingDrawn !== cardId) {
      return fail('You may only play the card you just drew.');
    }
    if (!this.isPlayable(card)) {
      if (this.drawStack > 0) return fail(`Only a ${this.stackLabel()} can be stacked — or take the ${this.drawStack} cards.`);
      return fail('That card doesn’t match the color, number or symbol.');
    }
    if (card.color === 'wild' && !COLORS.includes(color)) return fail('Choose a color for your Wild.');

    this.beginAction(i);
    p.hand.splice(idx, 1);
    // A Wild on the pile takes on the chosen color.
    if (card.color === 'wild') card.chosen = color;
    this.discard.push(card);
    this.pendingDrawn = null;
    this.currentColor = card.color === 'wild' ? color : card.color;
    this.addLog(
      `${p.name} plays ${describe(card)}${card.color === 'wild' ? ` and picks ${color}` : ''}.`,
      'play'
    );
    this.event('play', { player: i, card });
    if (card.color === 'wild') this.event('color', { player: i, color, cardId: card.id });

    if (p.hand.length === 0) return this.finish(i);

    if (p.hand.length === 1) {
      if (!p.calledUno) this.unoVulnerable = i;
    } else {
      p.calledUno = false;
    }

    const target = this.next(i);
    switch (card.value) {
      case 'skip':
        this.addLog(`${this.name(target)} is skipped.`);
        this.event('skip', { player: target });
        this.turn = this.next(i, 2);
        break;
      case 'reverse':
        if (this.n === 2) {
          // With two players Reverse acts like Skip.
          this.addLog(`${this.name(target)} is skipped.`);
          this.event('reverse', { direction: this.direction });
          this.turn = i;
        } else {
          this.direction *= -1;
          this.addLog('Direction reversed!', 'alert');
          this.event('reverse', { direction: this.direction });
          this.turn = this.next(i);
        }
        break;
      case 'draw2':
      case 'wild4':
        // The penalty passes along: the next player adds the same card or takes the total.
        // Someone with nothing to stack takes it straight away — there's no choice to make.
        this.drawStack += card.value === 'draw2' ? 2 : 4;
        this.stackType = card.value;
        this.event('stack', { player: i, target, total: this.drawStack });
        this.turn = target;
        if (this.players[target].hand.some((c) => c.value === this.stackType)) {
          this.addLog(`${this.name(target)} can stack or take ${this.drawStack}.`, 'alert');
        } else {
          this.takeStack(target, true);
        }
        break;
      case '7':
        // The player picks whose hand to take; the fresh turn id restarts their clock.
        // With two players there's only one choice, so the swap happens at once.
        this.phase = 'chooseSwap';
        this.turn = i;
        if (this.n === 2) return this.swapHands(i, target);
        this.addLog(`${p.name} picks a player to swap hands with.`, 'alert');
        break;
      case '0':
        this.rotateHands();
        this.turn = target;
        break;
      default:
        this.turn = target;
    }
    return ok();
  }

  counts() {
    return this.players.map((p) => p.hand.length);
  }

  // After hands change owners nobody can be caught for a hand they were just given:
  // whoever now holds one card counts as having called UNO.
  afterHandsMoved() {
    this.unoVulnerable = null;
    for (const p of this.players) p.calledUno = p.hand.length === 1;
  }

  swapHands(i, target) {
    if (this.phase !== 'chooseSwap' || this.turn !== i) return fail('You can’t swap hands now.');
    if (!Number.isInteger(target) || target === i || !this.players[target]) return fail('Pick another player to swap with.');
    this.beginAction(i);
    const before = this.counts();
    const a = this.players[i];
    const b = this.players[target];
    [a.hand, b.hand] = [b.hand, a.hand];
    this.afterHandsMoved();
    this.addLog(`${a.name} swaps hands with ${b.name}!`, 'alert');
    this.event('swap', { player: i, target, before, after: this.counts() });
    this.phase = 'play';
    this.turn = this.next(i);
    return ok();
  }

  // Every hand moves one seat along in the current direction of play.
  rotateHands() {
    const before = this.counts();
    const hands = this.players.map((p) => p.hand);
    this.players.forEach((p, s) => {
      p.hand = hands[this.next(s, -1)];
    });
    this.afterHandsMoved();
    this.addLog(`Everyone passes their hand ${this.direction === 1 ? 'clockwise' : 'counter-clockwise'}!`, 'alert');
    this.event('rotate', { direction: this.direction, before, after: this.counts() });
  }

  drawCard(i) {
    if (this.phase !== 'play') return fail('You can’t draw right now.');
    if (this.turn !== i) return fail('It’s not your turn.');
    if (this.pendingDrawn !== null) return fail('You already drew — play that card or pass.');
    this.beginAction(i);
    if (this.drawStack > 0) {
      this.takeStack(i, false);
      return ok();
    }
    const [card] = this.drawCards(i, 1);
    if (!card) {
      this.addLog(`${this.name(i)} can’t draw — no cards left. Turn passes.`);
      this.turn = this.next(i);
      return ok();
    }
    if (this.isPlayable(card)) {
      this.pendingDrawn = card.id;
      this.addLog(`${this.name(i)} draws a card.`);
    } else {
      this.addLog(`${this.name(i)} draws a card and passes.`);
      this.turn = this.next(i);
    }
    return ok({ card });
  }

  // Draws the whole stack and loses the turn.
  takeStack(i, forced) {
    const total = this.drawStack;
    this.drawStack = 0;
    this.stackType = null;
    this.drawCards(i, total, 'stack');
    this.addLog(`${this.name(i)} ${forced ? 'can’t stack and takes' : 'takes'} ${total} cards and is skipped.`);
    this.turn = this.next(i);
  }

  // The turn timer ran out: take a stack if one is waiting, otherwise draw one card
  // (kept even if playable) and move on. A starting Wild gets the player's best color,
  // and a pending 7 swaps with a random opponent.
  timeout(i) {
    if (this.phase === 'gameOver' || this.turn !== i) return fail('It’s not their turn.');
    this.addLog(`${this.name(i)} ran out of time.`, 'alert');
    this.event('timeout', { player: i });
    if (this.phase === 'chooseColor') return this.chooseColor(i, this.favoriteColor(i));
    if (this.phase === 'chooseSwap') {
      const others = this.players.map((_, k) => k).filter((k) => k !== i);
      return this.swapHands(i, others[crypto.randomInt(others.length)]);
    }
    if (this.drawStack > 0) return this.drawCard(i);
    if (this.pendingDrawn === null) {
      const r = this.drawCard(i);
      if (!r.ok || this.pendingDrawn === null) return r;
    }
    return this.pass(i);
  }

  favoriteColor(i) {
    const counts = COLORS.map((color) => this.players[i].hand.filter((c) => c.color === color).length);
    const max = Math.max(...counts);
    const best = COLORS.filter((_, k) => counts[k] === max);
    return best[crypto.randomInt(best.length)];
  }

  pass(i) {
    if (this.phase !== 'play' || this.turn !== i) return fail('It’s not your turn.');
    if (this.pendingDrawn === null) return fail('You must play or draw before passing.');
    this.pendingDrawn = null;
    this.addLog(`${this.name(i)} keeps the card and passes.`);
    this.turn = this.next(i);
    return ok();
  }

  chooseColor(i, color) {
    if (this.phase !== 'chooseColor' || this.turn !== i) return fail('You can’t choose a color now.');
    if (!COLORS.includes(color)) return fail('Unknown color.');
    this.beginAction(i);
    this.currentColor = color;
    this.top().chosen = color;
    this.phase = 'play';
    this.addLog(`${this.name(i)} picks ${color}.`);
    this.event('color', { player: i, color, cardId: this.top().id });
    return ok();
  }

  callUno(i) {
    const p = this.players[i];
    if (this.phase === 'gameOver') return fail('The game is over.');
    // Only before playing: two cards, on your turn, one of them playable. Once you've played
    // down to one card without calling it, it's too late — you can only hope nobody catches you.
    if (!(p.hand.length === 2 && this.turn === i && !p.calledUno && this.playableIds(i).length > 0)) {
      return fail('You can only call UNO before playing your second-to-last card.');
    }
    p.calledUno = true;
    this.addLog(`${p.name} yells UNO!`, 'uno');
    this.event('uno', { player: i });
    return ok();
  }

  catchUno(catcher, target) {
    if (catcher === target) return fail('You can’t catch yourself.');
    if (this.unoVulnerable !== target || this.players[target].hand.length !== 1) {
      return fail('Too late — nobody to catch.');
    }
    this.unoVulnerable = null;
    this.addLog(`${this.name(catcher)} caught ${this.name(target)} not saying UNO! ${this.name(target)} draws 2.`, 'alert');
    this.event('catch', { by: catcher, player: target });
    this.drawCards(target, 2, 'catch');
    return ok();
  }

  finish(winner) {
    this.phase = 'gameOver';
    this.pendingDrawn = null;
    this.drawStack = 0;
    this.stackType = null;
    this.unoVulnerable = null;
    this.result = {
      winner,
      hands: this.players.map((p) => ({ name: p.name, cards: p.hand.slice() })),
    };
    this.addLog(`${this.name(winner)} played their last card and wins!`, 'round');
    this.event('win', { player: winner });
    return ok();
  }

  cardCount() {
    return this.deck.length + this.discard.length + this.players.reduce((s, p) => s + p.hand.length, 0);
  }

  view(i) {
    const me = this.players[i];
    return {
      id: this.id,
      phase: this.phase,
      turn: this.turn,
      turnId: this.turnId,
      direction: this.direction,
      dealer: this.dealer,
      currentColor: this.currentColor,
      top: this.top(),
      discardTail: this.discard.slice(-5),
      deckCount: this.deck.length,
      players: this.players.map((p) => ({
        name: p.name,
        count: p.hand.length,
        saidUno: p.calledUno && p.hand.length === 1,
      })),
      you: i,
      hand: me ? me.hand : [],
      playable: this.playableIds(i),
      pendingDrawn: this.pendingDrawn,
      drawStack: this.drawStack,
      stackType: this.stackType,
      calledUno: me ? me.calledUno : false,
      unoVulnerable: this.unoVulnerable,
      log: this.log.slice(-40),
      events: this.events.slice(-40),
      result: this.result,
    };
  }
}

module.exports = { Game, COLORS, DECK_SIZE, MAX_PLAYERS, describe, buildDeck };
