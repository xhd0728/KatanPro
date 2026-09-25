// Public-board route evaluation. Roads are useful when they open a legal
// settlement site or advance a continuous longest-road claim, not merely
// because their endpoints touch productive hexes.
const pips = n => n ? 6 - Math.abs(7 - n) : 0;

function roadLength(edgeIds, edgeById, blocked) {
  const adj = new Map();
  for (const id of edgeIds) {
    const edge = edgeById[id];
    if (!edge) continue;
    for (const [a, b] of [[edge.a, edge.b], [edge.b, edge.a]]) {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push([b, id]);
    }
  }
  let best = 0;
  const dfs = (at, used, length) => {
    best = Math.max(best, length);
    for (const [next, id] of adj.get(at) || []) {
      if (used.has(id)) continue;
      if (blocked.has(next)) { best = Math.max(best, length + 1); continue; }
      used.add(id); dfs(next, used, length + 1); used.delete(id);
    }
  };
  for (const at of adj.keys()) if (!blocked.has(at)) dfs(at, new Set(), 0);
  return best;
}

function context(state) {
  const me = state.players[state.viewer];
  if (!me) return null;
  const vertices = Object.fromEntries(state.map.vertices.map(v => [v.id, v]));
  const hexes = Object.fromEntries(state.map.hexes.map(h => [h.id, h]));
  const edges = Object.fromEntries(state.map.edges.map(e => [e.id, e]));
  const adjacent = new Map(state.map.vertices.map(v => [v.id, []]));
  const neighbors = new Map(state.map.vertices.map(v => [v.id, new Set()]));
  for (const edge of state.map.edges) {
    adjacent.get(edge.a).push(edge); adjacent.get(edge.b).push(edge);
    neighbors.get(edge.a).add(edge.b); neighbors.get(edge.b).add(edge.a);
  }
  const occupied = new Set(), blocked = new Set();
  for (const player of state.players) for (const id of [...(player.settleVerts || []), ...(player.cityVerts || [])]) {
    occupied.add(id);
    if (player.id !== me.id) blocked.add(id);
  }
  const busy = new Set(occupied);
  for (const id of occupied) for (const neighbor of neighbors.get(id) || []) busy.add(neighbor);
  const ownRoads = new Set(me.roadEdges || []);
  const network = new Set([...(me.settleVerts || []), ...(me.cityVerts || [])]);
  for (const id of ownRoads) {
    const edge = edges[id];
    if (!edge) continue;
    if (!blocked.has(edge.a)) network.add(edge.a);
    if (!blocked.has(edge.b)) network.add(edge.b);
  }
  const production = Object.create(null);
  for (const [ids, factor] of [[me.settleVerts || [], 1], [me.cityVerts || [], 2]]) for (const id of ids) {
    for (const hid of vertices[id]?.hexes || []) {
      const hex = hexes[hid];
      if (hex?.number) production[hex.resource] = (production[hex.resource] || 0) + pips(hex.number) * factor;
    }
  }
  const sites = new Map();
  for (const vertex of state.map.vertices) {
    if (me.settlements >= 5 || busy.has(vertex.id)) continue;
    const tiles = vertex.hexes.map(id => hexes[id]).filter(h => h?.number);
    const yieldScore = tiles.reduce((sum, h) => sum + pips(h.number) * ((production[h.resource] || 0) < 3 ? 1.2 : 1), 0);
    const diversity = new Set(tiles.map(h => h.resource)).size;
    const score = yieldScore + diversity * 1.5 + (vertex.port ? 2.5 : 0);
    if (score > 0) sites.set(vertex.id, { id: vertex.id, score: Math.round(score * 10) / 10, port: vertex.port || null });
  }
  return { me, vertices, edges, adjacent, blocked, network, ownRoads, sites,
    alreadyReachable: [...sites.keys()].some(id => network.has(id)) };
}

function targetFrom(frontiers, chosenId, ctx) {
  const queue = frontiers.map(id => [id, 0]);
  const seen = new Set(frontiers);
  let best = null;
  for (let head = 0; head < queue.length; head++) {
    const [at, distance] = queue[head];
    const site = ctx.sites.get(at);
    if (site) {
      const value = site.score / (distance + 1.4);
      if (!best || value > best.value || value === best.value && site.id < best.id)
        best = { ...site, remainingRoads: distance, value };
    }
    if (distance >= 3) continue;
    for (const edge of ctx.adjacent.get(at) || []) {
      if (edge.id === chosenId || edge.owner || ctx.ownRoads.has(edge.id)) continue;
      const next = edge.a === at ? edge.b : edge.a;
      if (ctx.blocked.has(next) || ctx.network.has(next) || seen.has(next)) continue;
      seen.add(next); queue.push([next, distance + 1]);
    }
  }
  return best;
}

export function potentialRoadIds(state) {
  const ctx = context(state);
  if (!ctx) return [];
  return state.map.edges.filter(e => !e.owner && !ctx.ownRoads.has(e.id) &&
    (ctx.network.has(e.a) || ctx.network.has(e.b))).map(e => e.id);
}

export function rankRoadChoices(state, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const ctx = context(state);
  if (!ctx) return [];
  const beforeLength = ctx.me.roadLength || roadLength(ctx.ownRoads, ctx.edges, ctx.blocked);
  const otherLength = Math.max(0, ...state.players.filter(p => p.id !== ctx.me.id).map(p => p.roadLength || 0));
  return ids.flatMap(id => {
    const edge = ctx.edges[id];
    if (!edge || edge.owner || ctx.ownRoads.has(id)) return [];
    const frontiers = [edge.a, edge.b].filter(v => !ctx.network.has(v) && !ctx.blocked.has(v));
    const target = targetFrom(frontiers, id, ctx);
    const afterLength = roadLength([...ctx.ownRoads, id], ctx.edges, ctx.blocked);
    const lengthGain = Math.max(0, afterLength - beforeLength);
    const claim = afterLength >= 5 && afterLength > otherLength && state.longest?.holder !== state.viewer;
    const longestProgress = lengthGain > 0 && beforeLength >= 3 && afterLength >= Math.max(4, otherLength - 1);
    const worthwhile = !ctx.alreadyReachable && !!target && target.remainingRoads <= 2 || claim || longestProgress;
    const score = (target ? target.value * 8 : 0) +
      (claim ? 125 : longestProgress ? 20 : 0) - (frontiers.length ? 0 : 20);
    return [{ id, score: Math.round(score * 10) / 10, worthwhile,
      target: target?.id || null, targetScore: target?.score || 0,
      remainingRoads: target?.remainingRoads ?? null,
      longestGain: lengthGain, claimsLongest: claim }];
  }).sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
}

export function roadIntent(state) {
  const best = rankRoadChoices(state, potentialRoadIds(state))[0];
  return best?.worthwhile ? { target: best.target, nextEdge: best.id,
    remainingRoads: best.remainingRoads, claimsLongest: best.claimsLongest } : null;
}
