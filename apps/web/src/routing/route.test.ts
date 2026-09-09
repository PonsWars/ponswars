import { describe, expect, it } from 'vitest';
import { isPresentation, parseRoute, pathFor, WORLD_ROUTE, type Route } from './route.js';

const ALL_ROUTES: readonly Route[] = [
  WORLD_ROUTE,
  { kind: 'WORLD', battleId: 'b-42' },
  { kind: 'PROFILE' },
  { kind: 'REWARDS' },
  { kind: 'GENESIS' },
  { kind: 'RESULT', battleId: null },
];

describe('parseRoute', () => {
  it('reads the world at the root', () => {
    expect(parseRoute('/')).toEqual(WORLD_ROUTE);
    expect(parseRoute('')).toEqual(WORLD_ROUTE);
  });

  it('reads a shared battle link', () => {
    expect(parseRoute('/war/b-42')).toEqual({ kind: 'WORLD', battleId: 'b-42' });
  });

  it('tolerates trailing and doubled slashes', () => {
    expect(parseRoute('/war/b-42/')).toEqual({ kind: 'WORLD', battleId: 'b-42' });
    expect(parseRoute('//profile//')).toEqual({ kind: 'PROFILE' });
  });

  it('treats a truncated battle link as the unfocused world', () => {
    // A URL cut short in a chat client should not become a dead end.
    expect(parseRoute('/war')).toEqual(WORLD_ROUTE);
  });

  it('sends anything unrecognised to the world', () => {
    // §37.1: in a spatial product there is nowhere else for a player to be, so
    // a stale deep link lands them in the world rather than on a 404.
    expect(parseRoute('/nope')).toEqual(WORLD_ROUTE);
    expect(parseRoute('/profile/extra/segments')).toEqual({ kind: 'PROFILE' });
  });

  it('reads each presentation route', () => {
    expect(parseRoute('/profile')).toEqual({ kind: 'PROFILE' });
    expect(parseRoute('/rewards')).toEqual({ kind: 'REWARDS' });
    expect(parseRoute('/genesis')).toEqual({ kind: 'GENESIS' });
    expect(parseRoute('/result')).toEqual({ kind: 'RESULT', battleId: null });
  });
});

describe('pathFor', () => {
  it('round-trips every route', () => {
    for (const route of ALL_ROUTES) {
      expect(parseRoute(pathFor(route))).toEqual(route);
    }
  });

  it('writes the root for an unfocused world', () => {
    expect(pathFor(WORLD_ROUTE)).toBe('/');
  });
});

describe('isPresentation', () => {
  it('separates overlays from the world', () => {
    expect(isPresentation(WORLD_ROUTE)).toBe(false);
    expect(isPresentation({ kind: 'WORLD', battleId: 'b-1' })).toBe(false);
    expect(isPresentation({ kind: 'PROFILE' })).toBe(true);
    expect(isPresentation({ kind: 'REWARDS' })).toBe(true);
    expect(isPresentation({ kind: 'GENESIS' })).toBe(true);
    expect(isPresentation({ kind: 'RESULT', battleId: null })).toBe(true);
  });
});
