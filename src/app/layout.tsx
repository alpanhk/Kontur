import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import OpenNewTabButton from "@/components/OpenNewTabButton";
import "./globals.css";

export const metadata: Metadata = {
  title: "TopoKontur · Elevasi, Peta Kontur & DXF",
  description:
    "Ambil data elevasi dari garis/poligon (termasuk impor KML/KMZ Google Earth Pro), buat peta kontur, dan ekspor ke DXF/DWG dengan koordinat.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body className="bg-slate-100 text-slate-900 antialiased">
        <div className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
          <header className="sticky top-0 z-[1100] flex h-12 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4">
            <Link href="/" className="flex items-center gap-2 font-bold text-slate-900">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-emerald-600 text-xs text-white">
                TK
              </span>
              TopoKontur
            </Link>
            <nav className="flex items-center gap-4 text-sm font-medium text-slate-600">
              <Link href="/" className="hover:text-emerald-700">
                Ambil Data
              </Link>
              <Link href="/surveys" className="hover:text-emerald-700">
                Riwayat Survei
              </Link>
              <OpenNewTabButton />
            </nav>
          </header>
          <main className="flex flex-1 flex-col lg:h-[calc(100dvh-3rem)] lg:min-h-0 lg:overflow-hidden">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
