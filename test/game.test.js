'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Game, DECK_SIZE, buildDeck } = require('../src/game');
const { botAction } = require('../src/bot');

const card = (id, color, value) => ({ id: 1000 + id, color, value });

// Puts a game into a known position; unused cards stay in the draw pile.
function rig(game, { hands, top, color, turn = 0, direction = 1 }) {
  const used = [...hands.flat(), top];
  const all = buildDeck().filter((c) => !used.some((u) => u.color === c.color && u.value === c.value && u.id === c.id));
  game.players.forEach((p, i) => {
    p.hand = hands[i];
    p.calledUno = false;
  });
  game.discard = [top];
  game.deck = all.slice(0, DECK_SIZE - used.length);
  game.currentColor = color || top.color;
  game.turn = turn;
  game.direction = direction;
  game.phase = 'play';
  game.pendingDrawn = null;
  game.unoVulnerable = null;
}

test('deck has 108 cards with the official mix', () => {
  const deck = buildDeck();
  assert.strictEqual(deck.length, 108);
  assert.strictEqual(deck.filter((c) => c.value === 'wild4').length, 4);
  assert.strictEqual(deck.filter((c) => c.value === 'wild').length, 4);
  assert.strictEqual(deck.filter((c) => c.color === 'red' && c.value === '0').length, 1);
  assert.strictEqual(deck.filter((c) => c.color === 'red' && c.value === '7').length, 2);
  assert.strictEqual(deck.filter((c) => c.value === 'draw2').length, 8);
});

test('deals 7 cards each and never starts on a Wild Draw Four', () => {
  for (let k = 0; k < 200; k++) {
    const g = new Game(['a', 'b', 'c', 'd']);
    assert.notStrictEqual(g.top().value, 'wild4');
    const drew = g.top().value === 'draw2' ? 2 : 0;
    const left = (g.dealer + 1) % 4;
    g.players.forEach((p, i) => assert.strictEqual(p.hand.length, 7 + (i === left ? drew : 0)));
    assert.strictEqual(g.cardCount(), DECK_SIZE);
  }
});

test('supports up to 8 players with one deck', () => {
  for (let n = 5; n <= 8; n++) {
    const g = new Game(Array.from({ length: n }, (_, i) => `p${i}`));
    const left = (g.dealer + 1) % n;
    const drew = g.top().value === 'draw2' ? 2 : 0;
    g.players.forEach((p, i) => assert.strictEqual(p.hand.length, 7 + (i === left ? drew : 0)));
    assert.strictEqual(g.cardCount(), DECK_SIZE);
  }
  assert.throws(() => new Game(Array.from({ length: 9 }, (_, i) => `p${i}`)));
});

test('must match color, number or symbol', () => {
  const g = new Game(['a', 'b', 'c']);
  rig(g, { hands: [[card(1, 'blue', '3'), card(2, 'red', '7'), card(3, 'green', '5')], [card(4, 'red', '1')], [card(5, 'red', '2')]], top: card(9, 'red', '5') });
  assert.strictEqual(g.playCard(0, 1001).ok, false);
  assert.deepStrictEqual(g.playableIds(0).sort(), [1002, 1003]);
  assert.strictEqual(g.playCard(0, 1003).ok, true);
  assert.strictEqual(g.currentColor, 'green');
  assert.strictEqual(g.turn, 1);
});

test('skip, reverse and draw two', () => {
  const g = new Game(['a', 'b', 'c', 'd']);
  const filler = (i) => [card(100 + i, 'yellow', '1'), card(110 + i, 'yellow', '2')];
  rig(g, { hands: [[card(1, 'red', 'skip'), card(2, 'red', 'reverse'), card(3, 'red', 'draw2')], filler(1), filler(2), filler(3)], top: card(9, 'red', '5') });
  g.playCard(0, 1001);
  assert.strictEqual(g.turn, 2);
  g.turn = 0;
  g.playCard(0, 1002);
  assert.strictEqual(g.direction, -1);
  assert.strictEqual(g.turn, 3);
  g.turn = 0;
  g.players[0].hand.push(card(4, 'red', '9'));
  g.playCard(0, 1003);
  // Player 3 has no +2 to stack, so they take the 2 straight away and are skipped.
  assert.strictEqual(g.players[3].hand.length, 4);
  assert.strictEqual(g.drawStack, 0);
  assert.strictEqual(g.turn, 2);
});

