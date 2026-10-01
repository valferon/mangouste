import { useRef, useState, type MouseEvent } from "react";
import type { Thread } from "../lib/threads";

interface ThreadHeaderProps {
  thread: Thread;
  collapsed: boolean;
  /** Same summary a repo header carries: count, live, asking, review. */
  badge: string;
  onToggle: () => void;
  onContinue: () => void;
  onContextMenu: (event: MouseEvent) => void;
  /** Set by the menu's "Rename"; the header turns into an input until settled. */
  renaming: boolean;
  onRename: (title: string | null) => void;
}

const GLYPHS: Record<Thread["status"], string> = { open: "◆", blocked: "◈", done: "◇" };

/**
 * A thread's group header in the rail: a repo header's shape, with the thread's
 * glyph where the repo icon goes and `+` meaning "continue this" rather than
 * "start something here". Sticky like a repo header, for the same reason.
 */
export function ThreadHeader({
  thread,
  collapsed,
  badge,
  onToggle,
  onContinue,
  onContextMenu,
  renaming,
  onRename,
}: ThreadHeaderProps) {
  const [draft, setDraft] = useState(thread.title);
  /** Enter or Escape already settled it; the unmount blur must not settle it again. */
  const doneRef = useRef(false);

  return (
    <div
      className="repo-row thread-header"
      data-status={thread.status}
      onClick={onToggle}
      onContextMenu={onContextMenu}
      title={[thread.title, `thread · ${thread.status}`, `updated ${thread.updated.slice(0, 10)}`]
        .filter(Boolean)
        .join("\n")}
    >
      <span className="twisty">{collapsed ? "▸" : "▾"}</span>
      <span className="thread-glyph">{GLYPHS[thread.status]}</span>
      {renaming ? (
        <input
          className="thread-rename"
          autoFocus
          value={draft}
          onFocus={() => {
            doneRef.current = false;
            setDraft(thread.title);
          }}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (!doneRef.current) onRename(draft);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              doneRef.current = true;
              onRename(draft);
            }
            if (event.key === "Escape") {
              doneRef.current = true;
              onRename(null);
            }
          }}
        />
      ) : (
        <span className="label">{thread.title}</span>
      )}
      <span className="badge">{badge}</span>
      <button
        className="toggle-button"
        onClick={(event) => {
          event.stopPropagation();
          onContinue();
        }}
        title="Continue this thread in a new session, with its note in the composer"
      >
        +
      </button>
    </div>
  );
}

interface ThreadNoteProps {
  note: string;
  /** Resolves false when the save was refused, so the text stays in the box. */
  onSave: (note: string) => Promise<boolean>;
}

/**
 * "Where it stands / next", one dim line under the header. Click to edit in
 * place; Ctrl+Enter or a click away saves, Escape puts it back.
 */
export function ThreadNote({ note, onSave }: ThreadNoteProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const doneRef = useRef(false);

  const commit = (text: string) => {
    doneRef.current = true;
    if (text === note) {
      setEditing(null);
      return;
    }
    void onSave(text).then((saved) => {
      if (saved) setEditing(null);
      else doneRef.current = false;
    });
  };

  if (editing !== null) {
    return (
      <textarea
        className="thread-note-edit"
        autoFocus
        value={editing}
        rows={Math.min(8, Math.max(2, editing.split("\n").length))}
        placeholder="Where it stands, what is next…"
        onFocus={() => {
          doneRef.current = false;
        }}
        onChange={(event) => setEditing(event.target.value)}
        onBlur={() => {
          if (!doneRef.current) commit(editing);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            commit(editing);
          }
          if (event.key === "Escape") {
            doneRef.current = true;
            setEditing(null);
          }
        }}
      />
    );
  }
  const first = note.trim().split("\n")[0];
  return (
    <div
      className="thread-note-line"
      data-empty={!first}
      onClick={() => setEditing(note)}
      title={note.trim() ? `${note.trim()}\n\nClick to edit` : "Click to add a note"}
    >
      {first || "add a note: where it stands, what is next"}
    </div>
  );
}
