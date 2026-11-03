import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { Spinner } from '../components/ui.tsx';

type ComponentKeys<M> = { [K in keyof M]: M[K] extends ComponentType<any> ? K : never }[keyof M];

/**
 * `React.lazy` for a named export. The start screen and the workspace shell ship in the main
 * chunk; every other screen is fetched on first render so the first paint is not waiting on
 * screens the user may never open.
 */
export function lazyNamed<M, K extends ComponentKeys<M>>(load: () => Promise<M>, key: K): LazyExoticComponent<Extract<M[K], ComponentType<any>>> {
  return lazy(async () => ({ default: (await load())[key] as Extract<M[K], ComponentType<any>> }));
}

/** What a view area shows while its chunk downloads; the same row the shell uses while a workspace loads. */
export function ScreenFallback() {
  return (
    <div className="flex items-center gap-2 p-8 text-sm text-fg-muted">
      <Spinner /> Loading…
    </div>
  );
}

/** The dimmed overlay a modal will paint over, so the click has visible effect while the chunk downloads. */
export function ModalFallback() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6 text-fg-muted backdrop-blur-[2px]" aria-busy="true">
      <Spinner />
    </div>
  );
}
