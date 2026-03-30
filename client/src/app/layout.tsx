import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Data Platform",
  description: "AI-powered natural language SQL query platform",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const headersList = await headers();
  const locale = headersList.get("x-next-intl-locale") ?? "en";

  return (
    <html lang={locale} className="dark" suppressHydrationWarning>
      <body className={`${inter.variable} h-full antialiased`} suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
