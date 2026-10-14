// useBelowBreakpoint — KnockDesk v2 hook
import { useEffect, useState } from 'react';

export function useBelowBreakpoint(breakpoint: number): boolean {
  const [isBelow, setIsBelow] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < breakpoint;
  });

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsBelow(e.matches);
    mql.addEventListener('change', handler);
    setIsBelow(mql.matches);
    return () => mql.removeEventListener('change', handler);
  }, [breakpoint]);

  return isBelow;
}

export default useBelowBreakpoint;