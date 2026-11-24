import { useEffect, useRef, useState } from "react";
import {
  accountAdd,
  accountLogin,
  accountLoginCancel,
  accountRemove,
  accountRename,
  onAccountLogin,
  openExternal,
} from "../lib/ipc";
import { useAccounts } from "../lib/accounts";
import { accountDirectory, accountLabel, accountTitle, MAX_LABEL } from "../lib/accountNames";
import type { Account } from "../lib/types";

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
  /** The account whose name is in the box, and what the box holds. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  /** Enter or Escape already settled it; the blur that follows must not settle it again. */
  const renameDone = useRef(false);

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

  /**
   * What was typed, and the directory it would get. The box takes anything:
   * the directory is a plain version of it, numbered if that is taken, and
   * the thing typed is kept as the account's label. Null while there is
   * nothing typed, or before the list of what is taken has loaded.
   */
  const typed = draft.trim();
  const directory =
    accounts && typed.length <= MAX_LABEL
      ? accountDirectory(
          typed,
          accounts.accounts.map((account) => account.name),
        )
      : null;

  const add = () => {
    if (!directory) return;
    setError(null);
    // The label goes with the directory in one call: a name another account
    // answers to is refused before anything is made, and what was typed
    // stays in the box to be changed.
    accountAdd(directory, typed === directory ? null : typed).then((next) => {
      setAccounts(next);
      setDraft("");
      // A new account is signed out and useless until it is not.
      signIn(directory);
    }, fail);
  };

  const startRename = (account: Account) => {
    setError(null);
    renameDone.current = false;
    setRenameDraft(account.label ?? "");
    setRenaming(account.name);
  };

  /** Blank takes the label off again, back to the address or the directory name. */
  const commitRename = (account: Account) => {
    setRenaming(null);
    const next = renameDraft.trim();
    if (next === (account.label ?? "")) return;
    accountRename(account.name, next).then(setAccounts, fail);
  };

  const remove = (account: Account) => {
    if (
      !window.confirm(
        `Remove the account ${accountLabel(account)}? Its directory, ${account.dir}, is deleted: ` +
          "credentials, history and anything not shared with main. Shared links are unlinked, not followed.",
      )
    )
      return;
    setError(null);
    accountRemove(account.name).then(setAccounts, fail);
  };

  return (
    <>
      <p className="setting-hint">
        Each account is a <code>CLAUDE_CONFIG_DIR</code>: <code>main</code> is{" "}
        <code>~/.claude</code>, the rest live under <code>~/.claude-accounts/</code>. A new one
        links main&apos;s settings, rules, skills, plugins and transcripts, and keeps its own
        sign-in. Switch with the account button in the Usage header. Open sessions move to the
        new account on their next message, and switching never needs a new sign-in: a sign-in
        lasts weeks, and its token is renewed without you. An account shows as the address it is
        signed in as, or as the name <b>rename</b> gives it; its directory keeps the name it was
        made with.
      </p>

      <div className="plugins-list">
        {!accounts && !loadError && <p className="setting-hint">Reading accounts…</p>}
        {(accounts?.accounts ?? []).map((account) => {
          const inUse = account.name === accounts?.current;
          const lines = logins[account.name];
          const signingIn = lines !== undefined;
          const link = lines?.map((line) => line.match(URL)?.[0]).find(Boolean);
          const title = accountTitle(account);
          const who = account.email ?? "signed out";
          return (
            <div className="plugin-row" key={account.name}>
              <div className="plugin-main">
                <span className="plugin-name">
                  {renaming === account.name ? (
                    <input
                      className="session-rename"
                      autoFocus
                      value={renameDraft}
                      maxLength={MAX_LABEL}
                      spellCheck={false}
                      // What it goes back to being called when left blank.
                      placeholder={account.email ?? account.name}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onBlur={() => {
                        if (!renameDone.current) commitRename(account);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          renameDone.current = true;
                          commitRename(account);
                        }
                        if (event.key === "Escape") {
                          renameDone.current = true;
                          setRenaming(null);
                        }
                      }}
                    />
                  ) : (
                    title
                  )}
                  {inUse && <span className="plugin-meta"> · in use</span>}
                </span>
                {/* Not under a title that already is the address. */}
                {who !== title && <span className="plugin-meta">{who}</span>}
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
                <button
                  className="plugin-button"
                  disabled={renaming === account.name}
                  title="What this account is called here. Its directory keeps its name."
                  onClick={() => startRename(account)}
                >
                  rename
                </button>
                {account.name !== "main" && (
                  <button
                    className="plugin-button"
                    disabled={inUse || signingIn}
                    title={inUse ? "Switch to another account first" : undefined}
                    onClick={() => remove(account)}
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
          placeholder="name, e.g. Personal"
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && add()}
        />
        <button className="plugin-button" disabled={!directory} onClick={add}>
          add
        </button>
      </div>
      <p className="setting-hint">
        Call it anything, up to {MAX_LABEL} characters.{" "}
        {directory && directory !== typed ? (
          <>
            Its directory will be <code>~/.claude-accounts/{directory}</code>.{" "}
          </>
        ) : (
          <>The directory gets a plain version of the name. </>
        )}
        Adding signs it in through the browser. If the sign-in wants a pasted code instead, run{" "}
        <code>CLAUDE_CONFIG_DIR=~/.claude-accounts/&lt;directory&gt; claude auth login</code> in a
        terminal.
      </p>
      {(error || loadError) && <p className="setting-hint">{error ?? loadError}</p>}
    </>
  );
}
