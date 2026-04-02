import createMiddleware from 'next-intl/middleware';
import { routing } from './src/i18n/routing';

const intlMiddleware = createMiddleware(routing);

export default intlMiddleware;

export const config = {
  // Bắt tất cả path ngoại trừ file tĩnh và API
  matcher: [
    '/((?!api|_next|_vercel|.*\\..*).*)'
  ]
};
