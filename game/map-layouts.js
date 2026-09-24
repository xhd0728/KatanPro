// Map outlines and fixed sea-port anchors checked against the three playable
// maps at https://game.hullqin.cn/ktd (2026-09-24). Coordinates use axial q/r.
// A port's third value selects its sea hex's coastal side, starting at the left.
export const MAP_LAYOUTS = {
  small: {
    radius: 2, minQ: -2, maxQ: 2, minSum: -2, maxSum: 2,
    ports: [[2,-3,5],[0,-3,4],[-2,-1,3],[-3,1,3],[-3,3,2],[-1,3,1],[1,2,1],[3,0,0],[3,-2,5]],
  },
  medium: {
    radius: 3, minQ: -2, maxQ: 3, minSum: -2, maxSum: 3,
    ports: [[-3,1,3],[-3,2,3],[-3,4,2],[-1,4,1],[1,3,0],[2,2,1],[4,0,0],[4,-3,5],[3,-4,5],[1,-4,4],[-2,-1,3]],
  },
  large: {
    radius: 3, minQ: -3, maxQ: 3, minSum: -3, maxSum: 3,
    ports: [[-4,1,3],[-4,3,2],[-3,4,2],[-1,4,1],[1,3,0],[2,2,1],[4,0,0],[4,-3,5],[3,-4,5],[1,-4,4],[-1,-3,4],[-3,-1,3]],
  },
  epic: {
    radius: 4, minQ: -4, maxQ: 4, minSum: -4, maxSum: 4,
    portCount: 18,
  },
  twin: {
    radius: 3, lobes: [[-3, 0], [3, 0]], portCount: 20,
  },
};

export function layoutCells(layout) {
  const cells = new Map();
  const R = layout.radius;
  if (layout.lobes) {
    for (const [cq, cr] of layout.lobes) for (let q=-R;q<=R;q++) {
      for (let r=Math.max(-R,-q-R);r<=Math.min(R,-q+R);r++) cells.set(`${q+cq},${r+cr}`,[q+cq,r+cr]);
    }
  } else {
    for(let q=layout.minQ;q<=layout.maxQ;q++) for(let r=Math.max(-R,layout.minSum-q);r<=Math.min(R,layout.maxSum-q);r++) cells.set(`${q},${r}`,[q,r]);
  }
  return [...cells.values()].sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
}
