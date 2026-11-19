/** Deterministic loop used by the bus and the road geometry. */
export interface MapPoint { readonly x: number; readonly z: number; }
export const MAP_STOPS: readonly MapPoint[] = [
  { x: -2.2, z: -1.65 }, { x: 4.1, z: -3 }, { x: 4.1, z: 3 }, { x: -4.1, z: 3 },
];
export const MAP_CONTROLS: readonly MapPoint[] = [
  { x: .4, z: -2.1 }, { x: 4.7, z: 0 }, { x: 0, z: 2.35 }, { x: -3.15, z: .3 },
];
/** Props are kept clear of the bus envelope, not only of the center line. */
export const MAP_BUSHES: readonly MapPoint[] = [
  {x:-5.8,z:-1.1}, {x:1.5,z:-.9}, {x:5.8,z:-.9},
  {x:-5.6,z:1.1}, {x:-1.5,z:1}, {x:1.5,z:1}, {x:5.8,z:1.1},
];
export const MAP_LAMPS: readonly MapPoint[] = [
  {x:-5.3,z:-1.6}, {x:-1.5,z:.1}, {x:2.6,z:-1.7}, {x:5.3,z:-1.6},
  {x:-5.3,z:1.6}, {x:-2.6,z:1.7}, {x:2.6,z:1.7}, {x:5.3,z:1.6},
];
/** Shortest route between stops; clockwise wins an exact tie. */
export function mapRoute(start: number, destination: number): number[] {
  const count = MAP_STOPS.length;
  if (!Number.isInteger(start) || !Number.isInteger(destination) || start < 0 || destination < 0 || start >= count || destination >= count) return [];
  const forward = (destination - start + count) % count, backward = (start - destination + count) % count;
  const step = forward <= backward ? 1 : -1, route: number[] = [];
  for (let i = 1; i <= Math.min(forward, backward); i++) route.push((start + step * i + count) % count);
  return route;
}
/** Sample the same quadratic curve used by the asphalt and the bus. */
export function sampleMapEdge(edge: number, segments = 16): MapPoint[] {
  const a=MAP_STOPS[edge], b=MAP_STOPS[(edge+1)%MAP_STOPS.length], c=MAP_CONTROLS[edge];
  if (!a || !b || !c || !Number.isInteger(segments) || segments < 1) return [];
  return Array.from({ length: segments+1 }, (_,i) => {
    const t=i/segments, q=1-t;
    return { x:q*q*a.x+2*q*t*c.x+t*t*b.x, z:q*q*a.z+2*q*t*c.z+t*t*b.z };
  });
}

