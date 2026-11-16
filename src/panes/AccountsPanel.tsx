import { useEffect, useState } from "react";
import {
  accountAdd,
  accountLogin,
  accountLoginCancel,
  accountRemove,
  onAccountLogin,
  openExternal,
} from "../lib/ipc";
import { useAccounts } from "../lib/accounts";

/** What a name may be: the backend's rule, checked here only to grey the button. */
const NAME = /^[A-Za-z0-9_-]+$/;

/** The last lines a sign-in printed, per account; enough to show its URL. */
const LOGIN_LINES = 4;

const URL = /https?:\/\/\S+/;

/**
 * Settings ▸ Accounts: what exists, who each is signed in as, and the means
 * to add, sign in and remove one. Picking which one is in use is the Usage
 * header's switcher, not this panel's; this only says which one that is.
 */
export function AccountsPanel() {
  const { accounts, error: loadError, setAccounts } = useAccounts();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** Accounts with a `claude auth login` running, and what it last printed. */
  const [logins, setLogins] = useState<Record<string, string[]>>({});
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});

  useEffect(() => {
    const unlisten = onAccountLogin((event) => {
      if (event.done !== null) {
        setLogins(({ [event.name]: _, ...rest }) => rest);
        setOutcomes((all) => ({
          ...all,
          [event.name]: event.done ? "signed in" : "sign-in did not finish",
        }));
        return;
      }
      const line = event.line?.trim();
      if (!line) return;
      setLogins((all) => ({
        ...all,
        [event.name]: [...(all[event.name] ?? []), line].slice(-LOGIN_LINES),
      }));
    });
    return () => void unlisten.then((off) => off());
  }, []);

  const fail = (e: unknown) => setError(String(e));

  const signIn = (name: string) => {
    setError(null);
    setOutcomes(({ [name]: _, ...rest }) => rest);
    setLogins((all) => ({ ...all, [name]: [] }));
    accountLogin(name).catch((e: unknown) => {
      setLogins(({ [name]: _, ...rest }) => rest);
      fail(e);
    });
  };

  const add = () => {
    const name = draft.trim();
    if (!NAME.test(name)) return;
    setError(null);
    accountAdd(name).then((next) => {
      setAccounts(next);
      setDraft("");
      // A new account is signed out and useless until it is not.
      signIn(name);
    }, fail);
  };

  const remove = (name: string, email: string | null) => {
    const who = email ? ` (${email})` : "";
    if (
      !window.confirm(
        `Remove the account ${name}${who}? Its directory under ~/.claude-accounts is deleted: ` +
          "credentials, history and anything not shared with main. Shared links are unlinked, not followed.",
      )
    )
      return;
    setError(null);
    accountRemove(name).then(setAccounts, fail);
  };

  return (
    <>
      <p className="setting-hint">
        Each account is a <code>CLAUDE_CONFIG_DIR</code>: <code>main</code> is{" "}
        <code>~/.claude</code>, the rest live under <code>~/.claude-accounts/</code>. A new one
        links main&apos;s settings, rules, skills, plugins and transcripts, and keeps its own
        sign-in. Switch with the account button in the Usage header. Open sessions move to the
        new account on their next message.
      </p>

      <div className="plugins-list">
        {!accounts && !loadError && <p className="setting-hint">Reading accounts…</p>}
        {(accounts?.accounts ?? []).map((account) => {
          const inUse = account.name === accounts?.current;
          const lines = logins[account.name];
          const signingIn = lines !== undefined;
          const link = lines?.map((line) => line.match(URL)?.[0]).find(Boolean);
          return (
            <div className="plugin-row" key={account.name}>
              <div className="plugin-main">
                <span className="plugin-name">
                  {account.name}
                  {inUse && <span className="plugin-meta"> · in use</span>}
                </span>
                <span className="plugin-meta">{account.email ?? "signed out"}</span>
                <span className="plugin-description" title={account.dir}>
                  {account.dir}
                </span>
                {signingIn && (
                  <span className="plugin-description">
                    {link ? (
                      <>
                        waiting for the browser.{" "}
                        <a
                          href={link}
                          onClick={(event) => {
                            event.preventDefault();
                            void openExternal(link);
                          }}
                        >
                          open the sign-in page
                        </a>
                      </>
                    ) : (
                      (lines.at(-1) ?? "starting claude auth login…")
                    )}
                  </span>
                )}
                {!signingIn && outcomes[account.name] && (
                  <span className="plugin-description">{outcomes[account.name]}</span>
                )}
              </div>
              <div className="plugin-actions">
                {signingIn ? (
                  <button
                    className="plugin-button"
                    onClick={() => void accountLoginCancel(account.name).catch(fail)}
                  >
                    cancel
                  </button>
                ) : (
                  <button className="plugin-button" onClick={() => signIn(account.name)}>
                    {account.email ? "sign in again" : "sign in"}
                  </button>
                )}
                {account.name !== "main" && (
                  <button
                    className="plugin-button"
                    disabled={inUse || signingIn}
                    title={inUse ? "Switch to another account first" : undefined}
                    onClick={() => remove(account.name, account.email)}
                  >
                    remove
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="setting-row">
        <label>Add account</label>
        <input
          type="text"
          placeholder="name, e.g. personal"
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && add()}
        />
        <button className="plugin-button" disabled={!NAME.test(draft.trim())} onClick={add}>
          add
        </button>
      </div>
      <p className="setting-hint">
        Letters, digits, <code>-</code> and <code>_</code>. Adding signs it in through the browser.
        If the sign-in wants a pasted code instead, run{" "}
        <code>CLAUDE_CONFIG_DIR=~/.claude-accounts/&lt;name&gt; claude auth login</code> in a
        terminal.
      </p>
      {(error || loadError) && <p className="setting-hint">{error ?? loadError}</p>}
    </>
  );
}