test('reverse acts as skip with two players', () => {
  const g = new Game(['a', 'b']);
  rig(g, { hands: [[card(1, 'red', 'reverse'), card(2, 'red', '1'), card(3, 'red', '2')], [card(4, 'red', '1')]], top: card(9, 'red', '5') });
  g.playCard(0, 1001);
  assert.strictEqual(g.turn, 0);
});

test('drawn playable card may be played or kept', () => {
  const g = new Game(['a', 'b']);
  rig(g, { hands: [[card(1, 'blue', '3'), card(2, 'blue', '4')], [card(4, 'red', '1')]], top: card(9, 'red', '5') });
  g.deck.push(card(5, 'red', '8'));
  g.drawCard(0);
  assert.strictEqual(g.pendingDrawn, 1005);
  assert.strictEqual(g.turn, 0);
  assert.strictEqual(g.playCard(0, 1001).ok, false);
  assert.strictEqual(g.pass(0).ok, true);
  assert.strictEqual(g.turn, 1);
});

test('unplayable drawn card ends the turn', () => {
  const g = new Game(['a', 'b']);
  rig(g, { hands: [[card(1, 'blue', '3'), card(2, 'blue', '4')], [card(4, 'red', '1')]], top: card(9, 'red', '5') });
  g.deck.push(card(5, 'green', '8'));
  g.drawCard(0);
  assert.strictEqual(g.turn, 1);
  assert.strictEqual(g.players[0].hand.length, 3);
});

test('wild draw four can be played any time and starts a stack of 4', () => {
  const g = new Game(['a', 'b', 'c']);
  // Player 0 holds a matching red card and plays the Wild Draw Four anyway — allowed, no challenge.
  rig(g, { hands: [[card(1, 'wild', 'wild4'), card(2, 'red', '3'), card(3, 'blue', '4')], [card(4, 'green', '1'), card(5, 'green', '2')], [card(6, 'green', '3'), card(7, 'green', '4')]], top: card(9, 'red', '5') });
  assert.strictEqual(g.playCard(0, 1001).ok, false, 'a color must be chosen');
  assert.strictEqual(g.playCard(0, 1001, 'blue').ok, true);
  assert.strictEqual(g.currentColor, 'blue');
  // Player 1 has no +4, so there's nothing to ask: they take 4 and are skipped.
  assert.deepStrictEqual(g.events.slice(-4).map((e) => e.type), ['play', 'color', 'stack', 'draw']);
  assert.strictEqual(g.players[1].hand.length, 6);
  assert.strictEqual(g.drawStack, 0);
  assert.strictEqual(g.turn, 2);
});

test('+2 stacks only on +2 and the total grows until someone takes it', () => {
  const g = new Game(['me', 'a', 'b', 'c']);
  rig(g, {
    hands: [
      [card(1, 'red', 'draw2'), card(2, 'red', '1')],
      [card(3, 'blue', 'draw2'), card(4, 'blue', '1')],
      [card(5, 'wild', 'wild4'), card(6, 'yellow', '7'), card(7, 'green', 'draw2')],
      [card(8, 'green', '5'), card(9, 'yellow', '3')],
    ],
    top: card(20, 'red', '5'),
  });
  g.playCard(0, 1001); // +2
  assert.strictEqual(g.drawStack, 2);
  assert.strictEqual(g.playCard(1, 1004).ok, false, 'must stack or take');
  assert.deepStrictEqual(g.playableIds(1), [1003]);
  g.playCard(1, 1003); // blue +2 on red +2 = 4
  assert.strictEqual(g.drawStack, 4);
  assert.deepStrictEqual(g.playableIds(2), [1007], 'only a +2 (any color) — the +4 cannot join a +2 stack');
  assert.strictEqual(g.playCard(2, 1005, 'yellow').ok, false);
  g.playCard(2, 1007); // green +2 = 6; player 3 has no +2 and takes all 6 automatically
  assert.strictEqual(g.players[3].hand.length, 8);
  assert.strictEqual(g.drawStack, 0);
  assert.strictEqual(g.turn, 0, 'the player who took the stack is skipped');
  assert.strictEqual(g.currentColor, 'green');
});

