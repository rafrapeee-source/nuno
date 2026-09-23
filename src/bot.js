'use strict';

// Simple computer player. Returns the action a seat should take, or null.

const { COLORS } = require('./game');

function bestColor(hand) {
  const counts = Object.fromEntries(COLORS.map((c) => [c, 0]));
  for (const c of hand) if (c.color !== 'wild') counts[c.color]++;
  const max = Math.max(...Object.values(counts));
  const best = COLORS.filter((c) => counts[c] === max);
  return best[Math.floor(Math.random() * best.length)];
}

function rank(card, nextPlayerCards) {
  // Hold wilds for later; get rid of action cards when the next player is close to winning.
  if (card.value === 'wild4') return 0;
  if (card.value === 'wild') return 1;
  if (['skip', 'reverse', 'draw2'].includes(card.value)) return nextPlayerCards <= 2 ? 30 : 12;
  return 2 + Number(card.value);
}

function botAction(game, i) {
  const hand = game.players[i].hand;

  if (game.phase === 'chooseColor' && game.turn === i) {
    return { type: 'chooseColor', color: bestColor(hand) };
  }
  if (game.phase !== 'play' || game.turn !== i) return null;

  const playable = game.playableIds(i).map((id) => hand.find((c) => c.id === id));
  if (!playable.length) return game.pendingDrawn !== null ? { type: 'pass' } : { type: 'draw' };

  const nextCards = game.players[game.next(i)].hand.length;
  playable.sort((a, b) => rank(b, nextCards) - rank(a, nextCards));
  const card = playable[0];
  const rest = hand.filter((c) => c.id !== card.id);
  return {
    type: 'play',
    cardId: card.id,
    color: card.color === 'wild' ? bestColor(rest) : undefined,
    // Bots occasionally forget to yell UNO, so humans can catch them.
    uno: hand.length === 2 && Math.random() < 0.85,
  };
}

module.exports = { botAction, bestColor };
