import "../components/arc/foundation.css";
import React, { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { S, render, startUi } from "./ui";
import {
  viewHead,
  viewMain,
  viewFoot,
  ExportConfirmation,
  ExportProgress,
} from "./views";

const root = createRoot(document.getElementById("app")!);

// Figma supplies its theme as a class; Arc reads the equivalent data attribute.
const syncTheme = () => {
  document.documentElement.dataset.theme =
    document.documentElement.classList.contains("figma-dark")
      ? "dark"
      : "light";
};
syncTheme();
new MutationObserver(syncTheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["class"],
});

function App() {
  const routeKey = `${S.route}/${S.sheet}/${S.checkTab}`;
  useLayoutEffect(() => {
    document.getElementById("view")!.scrollTop = 0;
  }, [routeKey]);
  return (
    <>
      <div className="plugin-shell" inert={S.busy || undefined}>
        <header id="head">{viewHead()}</header>
        <main id="view">{viewMain()}</main>
        <footer id="foot">{viewFoot()}</footer>
      </div>
      <ExportConfirmation
        open={S.confirmOpen}
        onOpenChange={(open) => {
          S.confirmOpen = open;
          render();
        }}
      />
      {S.busy && (
        <div className="busy-overlay">
          <ExportProgress message={S.progressMessage} value={S.progressValue} />
        </div>
      )}
      <input type="file" id="file-icc" accept=".icc,.icm" multiple hidden />
    </>
  );
}

export function renderApp() {
  root.render(<App />);
}

startUi();
