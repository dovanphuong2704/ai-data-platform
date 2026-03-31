import createMiddleware from 'next-intl/middleware';
import { routing } from './src/i18n/routing';

export default createMiddleware(routing);

export const config = {
  // Thay đổi matcher để bắt được cả root và các sub-path
  matcher: [
    // Bắt root '/'
    '/',
    // Bắt các đường dẫn có ngôn ngữ /en/... hoặc /vi/...
    '/(en|vi)/:path*',
    // Bắt tất cả các trang khác nhưng loại trừ file tĩnh và api
    '/((?!api|_next|_vercel|.*\\..*).*)'
  ]
};