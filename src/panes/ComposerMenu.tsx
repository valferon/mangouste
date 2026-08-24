/**
 * The composer's autocomplete popup, for `/` commands and `@` file mentions.
 *
 * Presentation only: the draft, the caret and the highlighted row all live in
 * ChatPane, because the keys that drive them (arrows, Tab, Enter, Escape) have
 * to be intercepted in the textarea before its own handlers see them.
 */

import { useEffect, useRef } from "react";

export interface ComposerMenuItem {
  key: string;
  /** Text that replaces the trigger token when this row is chosen. */
  insert: string;
  primary: string;
  /** Argument hint, rendered next to the name. */
  hint?: string;
  secondary?: string;
  /** Short tag on the right — "app" for commands mangouste answers itself. */
  badge?: string;
}

export function ComposerMenu({
  items,
  cursor,
  onPick,
  onHover,
}: {
  items: ComposerMenuItem[];
  cursor: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Arrowing past the fold has to bring the row with it.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-cursor="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (items.length === 0) return null;

  return (
    <div className="composer-menu" ref={listRef}>
      {items.map((item, index) => (
        <div
          key={item.key}
          className="composer-menu-row"
          data-cursor={index === cursor}
          onMouseEnter={() => onHover(index)}
          // mousedown, not click: the textarea loses focus on click, and the
          // blur handler closes the menu before the pick lands.
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(index);
          }}
        >
          <span className="cm-name">{item.primary}</span>
          {item.hint && <em className="cm-hint">{item.hint}</em>}
          {item.secondary && <span className="cm-desc">{item.secondary}</span>}
          {item.badge && <span className="cm-badge">{item.badge}</span>}
        </div>
      ))}
    </div>
  );
}