test('+4 stacks only on +4, and a player may take instead of stacking', () => {
  const g = new Game(['me', 'a', 'b']);
  rig(g, {
    hands: [
      [card(1, 'wild', 'wild4'), card(2, 'red', '1')],
      [card(3, 'green', 'draw2'), card(4, 'wild', 'wild4'), card(5, 'blue', '1')],
      [card(6, 'wild', 'wild4'), card(7, 'red', '9')],
    ],
    top: card(20, 'red', '5'),
  });
  g.playCard(0, 1001, 'blue');
  assert.deepStrictEqual(g.playableIds(1), [1004], 'a +2 cannot join a +4 stack');
  assert.strictEqual(g.playCard(1, 1003).ok, false);
  g.playCard(1, 1004, 'green'); // +4 on +4 = 8
  assert.strictEqual(g.drawStack, 8);
  assert.strictEqual(g.currentColor, 'green');
  // Player b holds a +4 but chooses to take the 8.
  assert.deepStrictEqual(g.playableIds(2), [1006]);
  g.drawCard(2);
  assert.strictEqual(g.players[2].hand.length, 10);
  assert.strictEqual(g.turn, 0);
  assert.strictEqual(g.stackType, null);
  assert.strictEqual(g.events[g.events.length - 1].reason, 'stack');
});

test('running out of time draws one card and passes, even if it is playable', () => {
  const g = new Game(['a', 'b']);
  rig(g, { hands: [[card(1, 'blue', '3'), card(2, 'blue', '4')], [card(4, 'red', '1')]], top: card(9, 'red', '5') });
  g.deck.push(card(5, 'red', '8')); // playable, but a timeout keeps it
  const before = g.turnId;
  assert.strictEqual(g.timeout(0).ok, true);
  assert.strictEqual(g.players[0].hand.length, 3);
  assert.strictEqual(g.pendingDrawn, null);
  assert.strictEqual(g.turn, 1);
  assert.ok(g.turnId > before);
  assert.ok(g.events.some((e) => e.type === 'timeout' && e.player === 0));
  assert.strictEqual(g.timeout(0).ok, false, 'only the current player can time out');
});

test('running out of time after drawing keeps the card; facing a stack takes it', () => {
  let g = new Game(['a', 'b']);
  rig(g, { hands: [[card(1, 'blue', '3'), card(2, 'blue', '4')], [card(4, 'red', '1')]], top: card(9, 'red', '5') });
  g.deck.push(card(5, 'red', '8'));
  g.drawCard(0);
  g.timeout(0);
  assert.strictEqual(g.players[0].hand.length, 3, 'no second card');
  assert.strictEqual(g.turn, 1);

  g = new Game(['a', 'b', 'c']);
  rig(g, { hands: [[card(1, 'red', 'draw2'), card(2, 'red', '1')], [card(3, 'blue', 'draw2'), card(4, 'blue', '1')], [card(5, 'red', '3'), card(6, 'red', '4')]], top: card(9, 'red', '5') });
  g.playCard(0, 1001);
  assert.strictEqual(g.turn, 1, 'player 1 can stack, so they get to choose');
  g.timeout(1);
  assert.strictEqual(g.players[1].hand.length, 4, 'took the stack of 2');
  assert.strictEqual(g.turn, 2);
});

