"use client";

import { createContext, useCallback, useContext, useState } from "react";
import type { RailData } from "@/server/rail";

// A tiny shared refresh signal for the signed-in shell. The rail and the file
// list live in separate route segments (layout vs page), so when an upload
// settles the uploader calls refresh() and every subscriber re-fetches its own
// data — the rail's Storage Usage updates without a page reload (spec 0004
// AC-10). `version` bumps on every refresh; consumers key an effect off it.
interface AppDataValue {
  version: number;
  refresh: () => void;
  initialRail: RailData | null;
}

const AppDataContext = createContext<AppDataValue | null>(null);

export function AppDataProvider({
  initialRail,
  children,
}: {
  initialRail: RailData | null;
  children: React.ReactNode;
}) {
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  return (
    <AppDataContext.Provider value={{ version, refresh, initialRail }}>
      {children}
    </AppDataContext.Provider>
  );
}

export function useAppData(): AppDataValue {
  const ctx = useContext(AppDataContext);
  if (!ctx) {
    throw new Error("useAppData must be used within an AppDataProvider");
  }
  return ctx;
}
