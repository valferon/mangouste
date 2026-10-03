import { useRef, useState } from "react";

interface SessionTitleInputProps {
  title: string;
  /** The typed name, or `null` when the edit was abandoned. */
  onDone: (title: string | null) => void;
}

/**
 * A session row's title as an input, from the menu's "Rename". Settles like the
 * thread header's: Enter or blur keeps the draft, Escape drops it.
 */
export function SessionTitleInput({ title, onDone }: SessionTitleInputProps) {
  const [draft, setDraft] = useState(title);
  /** Enter or Escape already settled it; the unmount blur must not settle it again. */
  const doneRef = useRef(false);
  const settle = (value: string | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(value);
  };
  return (
    <input
      className="session-rename"
      autoFocus
      value={draft}
      onFocus={(event) => event.target.select()}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => settle(draft)}
      onKeyDown={(event) => {
        // Kept off the row: its own keys, and the rail's, are not for a draft.
        event.stopPropagation();
        if (event.key === "Enter") settle(draft);
        if (event.key === "Escape") settle(null);
      }}
    />
  );
}
