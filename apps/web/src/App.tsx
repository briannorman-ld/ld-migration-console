import { Suspense, useEffect, useState } from 'react';
import { DEMO_WORKSPACE_ID, stopStaleDemoMock } from './lib/demo.ts';
import { lazyNamed, ScreenFallback } from './screens/lazy.tsx';
import { StartScreen } from './screens/StartScreen.tsx';

/**
 * The workspace shell carries the mapper, planner, executor and the LD client, most of the
 * bundle; the start screen needs none of it. It is fetched as soon as the start screen has
 * painted, so opening a workspace from there does not wait on the network.
 */
const loadWorkspace = () => import('./screens/WorkspaceScreen.tsx');
const WorkspaceScreen = lazyNamed(loadWorkspace, 'WorkspaceScreen');

export type Route = { screen: 'start' } | { screen: 'workspace'; workspaceId: string };

/**
 * The open workspace lives in the URL hash (`#/w/<id>`), so a refresh or a bookmark lands back in
 * it instead of on the start screen. Only the workspace id goes there: tokens never do, and the
 * hash is never sent to a server. LD and StatSig keys are memory-only, so after a refresh the
 * workspace reopens disconnected until the keys are entered again (PLAN §3.4).
 */
export function routeFromHash(hash: string): Route {
  const m = /^#\/w\/([A-Za-z0-9._-]+)$/.exec(hash);
  return m ? { screen: 'workspace', workspaceId: decodeURIComponent(m[1]!) } : { screen: 'start' };
}

export function hashForRoute(route: Route): string {
  return route.screen === 'workspace' ? `#/w/${encodeURIComponent(route.workspaceId)}` : '#/';
}

export function App() {
  const [route, setRouteState] = useState<Route>(() => routeFromHash(window.location.hash));
  const setRoute = (r: Route) => {
    setRouteState(r);
    const next = hashForRoute(r);
    if (window.location.hash !== next) window.history.pushState(null, '', next);
  };
  // A leftover demo service worker shouldn't front a real workspace's API calls.
  useEffect(() => {
    const r = routeFromHash(window.location.hash);
    if (!(r.screen === 'workspace' && r.workspaceId === DEMO_WORKSPACE_ID)) void stopStaleDemoMock();
  }, []);
  // Prefetch the shell once the start screen has painted (a workspace route renders it anyway).
  useEffect(() => {
    void loadWorkspace();
  }, []);
  useEffect(() => {
    const onChange = () => setRouteState(routeFromHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    window.addEventListener('popstate', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
      window.removeEventListener('popstate', onChange);
    };
  }, []);
  if (route.screen === 'workspace')
    return (
      <Suspense fallback={<ScreenFallback />}>
        <WorkspaceScreen workspaceId={route.workspaceId} onExit={() => setRoute({ screen: 'start' })} />
      </Suspense>
    );
  return <StartScreen onOpen={(workspaceId) => setRoute({ screen: 'workspace', workspaceId })} />;
}
