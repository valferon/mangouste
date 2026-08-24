import { useCallback, useEffect, useRef } from "react";
import { CHORD } from "../lib/keybindings";
import { useMenu, type MenuEntry } from "../lib/menu";

export interface BarMenu {
  /** Stable id, used to keep the button lit while its menu is down. */
  id: string;
  label: string;
  /**
   * The entries, or a thunk for a menu whose contents depend on something React
   * does not re-render for — the Edit menu reads `document.activeElement`, which
   * moves without any state changing.
   */
  items: MenuEntry[] | (() => MenuEntry[]);
}

/**
 * The titlebar menu bar.
 *
 * Deliberately not a native `tauri::Menu`: this window has no decorated menu
 * area to hang one from, GTK draws its own with its own theme, and the actions
 * all live in React state anyway. It behaves like the native one where it counts
 * — one open menu at a time, hover moves between them once one is open, and the
 * arrow keys walk the whole bar.
 */
export function MenuBar({ menus }: { menus: BarMenu[] }) {
  const menu = useMenu();
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  /** `openId` is namespaced, so a context menu never lights a bar button. */
  const activeId = menu.openId?.startsWith("menubar:")
    ? menu.openId.slice("menubar:".length)
    : null;

  const open = useCallback(
    (id: string) => {
      const index = menus.findIndex((entry) => entry.id === id);
      const button = buttons.current.get(id);
      if (index < 0 || !button) return;
      const rect = button.getBoundingClientRect();
      const { items } = menus[index];
      menu.openMenu({
        items: typeof items === "function" ? items() : items,
        x: rect.left,
        y: rect.bottom + 2,
        ownerId: `menubar:${id}`,
        // ArrowLeft/ArrowRight at the top level walk to the next bar menu,
        // which is the one thing a bare popup cannot know how to do.
        onCycle: (direction) => {
          const next = menus[(index + direction + menus.length) % menus.length];
          open(next.id);
        },
        // The Edit menu's items are about the focused field, not about the
        // button that opened them.
        target: document.activeElement,
      });
    },
    [menu, menus],
  );

  // F10 opens the first menu, as in every GTK app; the arrow keys take it from
  // there. The only way into the bar without a mouse.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== CHORD.menuBar ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.metaKey
      ) {
        return;
      }
      event.preventDefault();
      if (activeId) menu.closeMenu();
      else if (menus.length > 0) open(menus[0].id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeId, menu, menus, open]);

  return (
    <div className="menu-bar" role="menubar">
      {menus.map((entry) => (
        <button
          key={entry.id}
          className="menu-bar-button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={activeId === entry.id}
          data-active={activeId === entry.id}
          ref={(element) => {
            if (element) buttons.current.set(entry.id, element);
            else buttons.current.delete(entry.id);
          }}
          // mousedown, not click: the menu has to be up before the button takes
          // focus, or opening Edit would move the caret out of the field the
          // Edit menu is about. preventDefault is what stops that focus move.
          onMouseDown={(event) => {
            event.preventDefault();
            if (activeId === entry.id) menu.closeMenu();
            else open(entry.id);
          }}
          onMouseEnter={() => {
            if (activeId && activeId !== entry.id) open(entry.id);
          }}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
