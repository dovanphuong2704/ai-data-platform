import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n.ts");

const nextConfig: NextConfig = {
  /* Thêm 2 dòng này */
  basePath: '/chatdb',
  assetPrefix: '/chatdb',

  /* config options here */
};

export default withNextIntl(nextConfig);