import { describe, expect, it } from "vitest";
import { MAP_BUSHES, MAP_LAMPS, MAP_STOPS, mapRoute, planetRoadPoint, planetStopAngle, sampleMapEdge } from "../../data/mapRoute";

describe("town bus route", () => {
  it("uses the shortest path and a predictable clockwise tie", () => {
    expect(mapRoute(0, 1)).toEqual([1]);
    expect(mapRoute(0, 3)).toEqual([3]);
    expect(mapRoute(0, 2)).toEqual([1, 2]);
    expect(mapRoute(2, 0)).toEqual([3, 0]);
    expect(mapRoute(1, 1)).toEqual([]);
    expect(mapRoute(-1, 3)).toEqual([]);
  });
  it("connects every stop and keeps the bus clear of the central bandstand", () => {
    for (let edge=0; edge<MAP_STOPS.length; edge++) {
      const points=sampleMapEdge(edge);
      expect(points[0]).toEqual(MAP_STOPS[edge]);
      expect(points.at(-1)).toEqual(MAP_STOPS[(edge+1)%MAP_STOPS.length]);
      for (const p of points) {
        expect(Math.hypot(p.x,p.z)).toBeGreaterThan(1.7);
        const dx=Math.max(-5.12-p.x,0,p.x+3.08), dz=Math.max(-3.61-p.z,0,p.z+2.1);
        expect(Math.hypot(dx,dz)).toBeGreaterThan(.85);
        for (const bush of MAP_BUSHES) expect(Math.hypot(p.x-bush.x,p.z-bush.z)).toBeGreaterThan(1.1);
        for (const lamp of MAP_LAMPS) expect(Math.hypot(p.x-lamp.x,p.z-lamp.z)).toBeGreaterThan(.85);
      }
    }
  });
});

describe("planet bus route", () => {
  it("circles the front of the globe and returns to the same point", () => {
    const points = Array.from({ length: 5 }, (_, index) => {
      const point = { x: 0, y: 0, z: 0 };
      planetRoadPoint(index * Math.PI / 2, point);
      expect(Math.hypot(point.x, point.y, point.z)).toBeCloseTo(6.39);
      expect(point.z).toBeGreaterThan(0);
      return point;
    });
    expect(points[0].y).toBeGreaterThan(0);
    expect(points[1].x).toBeGreaterThan(0);
    expect(points[2].y).toBeLessThan(0);
    expect(points[3].x).toBeLessThan(0);
    expect(points[0].y).toBeCloseTo(points[4].y);
  });

  it("takes the shortest arc even when redirected between landmarks", () => {
    expect(planetStopAngle(0, 2)).toBeCloseTo(Math.PI);
    expect(planetStopAngle(0, 3)).toBeCloseTo(-Math.PI / 2);
    expect(planetStopAngle(Math.PI / 3, 3)).toBeCloseTo(-Math.PI / 2);
    expect(planetStopAngle(-Math.PI / 2, 0)).toBeCloseTo(0);
  });
});
