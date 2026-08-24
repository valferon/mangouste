/**
 * One menu implementation, used for both the menu bar and every right-click.
 *
 * The webview's own context menu is suppressed app-wide — under WebKitGTK it
 * offers "Reload" and "Copy" over a page that has nowhere to reload to, and it
 * paints on top of anything we draw — so right-click is answered here instead.
 * Panes hand `openContextMenu` a list of entries; anything they do not claim
 * falls through to a default built from what is under the pointer plus whatever
 * the workbench registered as its app-wide actions.
 *
 * Two sentinels keep call sites short:
 *
 *   "editing"  → Undo/Cut/Copy/Paste/Select All for the clicked target, plus
 *                link actions when the click landed on an anchor
 *   "app"      → the workbench-wide block (registered by `setFallback`)
 *
 * Both expand at open time, against the event's target, because what they mean
 * depends on where the pointer was — not on when the array was built.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  copyText,
  cutFrom,
  isEditable,
  pasteInto,
  redoIn,
  selectAllIn,
  selectionAt,
  undoIn,
} from "./editing";
import { openExternal } from "./ipc";
import { CHORD } from "./keybindings";
import {
  entriesAtLevel,
  expand,
  isAction,
  isHeader,
  itemAt,
  step,
  tidy,
  type MenuAction,
  type MenuEntry,
} from "./menuModel";

export type { MenuAction, MenuEntry } from "./menuModel";

/* ---------- default entries ---------- */

function linkAt(target: EventTarget | null): HTMLAnchorElement | null {
  return target instanceof Element ? target.closest("a[href]") : null;
}

/**
 * Cut/copy/paste for whatever was clicked.
 *
 * The selection is read *now*, while the menu is being built, and captured in
 * the closures: a menu is opened by the same gesture that can clear a highlight,
 * so reading it when the item runs would copy an empty string.
 */
export function editingEntries(target: EventTarget | null): MenuEntry[] {
  const field = isEditable(target) ? target : null;
  const selection = selectionAt(target);
  const link = linkAt(target);
  const href = link?.getAttribute("href") ?? null;

  return [
    href && { label: "Open Link in Browser", run: () => void openExternal(href) },
    href && { label: "Copy Link Address", run: () => void copyText(href) },
    href && "separator",
    field && { label: "Undo", accelerator: CHORD.undo, run: () => undoIn(field) },
    field && { label: "Redo", accelerator: CHORD.redo, run: () => redoIn(field) },
    field && "separator",
    field && {
      label: "Cut",
      accelerator: CHORD.cut,
      disabled: !selection,
      run: () => void cutFrom(field),
    },
    {
      label: "Copy",
      accelerator: CHORD.copy,
      disabled: !selection,
      run: () => void copyText(selection),
    },
    field && { label: "Paste", accelerator: CHORD.paste, run: () => void pasteInto(field) },
    "separator",
    { label: "Select All", accelerator: CHORD.selectAll, run: () => selectAllIn(target) },
  ];
}

/* ---------- the open menu ---------- */

export interface MenuRequest {
  items: MenuEntry[];
  /** Viewport coordinates of the top-left corner the menu should grow from. */
  x: number;
  y: number;
  /** Names the opener, so a menu bar can keep its button lit. */
  ownerId?: string;
  /** ArrowLeft/ArrowRight at the top level. What a menu bar walks with. */
  onCycle?: (direction: -1 | 1) => void;
  /** The right-clicked node, for the `"editing"` sentinel. */
  target?: EventTarget | null;
}

interface OpenMenu extends MenuRequest {
  /** Distinguishes two opens of the same menu, so the panel state resets. */
  serial: number;
}

