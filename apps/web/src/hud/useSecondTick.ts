import { useEffect, useState } from 'react';

/**
 * Local time, refreshed once a second.
 *
 * Aligned to the next whole second rather than set on a fixed interval from
 * mount, so the digit changes when the second changes instead of drifting a few
 * hundred milliseconds behind it.
 *
 * Shared because two things now count down: the round clock, and the wait a
 * rate-limited sign-in was given. Two copies would drift apart on the same
 * screen for no reason anybody could see.
 */
export function useSecondTick(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const schedule = (): void => {
      const current = Date.now();
      setNow(current);
      timer = setTimeout(schedule, 1_000 - (current % 1_000));
    };
    schedule();

    return () => {
      clearTimeout(timer);
    };
  }, []);

  return now;
}
