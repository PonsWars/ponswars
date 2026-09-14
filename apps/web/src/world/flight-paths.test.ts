import { describe, expect, it } from 'vitest';
import { flightAt, flightPaths, TRAFFIC_BAND, TRAFFIC_INNER } from './flight-paths.js';

describe('flightPaths', () => {
  it('is the same traffic for the same seed', () => {
    expect(flightPaths(5, 12)).toEqual(flightPaths(5, 12));
    expect(flightPaths(6, 12)).not.toEqual(flightPaths(5, 12));
  });

  it('keeps every ship over the skylines, under the beacon, and clear of the citadel', () => {
    for (const path of flightPaths(5, 24)) {
      for (let second = 0; second < 600; second += 7) {
        const ship = flightAt(path, second);
        expect(ship.y).toBeGreaterThanOrEqual(TRAFFIC_BAND.low);
        expect(ship.y).toBeLessThanOrEqual(TRAFFIC_BAND.high);
        expect(Math.hypot(ship.x, ship.z)).toBeGreaterThanOrEqual(TRAFFIC_INNER - 0.001);
      }
    }
  });
});

describe('flightAt', () => {
  it('faces the way the ship is moving', () => {
    const [path] = flightPaths(9, 1);
    if (path === undefined) {
      throw new Error('no path');
    }
    const now = flightAt(path, 10);
    const next = flightAt(path, 10.01);
    const travel = Math.atan2(next.x - now.x, next.z - now.z);
    const difference = Math.atan2(Math.sin(travel - now.heading), Math.cos(travel - now.heading));
    expect(Math.abs(difference)).toBeLessThan(0.01);
  });
});
