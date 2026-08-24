import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initStore } from "./lib/persist";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

// Before the first render, because every pane reads its stored state in a
// `useState` initialiser and a migration has to have happened by then.
initStore();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
