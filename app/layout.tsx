import "./globals.css";
import ChatWidget from "@/components/ChatWidget";

export const metadata = {
  title: "RFP AI Generator — Minimal UI",
  description: "Upload a file and generate a DOCX report",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#f8f9fa",
          color: "#222",
          fontFamily: "system-ui, sans-serif",
          position: "relative",
          minHeight: "100vh",
        }}
      >
        {children}
        {/* 🟢 Collapsible floating chat widget */}
        <ChatWidget />
      </body>
    </html>
  );
}
