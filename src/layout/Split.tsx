import { useCallback, useEffect, useRef, useState } from "react";

interface ResizerProps {
  /** `vertical` drags left/right (a column edge); `horizontal` drags up/down. */
  orientation: "vertical" | "horizontal";
  /** Called with the pointer delta in pixels since the last move. */
  onDelta: (delta: number) => void;
}

/**
 * A drag handle between two panes.
 *
 * Pointer capture keeps the drag alive when the cursor crosses an iframe or the
 * terminal canvas, which otherwise swallow mousemove.
 */
export function Resizer({ orientation, onDelta }: ResizerProps) {
  const last = useRef<number | null>(null);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    last.current = orientation === "vertical" ? event.clientX : event.clientY;
  }, [orientation]);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (last.current === null) return;
      const current = orientation === "vertical" ? event.clientX : event.clientY;
      onDelta(current - last.current);
      last.current = current;
    },
    [orientation, onDelta],
  );

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId);
    last.current = null;
  }, []);

  return (
    <div
      className={`resizer resizer-${orientation}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      role="separator"
      aria-orientation={orientation}
    />
  );
}

/**
 * A pixel size that survives restarts.
 *
 * Pane sizes are the one bit of layout state worth persisting; everything else
 * is derived from the workspace.
 */
export function usePersistentSize(key: string, initial: number, min: number, max: number) {
  const [size, setSize] = useState(() => {
    const stored = Number(localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? clamp(stored, min, max) : initial;
  });

  // Debounced: a drag lands one `setSize` per pointer event, and a synchronous
  // write per frame is the expensive half of resizing. The only thing lost is a
  // size the window was closed within a quarter second of.
  useEffect(() => {
    const timer = setTimeout(() => localStorage.setItem(key, String(size)), 250);
    return () => clearTimeout(timer);
  }, [key, size]);

  const resize = useCallback(
    (delta: number) => setSize((current) => clamp(current + delta, min, max)),
    [min, max],
  );

  return [size, resize, setSize] as const;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