test('running out of time on a starting Wild picks a color', () => {
  const g = new Game(['a', 'b']);
  g.phase = 'chooseColor';
  g.currentColor = null;
  const t = g.turn;
  assert.strictEqual(g.timeout(t).ok, true);
  assert.strictEqual(g.phase, 'play');
  assert.ok(['red', 'yellow', 'green', 'blue'].includes(g.currentColor));
  assert.strictEqual(g.turn, t, 'they still take their turn');
});

test('UNO can only be called when a card can be played down to one', () => {
  const g = new Game(['a', 'b']);
  rig(g, { hands: [[card(1, 'blue', '3'), card(2, 'green', '4')], [card(4, 'red', '1'), card(5, 'red', '2')]], top: card(9, 'red', '5') });
  assert.strictEqual(g.callUno(0).ok, false, 'two cards but nothing playable');
  assert.strictEqual(g.callUno(1).ok, false, 'not their turn');
  g.players[0].hand.push(card(3, 'red', '7'));
  assert.strictEqual(g.callUno(0).ok, false, 'three cards');
  g.players[0].hand = [card(1, 'blue', '3'), card(3, 'red', '7')];
  assert.strictEqual(g.callUno(0).ok, true);
});

test('forgetting UNO can be caught until the next player acts', () => {
  const g = new Game(['a', 'b', 'c']);
  rig(g, { hands: [[card(1, 'red', '1'), card(2, 'red', '2')], [card(3, 'red', '3'), card(4, 'red', '4')], [card(5, 'red', '5'), card(6, 'red', '6')]], top: card(9, 'red', '5') });
  g.playCard(0, 1001);
  assert.strictEqual(g.unoVulnerable, 0);
  assert.strictEqual(g.catchUno(2, 0).ok, true);
  assert.strictEqual(g.players[0].hand.length, 3);

  rig(g, { hands: [[card(1, 'red', '1'), card(2, 'red', '2')], [card(3, 'red', '3'), card(4, 'red', '4')], [card(5, 'red', '5'), card(6, 'red', '6')]], top: card(9, 'red', '5') });
  g.playCard(0, 1001);
  g.playCard(1, 1003); // next player began their turn
  assert.strictEqual(g.catchUno(2, 0).ok, false);

  rig(g, { hands: [[card(1, 'red', '1'), card(2, 'red', '2')], [card(3, 'red', '3'), card(4, 'red', '4')], [card(5, 'red', '5'), card(6, 'red', '6')]], top: card(9, 'red', '5') });
  assert.strictEqual(g.callUno(0).ok, true);
  g.playCard(0, 1001);
  assert.strictEqual(g.unoVulnerable, null);
});

test('UNO can’t be called after playing down to one card', () => {
  const g = new Game(['a', 'b', 'c']);
  rig(g, { hands: [[card(1, 'red', '1'), card(2, 'red', '2')], [card(3, 'red', '3'), card(4, 'red', '4')], [card(5, 'red', '5'), card(6, 'red', '6')]], top: card(9, 'red', '5') });
  g.playCard(0, 1001);
  assert.strictEqual(g.unoVulnerable, 0);
  assert.strictEqual(g.callUno(0).ok, false, 'too late');
  assert.strictEqual(g.unoVulnerable, 0, 'still catchable');
  assert.strictEqual(g.catchUno(1, 0).ok, true);
});

