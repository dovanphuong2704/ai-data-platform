import createMiddleware from 'next-intl/middleware';
import { routing } from './src/i18n/routing';

export default createMiddleware(routing);

export const config = {
  // Bắt root '/' + '/en/...' + '/vi/...' + các trang khác (loại trừ file tĩnh và API)
  matcher: [
    '/',
    '/(en|vi)/:path*',
    '/((?!api|_next|_vercel|.*\\..*).*)',
  ],
};
