import createMiddleware from 'next-intl/middleware';

export default createMiddleware({
  locales: ['en', 'vi'],
  defaultLocale: 'en',
  localeDetection: true,
});

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)',
  ],
};
