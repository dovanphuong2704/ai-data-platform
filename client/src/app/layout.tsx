import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import LocaleProvider from "@/components/locale-provider";

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
  const locale = await getLocale();

  return (
    <html lang={locale} className="dark" suppressHydrationWarning>
      <body className={`${inter.variable} h-full antialiased`} suppressHydrationWarning>
        <NextIntlClientProvider>
          <LocaleProvider />
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
