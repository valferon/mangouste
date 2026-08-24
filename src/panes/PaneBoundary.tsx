import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

/**
 * Keeps one pane's render error from taking the workbench with it.
 *
 * React unmounts the entire tree on an uncaught render error, which is
 * unusually expensive here: chat panes stay mounted precisely so a turn keeps
 * streaming while you read another session, so without a boundary one bad frame
 * in one pane destroys every other session's pane too — the exact loss the
 * mount-forever design exists to prevent. Panes also render input nobody
 * controls: model markdown, tool JSON of any shape, diffs of any size.
 *
 * Deliberately a class. There is still no hook for this — `componentDidCatch` is
 * the only way to catch a render throw.
 */
interface Props {
  /** Names the pane in the fallback, e.g. "chat" or the file's path. */
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** Bumped by "Try again", to remount the subtree rather than reuse it. */
  attempt: number;
}

export class PaneBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The console is where a developer will look, and the component stack is the
    // half of the story the message does not carry.
    console.error(`pane "${this.props.label}" failed to render`, error, info.componentStack);
  }

  render() {
    const { error, attempt } = this.state;
    if (!error) {
      // A keyed Fragment, not a wrapper div: the panes below sit in flex chains
      // their parents set up, and an extra box in the middle breaks every one of
      // them. The key is what makes "Try again" build a fresh subtree — reusing
      // the old one hands the same broken props back and fails identically.
      return <Fragment key={attempt}>{this.props.children}</Fragment>;
    }
    return (
      <div className="pane-error">
        <div className="pane-error-head">
          <span>This pane stopped working</span>
          <span className="count">{this.props.label}</span>
        </div>
        <pre className="pane-error-message selectable">{error.message || String(error)}</pre>
        <p className="setting-hint">
          The rest of the window is unaffected, and any turn still streaming in another
          pane is unaffected too.
        </p>
        <div className="setting-row">
          <button
            className="toggle-button"
            onClick={() => this.setState({ error: null, attempt: attempt + 1 })}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