test('a 7 lets the player pick whose hand to swap with, on a fresh clock', () => {
  const g = new Game(['a', 'b', 'c']);
  rig(g, { hands: [[card(1, 'red', '7'), card(2, 'blue', '1'), card(3, 'blue', '2')], [card(4, 'green', '3')], [card(5, 'yellow', '4'), card(6, 'yellow', '5')]], top: card(9, 'red', '5') });
  g.players[1].calledUno = true;
  const before = g.turnId;
  assert.strictEqual(g.playCard(0, 1001).ok, true);
  assert.strictEqual(g.phase, 'chooseSwap');
  assert.strictEqual(g.turn, 0);
  assert.ok(g.turnId > before, 'the turn clock restarts');
  assert.deepStrictEqual(g.playableIds(0), []);
  assert.strictEqual(g.drawCard(0).ok, false);
  assert.strictEqual(g.swapHands(1, 2).ok, false, 'only the player of the 7');
  assert.strictEqual(g.swapHands(0, 0).ok, false, 'not with yourself');
  assert.strictEqual(g.swapHands(0, 1).ok, true);
  assert.deepStrictEqual(g.players[0].hand.map((c) => c.id), [1004]);
  assert.deepStrictEqual(g.players[1].hand.map((c) => c.id), [1002, 1003]);
  assert.strictEqual(g.players[0].calledUno, true, 'a one-card hand received counts as UNO');
  assert.strictEqual(g.players[1].calledUno, false);
  assert.strictEqual(g.phase, 'play');
  assert.strictEqual(g.turn, 1);
  const e = g.events[g.events.length - 1];
  assert.deepStrictEqual([e.type, e.player, e.target, e.before, e.after], ['swap', 0, 1, [2, 1, 2], [1, 2, 2]]);
});

test('running out of time on a 7 swaps with a random opponent', () => {
  const g = new Game(['a', 'b', 'c', 'd']);
  rig(g, { hands: [[card(1, 'red', '7'), card(2, 'blue', '1')], [card(3, 'green', '3')], [card(4, 'green', '4'), card(5, 'green', '5')], [card(6, 'green', '6'), card(7, 'green', '8'), card(8, 'green', '9')]], top: card(9, 'red', '5') });
  g.playCard(0, 1001);
  assert.strictEqual(g.timeout(0).ok, true);
  const e = g.events[g.events.length - 1];
  assert.strictEqual(e.type, 'swap');
  assert.ok([1, 2, 3].includes(e.target));
  assert.deepStrictEqual(g.players[e.target].hand.map((c) => c.id), [1002]);
  assert.strictEqual(g.turn, 1);
});

test('a 7 with two players swaps straight away; a last-card 7 just wins', () => {
  let g = new Game(['a', 'b']);
  rig(g, { hands: [[card(1, 'red', '7'), card(2, 'blue', '1'), card(3, 'blue', '2')], [card(4, 'green', '3')]], top: card(9, 'red', '5') });
  g.playCard(0, 1001);
  assert.strictEqual(g.phase, 'play');
  assert.deepStrictEqual(g.players[0].hand.map((c) => c.id), [1004]);
  assert.strictEqual(g.turn, 1);

  g = new Game(['a', 'b', 'c']);
  rig(g, { hands: [[card(1, 'red', '7')], [card(4, 'green', '3')], [card(5, 'green', '4')]], top: card(9, 'red', '5') });
  g.playCard(0, 1001);
  assert.strictEqual(g.phase, 'gameOver');
  assert.strictEqual(g.result.winner, 0);
});

test('a 0 passes every hand along in the direction of play', () => {
  const hands = () => [
    [card(1, 'red', '0'), card(2, 'blue', '1'), card(3, 'blue', '2')],
    [card(4, 'green', '3')],
    [card(5, 'yellow', '4'), card(6, 'yellow', '5')],
    [card(7, 'green', '6'), card(8, 'green', '8'), card(10, 'green', '9'), card(11, 'green', '1')],
  ];
  const ids = (g) => g.players.map((p) => p.hand.map((c) => c.id));

  let g = new Game(['a', 'b', 'c', 'd']);
  rig(g, { hands: hands(), top: card(9, 'red', '5') });
  g.playCard(0, 1001);
  // Clockwise: seat 0's hand goes to seat 1, seat 1's to seat 2 and so on.
  assert.deepStrictEqual(ids(g), [[1007, 1008, 1010, 1011], [1002, 1003], [1004], [1005, 1006]]);
  assert.strictEqual(g.players[2].calledUno, true);
  assert.strictEqual(g.turn, 1);
  assert.deepStrictEqual(g.events[g.events.length - 1].after, [4, 2, 1, 2]);

  g = new Game(['a', 'b', 'c', 'd']);
  rig(g, { hands: hands(), top: card(9, 'red', '5'), direction: -1 });
  g.playCard(0, 1001);
  // Counter-clockwise: seat 0's hand goes to seat 3, seat 1's to seat 0.
  assert.deepStrictEqual(ids(g), [[1004], [1005, 1006], [1007, 1008, 1010, 1011], [1002, 1003]]);
  assert.strictEqual(g.turn, 3);
});

