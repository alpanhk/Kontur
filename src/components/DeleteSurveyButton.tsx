"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function DeleteSurveyButton({ id, name }: { id: number; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (!window.confirm(`Hapus survei "${name}" beserta seluruh titiknya?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/surveys/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.refresh();
    } catch {
      window.alert("Gagal menghapus survei.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
    >
      {busy ? "Menghapus…" : "Hapus"}
    </button>
  );
}
