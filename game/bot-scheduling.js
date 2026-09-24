import { serialize } from './engine.js';

export function botNeedsAction(game, playerId) {
  const state = serialize(game, playerId);
  const me = state.players[state.viewer];
  if (!me || game.winner != null) return false;
  if (me.needDiscard) return true;
  if (state.needMoveRobber || state.stealFrom?.length) return true;
  // The active player must yield while other players resolve mandatory events.
  if (state.eventPending) return false;
  if (state.offer?.targets?.includes(state.viewer)) return true;
  if (state.phase === 'setup') return state.legal?.setupPlayer === state.viewer;
  return state.phase === 'play' && state.viewer === state.current && state.offer?.from !== state.viewer;
}

export function nextBot(game, players) {
  if (!game || game.winner != null) return null;
  return players.find(p => (p.kind === 'bot' || p.botTakeover) && p.gamePlayerId != null && botNeedsAction(game, p.gamePlayerId)) || null;
}
