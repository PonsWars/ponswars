// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useSession } from '../state/session.js';
import { NavigationControls } from './NavigationControls.js';

/**
 * The controls a player reaches for (§42.8, §37.7, §82.2, §83.1).
 *
 * The first component test in the web app. Everything here is a rule about
 * what is *rendered* — which is where a pure function cannot follow, and where
 * two bugs have already been found by hand: a control clipped off a phone
 * screen, and a graphics setting that did not exist at all.
 */

afterEach(() => {
  cleanup();
  useSession.setState({ quality: 'BALANCED', myBattleId: null });
});

describe('the navigation controls', () => {
  it('offers zoom, focus and reset, as §42.8 requires', () => {
    render(<NavigationControls />);

    expect(screen.getByLabelText('Zoom in')).toBeDefined();
    expect(screen.getByLabelText('Zoom out')).toBeDefined();
    expect(screen.getByText('FOCUS MY WAR')).toBeDefined();
    expect(screen.getByText('RESET VIEW')).toBeDefined();
  });

  it('never disables RESET VIEW', () => {
    // The control someone reaches for when they are lost. §37.7's promise that
    // free navigation never strands anyone only holds if the way out is live.
    render(<NavigationControls />);

    expect(screen.getByText('RESET VIEW').hasAttribute('disabled')).toBe(false);
  });

  it('offers FOCUS MY WAR only when there is a war to focus', () => {
    render(<NavigationControls />);
    expect(screen.getByText('FOCUS MY WAR').hasAttribute('disabled')).toBe(true);

    cleanup();
    useSession.setState({ myBattleId: 'battle-1' });
    render(<NavigationControls />);
    expect(screen.getByText('FOCUS MY WAR').hasAttribute('disabled')).toBe(false);
  });

  it('moves the camera when zoom is pressed', () => {
    render(<NavigationControls />);
    const before = useSession.getState().camera.pose.position;

    fireEvent.click(screen.getByLabelText('Zoom in'));

    expect(useSession.getState().camera.pose.position).not.toEqual(before);
  });
});

describe('the graphics control (§82.2)', () => {
  it('shows the tier the world is drawing at', () => {
    useSession.setState({ quality: 'PERFORMANCE' });
    render(<NavigationControls />);

    // A tier the world dropped to says so, rather than quietly looking worse.
    expect(screen.getByRole('combobox')).toHaveProperty('value', 'PERFORMANCE');
  });

  it('hands the choice to the store', () => {
    render(<NavigationControls />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'HIGH' } });

    expect(useSession.getState().quality).toBe('HIGH');
  });

  it('never offers reduced motion as a picture setting (§83.3)', () => {
    render(<NavigationControls />);

    const options = [...screen.getByRole('combobox').querySelectorAll('option')].map(
      (option) => option.value,
    );
    expect(options).toEqual(['ULTRA', 'HIGH', 'BALANCED', 'PERFORMANCE']);
  });
});
