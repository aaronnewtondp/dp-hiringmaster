import { useState } from 'react';

// Backs a piece of UI state with sessionStorage so filters/search survive
// navigating to another page and back within the same browser tab, but
// still reset on a genuinely new session (new tab, browser restart) —
// sessionStorage, not localStorage, is the deliberate choice here.
// Drop-in replacement for useState: same [value, setValue] tuple shape.
export function usePersistedState<T>(key: string, initialValue: T): [T, (value: T | ((prev: T) => T)) => void] {
  const storageKey = `hms:${key}`;

  const [state, setState] = useState<T>(() => {
    try {
      const stored = sessionStorage.getItem(storageKey);
      return stored != null ? (JSON.parse(stored) as T) : initialValue;
    } catch {
      return initialValue;
    }
  });

  const setPersistedState = (value: T | ((prev: T) => T)) => {
    setState(prev => {
      const next = typeof value === 'function' ? (value as (prev: T) => T)(prev) : value;
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Quota exceeded or unserializable value — state still updates in
        // memory, it just won't survive navigation this one time.
      }
      return next;
    });
  };

  return [state, setPersistedState];
}
