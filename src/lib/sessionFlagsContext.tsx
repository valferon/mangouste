import { createContext, useContext, type ReactNode } from "react";
import { useSessionFlags, type SessionFlags } from "./sessionStore";

/**
 * One read/archive overlay for the whole window.
 *
 * Every view that stores or reads a session status goes through here, so the
 * sessions rail, the status panel and quick-open cannot disagree about what a
 * row is. Two `useSessionFlags()` call sites would each hold their own copy of
 * the store and would not see each other's writes until a remount.
 */
const SessionFlagsContext = createContext<SessionFlags | null>(null);

export function SessionFlagsProvider({ children }: { children: ReactNode }) {
  const flags = useSessionFlags();
  return <SessionFlagsContext.Provider value={flags}>{children}</SessionFlagsContext.Provider>;
}

export function useFlags(): SessionFlags {
  const flags = useContext(SessionFlagsContext);
  if (!flags) {
    throw new Error("useFlags() outside SessionFlagsProvider");
  }
  return flags;
}
