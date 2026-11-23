"use client";

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};

function getIsFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export default function OpenNewTabButton() {
  const isFramed = useSyncExternalStore(emptySubscribe, getIsFramed, () => false);

  if (!isFramed) return null;

  return (
    <a
      href="/"
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.currentTarget.href = window.location.href;
      }}
      className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-emerald-50 hover:text-emerald-700"
      title="Buka di tab browser penuh agar unduhan tidak dibatasi iframe"
    >
      Tab Penuh ↗
    </a>
  );
}
