import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "./lib/ipc";
import { DashboardWindow } from "./windows/DashboardWindow";
import { PillWindow } from "./windows/PillWindow";
import { BubbleWindow } from "./windows/BubbleWindow";
import { QuickInputWindow } from "./windows/QuickInputWindow";
import { OverlayWindow } from "./windows/OverlayWindow";
import "./index.css";

type WindowRoute = "dashboard" | "pill" | "bubble" | "overlay" | "quick_input";

function AppRouter() {
  const [route, setRoute] = useState<WindowRoute>("dashboard");
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    async function determineRoute() {
      // 1. Check URL query params first: ?window=dashboard|pill|bubble|overlay|quick_input
      const urlParams = new URLSearchParams(window.location.search);
      const queryWindow = urlParams.get("window") as WindowRoute | null;

      if (queryWindow && ["dashboard", "pill", "bubble", "overlay", "quick_input"].includes(queryWindow)) {
        setRoute(queryWindow);
        setIsReady(true);
        return;
      }

      // 2. Check Tauri window label
      if (isTauri()) {
        try {
          const win = getCurrentWindow();
          const label = win.label.toLowerCase();

          if (label.includes("pill")) {
            setRoute("pill");
          } else if (label.includes("bubble")) {
            setRoute("bubble");
          } else if (label.includes("overlay")) {
            setRoute("overlay");
          } else if (label.includes("quick")) {
            setRoute("quick_input");
          } else {
            setRoute("dashboard");
          }
        } catch (e) {
          console.warn("Could not determine Tauri window label, defaulting to dashboard:", e);
          setRoute("dashboard");
        }
      } else {
        // In browser default to dashboard
        setRoute("dashboard");
      }

      setIsReady(true);
    }

    determineRoute();
  }, []);

  if (!isReady) {
    return null;
  }

  return (
    <div className="relative w-full h-full">
      {/* Dev Switcher Bar for browser testing (only shown when not running inside Tauri) */}
      {!isTauri() && (
        <div className="fixed top-2 left-2 z-[9999] flex items-center gap-1 p-1 rounded-xl bg-slate-950/95 border border-white/20 shadow-2xl backdrop-blur-md text-[11px] font-sans">
          <span className="text-[10px] text-slate-400 font-bold px-1.5 uppercase">Window:</span>
          {(["dashboard", "pill", "bubble", "overlay", "quick_input"] as WindowRoute[]).map((w) => (
            <button
              key={w}
              onClick={() => setRoute(w)}
              className={`px-2.5 py-0.5 rounded-lg font-medium transition-all ${
                route === w
                  ? "bg-sky-500 text-slate-950 font-bold shadow"
                  : "text-slate-400 hover:text-white hover:bg-white/10"
              }`}
            >
              {w}
            </button>
          ))}
        </div>
      )}

      {/* Window Render */}
      {route === "dashboard" && <DashboardWindow />}
      {route === "pill" && <PillWindow />}
      {route === "bubble" && <BubbleWindow />}
      {route === "overlay" && <OverlayWindow />}
      {route === "quick_input" && <QuickInputWindow />}
    </div>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <AppRouter />
    </React.StrictMode>
  );
}
