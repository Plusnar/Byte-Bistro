/**
 * Which control a D-pad press moves to, from on-screen rectangles. Pure (no DOM), so it is
 * unit-tested; `MenuNavigator` feeds it `getBoundingClientRect()` results.
 */
import type { MenuDirection } from "./menuInput";

export interface NavRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const AXES: Readonly<Record<MenuDirection, readonly [number, number]>> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

/**
 * The index in `candidates` the press lands on, or -1 when nothing lies that way.
 *
 * A candidate counts when its centre is ahead of `from`'s centre in that direction.
 * Inside a 60° cone either side of the direction, the nearest wins, with sideways distance
 * weighing double so a press goes straight before it goes diagonal. Outside every cone
 * (a lone button off to the side) the nearest one ahead still wins, so no control is ever
 * unreachable.
 */
export const pickNeighbour = (from: NavRect, candidates: readonly NavRect[], direction: MenuDirection): number => {
  const [ax, ay] = AXES[direction];
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;
  let best = -1;
  let bestScore = Infinity;
  let bestInCone = false;
  candidates.forEach((rect, index) => {
    const dx = rect.left + rect.width / 2 - fx;
    const dy = rect.top + rect.height / 2 - fy;
    const along = dx * ax + dy * ay;
    if (along <= 1) return;
    const across = Math.abs(dx * ay - dy * ax);
    const inCone = across <= along * Math.tan(Math.PI / 3);
    const score = along + across * 2;
    if ((inCone && !bestInCone) || (inCone === bestInCone && score < bestScore)) {
      best = index;
      bestScore = score;
      bestInCone = inCone;
    }
  });
  return best;
};
