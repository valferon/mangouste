import { useCallback, useEffect, useRef, useState } from "react";
import { PencilIcon, PlusIcon, QuickPromptsIcon, TrashIcon } from "../lib/icons";
import { useMenu, type MenuEntry } from "../lib/menu";
import {
  addPrompt,
  movePrompt,
  normaliseDraft,
  PROMPTS_KEY,
  readPrompts,
  removePrompt,
  updatePrompt,
  writePrompts,
  type QuickPrompt,
  type QuickPromptDraft,
} from "../lib/quickPrompts";

interface QuickPromptsPaneProps {
  /** Put this prompt into the session in front, or a new one when there is none. */
  onRun: (prompt: QuickPrompt) => void;
  /**
   * Where a click will land, for the header hint: the front session's label,
   * or null when a click would have to open a session of its own.
   */
  target: string | null;
}

const EMPTY_DRAFT: QuickPromptDraft = { label: "", text: "", submit: false };

/** "new" is the add form; any other string is the id of the prompt being edited. */
type Editing = "new" | string | null;

const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * The editor for one prompt, used both to add and to edit.
 *
 * Ctrl+Enter saves and Escape cancels, the same pair the commit box answers to,
 * so a prompt can be written without reaching for the mouse.
 */
function PromptEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: QuickPromptDraft;
  onSave: (draft: QuickPromptDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textRef.current?.focus();
  }, []);
  const canSave = normaliseDraft(draft) !== null;
  const save = () => canSave && onSave(draft);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };
  return (
    <div className="prompt-editor" onKeyDown={onKeyDown}>
      <input
        className="prompt-editor-label"
        placeholder="Button label (defaults to the first line)"
        value={draft.label}
        onChange={(event) => setDraft({ ...draft, label: event.target.value })}
        spellCheck={false}
      />
      <textarea
        ref={textRef}
        className="commit-message prompt-editor-text"
        rows={4}
        placeholder="What to paste into the session"
        value={draft.text}
        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
        spellCheck={false}
      />
      <label className="prompt-editor-submit">
        <input
          type="checkbox"
          checked={draft.submit}
          onChange={(event) => setDraft({ ...draft, submit: event.target.checked })}
        />
        Send on click
      </label>
      <div className="commit-actions">
        <button
          className="toggle-button commit-button"
          disabled={!canSave}
          onClick={save}
          title="Save (Ctrl+Enter)"
        >
          Save
        </button>
        <button className="toggle-button commit-button" onClick={onCancel} title="Cancel (Escape)">
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The Prompts rail view: one button per saved message.
 *
 * A click hands the prompt to the session in front, which puts it in its
 * composer (or sends it, for a prompt saved with "Send on click"). Adding,
 * editing, reordering and deleting all happen in place.
 */
export function QuickPromptsPane({ onRun, target }: QuickPromptsPaneProps) {
  const menu = useMenu();
  const [prompts, setPrompts] = useState<QuickPrompt[]>(readPrompts);
  const [editing, setEditing] = useState<Editing>(null);
  /** The row asking "delete?", so one stray click on the bin deletes nothing. */
  const [confirming, setConfirming] = useState<string | null>(null);

  // Another window edited the list. `storage` fires only in the windows that
  // did not write, so this never echoes our own save back at us.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === PROMPTS_KEY) setPrompts(readPrompts());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const commit = useCallback((next: QuickPrompt[]) => {
    setPrompts(next);
    writePrompts(next);
  }, []);

  const saveDraft = (draft: QuickPromptDraft) => {
    commit(
      editing === "new" ? addPrompt(prompts, draft, newId()) : updatePrompt(prompts, editing!, draft),
    );
    setEditing(null);
  };

  const rowMenu = (prompt: QuickPrompt, index: number): MenuEntry[] => [
    { label: prompt.submit ? "Send" : "Paste into Session", run: () => onRun(prompt) },
    "separator",
    { label: "Edit…", run: () => setEditing(prompt.id) },
    {
      label: prompt.submit ? "Paste Only, Don't Send" : "Send on Click",
      run: () => commit(updatePrompt(prompts, prompt.id, { ...prompt, submit: !prompt.submit })),
    },
    { label: "Move Up", disabled: index === 0, run: () => commit(movePrompt(prompts, prompt.id, -1)) },
    {
      label: "Move Down",
      disabled: index === prompts.length - 1,
      run: () => commit(movePrompt(prompts, prompt.id, 1)),
    },
    "separator",
    { label: "Delete", danger: true, run: () => setConfirming(prompt.id) },
  ];

  return (
    <div className="sidebar-section" style={{ flex: 1 }}>
      <div className="pane-header">
        <QuickPromptsIcon />
        <span className="pane-title">Prompts</span>
        <div className="actions">
          <button
            className="toggle-button icon-button"
            onClick={() => {
              setConfirming(null);
              setEditing("new");
            }}
            title="New prompt"
          >
            <PlusIcon />
          </button>
        </div>
      </div>
      <div className="pane-body">
        <div className="prompt-target" title="Where a click lands">
          {target ? `→ ${target}` : "→ a new session in this repo"}
        </div>
        {editing === "new" && (
          <PromptEditor initial={EMPTY_DRAFT} onSave={saveDraft} onCancel={() => setEditing(null)} />
        )}
        {prompts.length === 0 && editing !== "new" && (
          <div className="empty-note">
            No prompts yet. Save a message you keep typing, then send it to the session in front
            with one click.
            <div>
              <button className="toggle-button commit-button" onClick={() => setEditing("new")}>
                <PlusIcon /> New prompt
              </button>
            </div>
          </div>
        )}
        <div className="prompt-list">
          {prompts.map((prompt, index) =>
            editing === prompt.id ? (
              <PromptEditor
                key={prompt.id}
                initial={prompt}
                onSave={saveDraft}
                onCancel={() => setEditing(null)}
              />
            ) : confirming === prompt.id ? (
              <div key={prompt.id} className="prompt-row" data-confirming="true">
                <span className="prompt-confirm">Delete “{prompt.label}”?</span>
                <button
                  className="toggle-button prompt-danger"
                  onClick={() => {
                    commit(removePrompt(prompts, prompt.id));
                    setConfirming(null);
                  }}
                >
                  Delete
                </button>
                <button className="toggle-button" onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div
                key={prompt.id}
                className="prompt-row"
                onContextMenu={(event) => menu.openContextMenu(event, rowMenu(prompt, index))}
              >
                <button
                  className="prompt-button"
                  onClick={() => onRun(prompt)}
                  title={`${prompt.submit ? "Send" : "Paste"}:\n${prompt.text}`}
                >
                  <span className="prompt-label">{prompt.label}</span>
                  {prompt.submit && <span className="prompt-badge">send</span>}
                </button>
                <div className="prompt-actions">
                  <button
                    className="toggle-button icon-button"
                    onClick={() => {
                      setConfirming(null);
                      setEditing(prompt.id);
                    }}
                    title="Edit"
                  >
                    <PencilIcon />
                  </button>
                  <button
                    className="toggle-button icon-button"
                    onClick={() => setConfirming(prompt.id)}
                    title="Delete"
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

