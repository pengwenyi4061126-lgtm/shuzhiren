import type { Metadata } from "next";
import "./styles.css";
import "./desktop.css";
import { AppSidebar } from "@/components/app-sidebar";

// Every route renders per request so that Next.js can apply the proxy's CSP
// nonce to its scripts; a prerendered page (including the 404 page) would ship
// scripts without it.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shuzhiren Studio",
  description: "Digital-human live operations control plane"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="platform-shell">
          <AppSidebar />
          <div className="platform-main">{children}</div>
        </div>
      </body>
    </html>
  );
}
