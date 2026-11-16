import { useCallback, useEffect, useState } from "react";
import { accountList, onAccountChanged } from "./ipc";
import type { Account, Accounts } from "./types";

/**
 * The accounts on disk and the one in effect, kept current.
 *
 * Owned by Rust, not by any window: the rail scan and the session watcher need
 * the answer before a webview is up, so every reader asks the backend and
 * refetches on `account://changed`, which any window's switch, add or remove
 * emits to all of them.
 */
export function useAccounts(): {
  accounts: Accounts | null;
  current: Account | null;
  error: string | null;
  setAccounts: (accounts: Accounts) => void;
} {
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = useCallback((next: Accounts) => {
    setAccounts(next);
    setError(null);
  }, []);
  useEffect(() => {
    let live = true;
    const load = () =>
      accountList().then(
        (result) => live && apply(result),
        (e: unknown) => live && setError(String(e)),
      );
    void load();
    const unlisten = onAccountChanged(() => void load());
    return () => {
      live = false;
      void unlisten.then((off) => off());
    };
  }, [apply]);
  const current = accounts?.accounts.find((a) => a.name === accounts.current) ?? null;
  return { accounts, current, error, setAccounts: apply };
}

/** `work (w@example.com)`, or the bare name when it is signed out. */
export function accountLabel(account: Account): string {
  return account.email ? `${account.name} (${account.email})` : account.name;
}
