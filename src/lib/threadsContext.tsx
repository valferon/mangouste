import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  memberOf,
  onThreadsChanged,
  sortThreads,
  threadCreate,
  threadSave,
  threadsList,
  titleFromSession,
  withSession,
  withoutSession,
  type Thread,
  type ThreadSession,
} from "./threads";
import type { SessionMeta } from "./types";

/**
 * One thread list for the whole window, for the same reason as the session
 * flags: the threads section and the sessions rail's menus must not hold two
 * copies that disagree. Other windows are kept in step by the change event.
 */
export interface ThreadsApi {
  threads: Thread[];
  /** The last save or load that failed, for the section to show. */
  error: string | null;
  /**
   * Persist an edited thread. The edit helpers in `threads.ts` make them.
   * False when refused — most often because the thread changed elsewhere since
   * it was read — so the caller can keep what the user typed.
   */
  save: (thread: Thread) => Promise<boolean>;
  startFromSession: (session: SessionMeta) => Promise<Thread | null>;
  addSession: (threadId: string, session: SessionMeta) => Promise<void>;
  /**
   * Attach a session the scan has not seen yet — one just started to continue
   * a thread, whose only known fact is its id.
   */
  addMember: (threadId: string, member: ThreadSession) => Promise<void>;
  removeSession: (threadId: string, sessionId: string) => Promise<void>;
}

const ThreadsContext = createContext<ThreadsApi | null>(null);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ThreadsProvider({ children }: { children: ReactNode }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setThreads(sortThreads(await threadsList()));
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    const unlisten = onThreadsChanged(() => void reload());
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [reload]);

  const save = useCallback(
    async (thread: Thread) => {
      let failure: string | null = null;
      try {
        await threadSave(thread);
      } catch (err) {
        failure = message(err);
      }
      // The change event reloads every window, this one included; reloading
      // here as well picks up the newer version a refused save was up against.
      await reload();
      if (failure) setError(failure);
      return failure === null;
    },
    [reload],
  );

  const startFromSession = useCallback(
    async (session: SessionMeta) => {
      try {
        const thread = await threadCreate(titleFromSession(session), memberOf(session));
        setError(null);
        await reload();
        return thread;
      } catch (err) {
        setError(message(err));
        return null;
      }
    },
    [reload],
  );

  const edit = useCallback(
    async (threadId: string, change: (thread: Thread) => Thread) => {
      const current = threads.find((t) => t.id === threadId);
      if (!current) return;
      const next = change(current);
      if (next !== current) await save(next);
    },
    [threads, save],
  );

  const addSession = useCallback(
    (threadId: string, session: SessionMeta) =>
      edit(threadId, (t) => withSession(t, memberOf(session))),
    [edit],
  );

  const addMember = useCallback(
    (threadId: string, member: ThreadSession) => edit(threadId, (t) => withSession(t, member)),
    [edit],
  );

  const removeSession = useCallback(
    (threadId: string, sessionId: string) => edit(threadId, (t) => withoutSession(t, sessionId)),
    [edit],
  );

  const api = useMemo(
    () => ({ threads, error, save, startFromSession, addSession, addMember, removeSession }),
    [threads, error, save, startFromSession, addSession, addMember, removeSession],
  );
  return <ThreadsContext.Provider value={api}>{children}</ThreadsContext.Provider>;
}

export function useThreads(): ThreadsApi {
  const api = useContext(ThreadsContext);
  if (!api) {
    throw new Error("useThreads() outside ThreadsProvider");
  }
  return api;
}