export interface MenuApi {
  /** Open at an explicit point. For the menu bar and for keyboard invocations. */
  openMenu: (request: MenuRequest) => void;
  /**
   * Answer a right-click: opens at the pointer and claims the event, so the
   * app-wide default does not also fire for it.
   */
  openContextMenu: (
    event: ReactMouseEvent<Element> | MouseEvent,
    items: MenuEntry[],
  ) => void;
  closeMenu: () => void;
  /** `ownerId` of the menu currently open, or null. */
  openId: string | null;
  /** Register what `"app"` and an unclaimed right-click expand to. */
  setFallback: (build: (() => MenuEntry[]) | null) => void;
}

const MenuContext = createContext<MenuApi | null>(null);

export function useMenu(): MenuApi {
  const api = useContext(MenuContext);
  if (!api) throw new Error("useMenu() used outside <MenuProvider>");
  return api;
}

/**
 * Right-clicks a pane has answered for itself.
 *
 * React attaches its listeners to the root container, so the document-level
 * default below runs afterwards and can see what was already claimed. Keyed on
 * the native event, which is unique per gesture.
 */
const claimed = new WeakSet<Event>();

const MARGIN = 6;
/** How far a submenu overlaps its parent, so the diagonal mouse path stays on it. */
const SUBMENU_OVERLAP = 4;

/**
 * How long a fresh menu ignores mouse-up, in ms.
 *
 * The release of the very click that opened the menu can land on a row — a menu
 * that flipped upwards to fit on screen puts one right under the pointer — and
 * activating it would be an item nobody chose. Past this, releasing does
 * activate, so press-drag-release out of the menu bar still works. GTK's own
 * menus draw the line in the same place.
 */
const ACTIVATE_DELAY_MS = 250;

export function MenuProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const serial = useRef(0);
  const fallback = useRef<(() => MenuEntry[]) | null>(null);

  const setFallback = useCallback((build: (() => MenuEntry[]) | null) => {
    fallback.current = build;
  }, []);

  const closeMenu = useCallback(() => setOpen(null), []);

  const openMenu = useCallback((request: MenuRequest) => {
    const target = request.target ?? null;
    const items = tidy(
      expand(request.items, {
        editing: () => editingEntries(target),
        app: () => fallback.current?.() ?? [],
      }),
    );
    // Nothing to offer is not a menu. Better no popup than an empty box.
    if (!items.some(isAction)) return;
    serial.current += 1;
    setOpen({ ...request, items, serial: serial.current });
  }, []);

  const openContextMenu = useCallback<MenuApi["openContextMenu"]>(
    (event, items) => {
      const native = "nativeEvent" in event ? event.nativeEvent : event;
      claimed.add(native);
      event.preventDefault();
      event.stopPropagation();
      openMenu({ items, x: native.clientX, y: native.clientY, target: native.target });
    },
    [openMenu],
  );

  useEffect(() => {
    // Capture, and unconditional: WebKit's own menu is never what was wanted
    // here, and it draws over ours when both are up.
    const suppress = (event: MouseEvent) => event.preventDefault();
    // Bubbles past React's root listener, so `claimed` is already populated.
    const unclaimed = (event: MouseEvent) => {
      if (claimed.has(event)) return;
      claimed.add(event);
      openMenu({
        items: ["editing", "separator", "app"],
        x: event.clientX,
        y: event.clientY,
        target: event.target,
      });
    };
    document.addEventListener("contextmenu", suppress, true);
    document.addEventListener("contextmenu", unclaimed);
    return () => {
      document.removeEventListener("contextmenu", suppress, true);
      document.removeEventListener("contextmenu", unclaimed);
    };
  }, [openMenu]);

  const api = useMemo<MenuApi>(
    () => ({
      openMenu,
      openContextMenu,
      closeMenu,
      openId: open?.ownerId ?? null,
      setFallback,
    }),
    [openMenu, openContextMenu, closeMenu, open?.ownerId, setFallback],
  );

  return (
    <MenuContext.Provider value={api}>
      {children}
      {open && <Surface key={open.serial} request={open} onClose={closeMenu} />}
    </MenuContext.Provider>
  );
}