test('a played Wild keeps its chosen color until it is reshuffled', () => {
  const g = new Game(['a', 'b']);
  rig(g, { hands: [[card(1, 'wild', 'wild'), card(2, 'blue', '1')], [card(4, 'green', '3'), card(5, 'green', '4')]], top: card(9, 'red', '5') });
  g.playCard(0, 1001, 'green');
  assert.strictEqual(g.top().chosen, 'green');
  assert.strictEqual(g.events.find((e) => e.type === 'color' && e.cardId === 1001).color, 'green');
  g.playCard(1, 1004);
  g.deck = [];
  g.drawCard(0);
  assert.ok([...g.deck, ...g.players.flatMap((p) => p.hand)].every((c) => c.chosen === undefined));

  const s = new Game(['a', 'b']);
  s.phase = 'chooseColor';
  s.discard.push({ id: 999, color: 'wild', value: 'wild' });
  s.chooseColor(s.turn, 'blue');
  assert.strictEqual(s.top().chosen, 'blue', 'a starting Wild is painted too');
});

test('first player to empty their hand wins and the game ends', () => {
  const g = new Game(['a', 'b', 'c']);
  rig(g, { hands: [[card(1, 'red', 'draw2')], [card(2, 'blue', '9'), card(3, 'wild', 'wild')], [card(4, 'green', 'skip')]], top: card(9, 'red', '5') });
  g.players[0].calledUno = true;
  g.playCard(0, 1001);
  assert.strictEqual(g.phase, 'gameOver');
  assert.strictEqual(g.result.winner, 0);
  assert.strictEqual(g.players[1].hand.length, 2, 'no penalty draw after the game ends');
  assert.strictEqual(g.events[g.events.length - 1].type, 'win');
  assert.strictEqual(g.drawCard(1).ok, false);
});

test('simulated bot games always finish with every card accounted for', () => {
  for (let k = 0; k < 300; k++) {
    const n = 2 + (k % 7); // 2 to 8 players
    const g = new Game(Array.from({ length: n }, (_, i) => `p${i}`));
    let steps = 0;
    while (g.phase !== 'gameOver') {
      assert.ok(++steps < 50_000, 'game did not finish');
      if (g.unoVulnerable !== null && Math.random() < 0.5) {
        assert.ok(g.catchUno((g.unoVulnerable + 1) % n, g.unoVulnerable).ok);
      }
      const action = botAction(g, g.turn);
      assert.ok(action, `no action in phase ${g.phase}`);
      let r;
      if (action.type === 'play') {
        if (action.uno) g.callUno(g.turn);
        r = g.playCard(g.turn, action.cardId, action.color);
      } else if (action.type === 'draw') r = g.drawCard(g.turn);
      else if (action.type === 'pass') r = g.pass(g.turn);
      else if (action.type === 'chooseColor') r = g.chooseColor(g.turn, action.color);
      else if (action.type === 'swap') r = g.swapHands(g.turn, action.target);
      assert.ok(r.ok, r.error);
      assert.strictEqual(g.cardCount(), DECK_SIZE);
      const ids = new Set([...g.deck, ...g.discard, ...g.players.flatMap((p) => p.hand)].map((c) => c.id));
      assert.strictEqual(ids.size, DECK_SIZE);
    }
    assert.strictEqual(g.players[g.result.winner].hand.length, 0);
  }
});
