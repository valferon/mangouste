import { useSyncExternalStore } from "react";

import { copyText } from "../lib/editing";
import {
  currentEditorFacts,
  describeIndent,
  editorFactsVersion,
  subscribeEditorFacts,
} from "../lib/editorFacts";
import { useMenu } from "../lib/menu";

/**
 * The right-hand end of the status bar: caret, indentation, encoding, language.
 *
 * The row VSCode keeps there, and it only appears when there is a file in front
 * to describe — an editor is what produces every one of these facts, so a chat
 * tab has nothing to say in this space and says nothing.
 *
 * Subscribed to the store rather than fed by props, and that is the point:
 * `line`/`column` change on every keystroke, and taking them through `App`
 * would re-render the workbench once per character. Only this component does.
 */
export function EditorFacts() {
  const menu = useMenu();
  // The version is the snapshot; the value is read alongside it. An object
  // rebuilt per keystroke could never be a stable snapshot.
  useSyncExternalStore(subscribeEditorFacts, editorFactsVersion, editorFactsVersion);
  const facts = currentEditorFacts();
  if (!facts) return null;

  const caret = `Ln ${facts.line}, Col ${facts.column}`;
  return (
    <span
      className="status-facts"
      onContextMenu={(event) =>
        menu.openContextMenu(event, [
          { label: "Copy Cursor Position", run: () => void copyText(caret) },
          { label: "Copy File Path", run: () => void copyText(facts.path) },
        ])
      }
    >
      {/* Fixed width, so the numbers changing under the caret do not shove
          everything after them sideways on every keystroke. */}
      <span className="status-fact status-caret">{caret}</span>
      <span className="status-fact">{describeIndent(facts.indent)}</span>
      {/* Every file is read and written as UTF-8 by the Rust side, so this is a
          statement about this app rather than a detection. It is here because
          its absence from the row is more conspicuous than its presence. */}
      <span className="status-fact">UTF-8</span>
      <span className="status-fact">{facts.eol}</span>
      <span className="status-fact">{facts.language}</span>
    </span>
  );
}