/**
 * The highlighted chain.
 *
 * `path[i]` is the highlighted position at depth `i`, and a submenu at depth `i`
 * is open whenever the path runs past it. `-1` is the "open, nothing
 * highlighted" state a hover leaves behind, which is what lets ArrowDown pick up
 * from the top of a submenu the mouse opened.
 */
function Surface({ request, onClose }: { request: OpenMenu; onClose: () => void }) {
  const [path, setPath] = useState<number[]>([]);
  /** Remounted per open — the provider keys this component on the serial. */
  const openedAt = useRef(performance.now());

  const pick = useCallback(
    (item: MenuAction, at: number[]) => {
      if (item.disabled) return;
      if (item.items && item.items.length > 0) {
        setPath([...at, step(item.items, -1, 1)]);
        return;
      }
      onClose();
      item.run?.();
    },
    [onClose],
  );

  /** The mouse path, which alone has to survive the opening gesture's release. */
  const pickFromMouse = useCallback(
    (item: MenuAction, at: number[]) => {
      if (performance.now() - openedAt.current < ACTIVATE_DELAY_MS) return;
      pick(item, at);
    },
    [pick],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.ctrlKey) return;
      const level = Math.max(0, path.length - 1);
      const entries = entriesAtLevel(request.items, path, level);
      const cursor = path.length > 0 ? path[path.length - 1] : -1;
      const prefix = path.slice(0, -1);
      const take = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      if (event.key === "Escape" || event.key === "Tab") {
        take();
        if (event.key === "Escape" && path.length > 1) setPath(path.slice(0, -1));
        else onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        take();
        const next = step(entries, cursor, event.key === "ArrowDown" ? 1 : -1);
        if (next >= 0) setPath([...prefix, next]);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        take();
        const next = step(entries, event.key === "Home" ? -1 : entries.length, event.key === "Home" ? 1 : -1);
        if (next >= 0) setPath([...prefix, next]);
        return;
      }
      if (event.key === "ArrowRight") {
        take();
        const item = cursor >= 0 ? itemAt(entries, cursor) : null;
        if (item?.items?.length) {
          setPath([...path, step(item.items, -1, 1)]);
        } else if (cursor < 0) {
          const next = step(entries, -1, 1);
          if (next >= 0) setPath([...prefix, next]);
        } else {
          request.onCycle?.(1);
        }
        return;
      }
      if (event.key === "ArrowLeft") {
        take();
        if (path.length > 1) setPath(path.slice(0, -1));
        else request.onCycle?.(-1);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        const item = cursor >= 0 ? itemAt(entries, cursor) : null;
        if (!item) return;
        take();
        pick(item, path);
        return;
      }
      // Type-ahead, as in every native menu: one letter jumps to the next entry
      // that starts with it, so a long View menu is reachable without arrows.
      if (event.key.length === 1) {
        const letter = event.key.toLowerCase();
        const total = entries.length;
        for (let taken = 1; taken <= total; taken += 1) {
          const at = (((cursor + taken) % total) + total) % total;
          const item = itemAt(entries, at);
          if (item?.label.toLowerCase().startsWith(letter)) {
            take();
            setPath([...prefix, at]);
            return;
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [path, request, onClose, pick]);

  useEffect(() => {
    /** The click that dismisses a menu is swallowed, as a native menu does. */
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".menu-panel, .menu-bar")) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const onWheel = (event: WheelEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".menu-panel")) return;
      onClose();
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("wheel", onWheel, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <Panel
      entries={request.items}
      level={0}
      path={path}
      x={request.x}
      y={request.y}
      onHover={setPath}
      onPick={pickFromMouse}
    />
  );
}

/* ---------- one popup ---------- */

interface PanelProps {
  entries: MenuEntry[];
  level: number;
  path: number[];
  x: number;
  y: number;
  /** Left edge a submenu flips to when it would run off the right of the screen. */
  flipTo?: number;
  onHover: (path: number[]) => void;
  onPick: (item: MenuAction, path: number[]) => void;
}

function Panel({ entries, level, path, x, y, flipTo, onHover, onPick }: PanelProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const rows = useRef(new Map<number, HTMLDivElement>());
  const [placed, setPlaced] = useState<{ x: number; y: number } | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number; flipTo: number } | null>(null);

  const cursor = path.length > level ? path[level] : -1;
  const openIndex = path.length > level + 1 ? path[level] : -1;
  const openItem = openIndex >= 0 ? itemAt(entries, openIndex) : null;

  // Measure, then move: a menu opened near the right or bottom edge has to know
  // its own size before it can decide where its corner goes.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const limitX = window.innerWidth - MARGIN;
    const limitY = window.innerHeight - MARGIN;
    const overflowX = x + width > limitX;
    setPlaced({
      x: Math.max(MARGIN, overflowX ? (flipTo === undefined ? limitX - width : flipTo - width) : x),
      y: Math.max(MARGIN, y + height > limitY ? limitY - height : y),
    });
  }, [x, y, flipTo, entries]);

  // The submenu hangs off its parent row, so it needs that row's box — which
  // only exists after the parent panel has been laid out and positioned.
  useLayoutEffect(() => {
    const row = openIndex >= 0 ? rows.current.get(openIndex) : undefined;
    if (!row || !openItem?.items) {
      setAnchor(null);
      return;
    }
    const rect = row.getBoundingClientRect();
    setAnchor({
      x: rect.right - SUBMENU_OVERLAP,
      y: rect.top - 4,
      flipTo: rect.left + SUBMENU_OVERLAP,
    });
  }, [openIndex, openItem, placed]);

  return (
    <>
      <div
        className="menu-panel"
        ref={box}
        role="menu"
        // A right-click inside a menu is not a request for another menu: claim
        // it here or the document-level default would replace this one.
        onContextMenu={(event) => event.preventDefault()}
        style={{
          left: placed?.x ?? x,
          top: placed?.y ?? y,
          // The measuring pass must not be visible as a jump.
          visibility: placed ? "visible" : "hidden",
        }}
      >
        {entries.map((entry, index) => {
          if (entry === "separator") return <div className="menu-sep" key={`sep-${index}`} />;
          if (isHeader(entry)) {
            return (
              <div className="menu-header" key={`head-${index}`}>
                {entry.header}
              </div>
            );
          }
          if (!isAction(entry)) return null;
          const submenu = Boolean(entry.items && entry.items.length > 0);
          return (
            <div
              key={`${entry.label}-${index}`}
              className="menu-row"
              role="menuitem"
              ref={(element) => {
                if (element) rows.current.set(index, element);
                else rows.current.delete(index);
              }}
              data-cursor={cursor === index}
              data-disabled={entry.disabled || undefined}
              data-danger={entry.danger || undefined}
              onMouseEnter={() => {
                if (entry.disabled) {
                  onHover(path.slice(0, level));
                  return;
                }
                const prefix = path.slice(0, level);
                onHover(submenu ? [...prefix, index, -1] : [...prefix, index]);
              }}
              // Primary button only, and on release: a right-click on a row must
              // not activate it, and neither must the release of the click that
              // opened the menu (see ACTIVATE_DELAY_MS).
              onMouseUp={(event) => {
                if (event.button !== 0 || submenu) return;
                onPick(entry, [...path.slice(0, level), index]);
              }}
            >
              {entry.checked === undefined ? null : (
                <span className="menu-check">{entry.checked ? "✓" : ""}</span>
              )}
              <span className="menu-label">{entry.label}</span>
              {entry.accelerator && <span className="menu-accel">{entry.accelerator}</span>}
              {submenu && <span className="menu-arrow">›</span>}
            </div>
          );
        })}
      </div>
      {openItem?.items && anchor && (
        <Panel
          entries={openItem.items}
          level={level + 1}
          path={path}
          x={anchor.x}
          y={anchor.y}
          flipTo={anchor.flipTo}
          onHover={onHover}
          onPick={onPick}
        />
      )}
    </>
  );
}
