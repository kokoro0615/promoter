// App shell: hash router over the role views. Routes:
//   #/login      — dev login, email-link sign-in, email bind + TOTP panel
//   #/promoter   — guest registration, notifications, own performance
//   #/kiosk      — shared device: pair, PIN unlock, entrance/tickets/POS
//   #/admin      — store console: events..settings tabs
//   #/platform   — SaaS operator console (platform operators only)
//   #/book/:slug — unauthenticated public booking page (no nav chrome)
import { useCallback, useEffect, useState } from 'react';
import { call } from './api.js';
import { Login } from './views/login.js';
import { Promoter } from './views/promoter.js';
import { Kiosk } from './views/kiosk.js';
import { Admin } from './views/admin.js';
import { Platform } from './views/platform.js';
import { PublicBook } from './views/publicbook.js';
import type { Me } from './ui.js';

const NAV = ['promoter', 'kiosk', 'admin', 'platform'] as const;
type NavRoute = (typeof NAV)[number];
type Route = 'login' | 'book' | NavRoute;
const routeOf = (): { route: Route; slug: string } => {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('book/')) return { route: 'book', slug: h.slice(5) };
  return {
    route: (NAV as readonly string[]).includes(h) ? h as NavRoute : 'login',
    slug: '',
  };
};

export function App() {
  const [{ route, slug }, setLoc] = useState(routeOf());
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(() => {
    call<Me>('GET', '/me').then(setMe).catch(() => setMe({}));
  }, []);
  useEffect(() => {
    const on = () => setLoc(routeOf());
    addEventListener('hashchange', on);
    refresh();
    return () => removeEventListener('hashchange', on);
  }, [refresh]);

  // The public booking form is unauthenticated — render it bare.
  if (route === 'book') {
    return <main><PublicBook slug={slug} /></main>;
  }

  const member = me?.memberships?.find((m) => m.status === 'ACTIVE') ?? null;
  return <>
    <nav>
      <a href="#/login" className={route === 'login' ? 'active' : ''}>Login</a>
      {member && <>
        <a href="#/promoter" className={route === 'promoter' ? 'active' : ''}>Promoter</a>
        <a href="#/admin" className={route === 'admin' ? 'active' : ''}>Admin</a>
      </>}
      <a href="#/kiosk" className={route === 'kiosk' ? 'active' : ''}>Kiosk</a>
      {me?.user_id &&
        <a href="#/platform" className={route === 'platform' ? 'active' : ''}>Platform</a>}
      {me?.display_name && <span className="dim" style={{ padding: '8px 0' }}>{me.display_name}</span>}
    </nav>
    <main>
      {route === 'login' && <Login me={me} onChange={refresh} />}
      {route === 'promoter' && <Promoter member={member} />}
      {route === 'kiosk' && <Kiosk />}
      {route === 'admin' && <Admin member={member} />}
      {route === 'platform' && <Platform me={me} />}
    </main>
  </>;
}
