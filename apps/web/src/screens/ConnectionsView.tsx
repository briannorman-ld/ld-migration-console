import type { ReactNode } from 'react';
import type { CanonicalSnapshot } from '@sslm/canonical';
import { LD_INSTANCES } from '@sslm/ld-client';
import type { SourceRecord, WorkspaceRecord } from '@sslm/store';
import { LdMark } from '../components/Brand.tsx';
import { Badge, Button, Card, cx, Dot, PageTitle, Spinner, type Tone } from '../components/ui.tsx';
import { useFlag } from '../lib/flags.ts';
import type { LdSession } from '../lib/ld.ts';
import { SOURCE_BADGE, uploadable } from '../lib/kinds.ts';
import { timeAgo } from '../lib/time.ts';

/**
 * The landing page of a workspace: one place to connect StatSig (the sources we read) and one to
 * connect LaunchDarkly (the single project we write to). A new workspace opens here, and it stays
 * reachable from the nav as "Connections". Each card shows live status and hands off to the
 * existing forms (AddSource, LdPanel) rather than duplicating them.
 */
export function ConnectionsView({
  workspace,
  sources,
  snapshots,
  ld,
  onAddSource,
  onRemoveSource,
  onReuploadSource,
  onOpenLd,
  onOpenGates,
}: {
  workspace: WorkspaceRecord;
  sources: SourceRecord[];
  snapshots: Record<string, CanonicalSnapshot | undefined>;
  ld: LdSession;
  onAddSource: () => void;
  onRemoveSource: (source: SourceRecord) => void | Promise<void>;
  /** A newer file for an uploaded source (StatSig config spec or PostHog flags payload) replaces its snapshot. */
  onReuploadSource?: (source: SourceRecord, file: File) => void | Promise<void>;
  onOpenLd: () => void;
  onOpenGates: () => void;
}) {
  const posthogOn = useFlag('posthogSource');
  const synced = sources.filter((s) => snapshots[s.id]);
  const statsigDone = synced.length > 0;
  const ldDone = ld.status === 'connected' && !!ld.projectKey;

  return (
    <div className="max-w-4xl space-y-5">
      <PageTitle eyebrow="Get started">{workspace.name}</PageTitle>
      <p className="max-w-2xl text-sm text-fg-muted">
        A workspace reads one or more source projects (StatSig, or another LaunchDarkly project) and writes to one LaunchDarkly project. Connect both to compare them
        side by side. Tokens stay in this tab’s memory (or encrypted on this device, if you choose to remember them) and are sent only to the source and target APIs; nothing is
        ever written to a source.
      </p>

      <div className="grid gap-5 md:grid-cols-2">
        <ConnectionCard
          step={1}
          title="Sources"
          icon={<StatsigGlyph />}
          done={statsigDone}
          action={
            <Button variant={sources.length === 0 ? 'primary' : 'secondary'} onClick={onAddSource}>
              {sources.length === 0 ? 'Connect a source' : '+ Add another source'}
            </Button>
          }
          status={
            sources.length === 0 ? (
              <StatusLine tone="slate">Not connected</StatusLine>
            ) : (
              <StatusLine tone={statsigDone ? 'green' : 'amber'}>
                {sources.length} {sources.length === 1 ? 'source' : 'sources'}
                {statsigDone ? '' : ' · waiting for the first sync'}
              </StatusLine>
            )
          }
        >
          {sources.length === 0 ? (
            <p className="text-sm text-fg-muted">
              Read a StatSig project with a <b>read-only Console API key</b> or an uploaded <b>config spec</b>, or attach <b>another LaunchDarkly project</b> with a read
              token{posthogOn && <>, or read a <b>PostHog project</b> with a personal API key or an uploaded flags payload</>}. Add more than one source to consolidate
              several projects into the same LaunchDarkly project.
            </p>
          ) : (
            <ul className="space-y-2">
              {sources.map((s) => {
                const sn = snapshots[s.id];
                return (
                  <li key={s.id} className="flex items-center gap-3 rounded-md border border-line-soft px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium" title={s.label}>
                        {s.label}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-fg-muted">
                        <Badge tone={SOURCE_BADGE[s.kind].tone}>{SOURCE_BADGE[s.kind].label}</Badge>
                        {sn ? <span title={new Date(sn.takenAt).toLocaleString()}>synced {timeAgo(sn.takenAt)}</span> : <span>not synced yet</span>}
                      </div>
                    </div>
                    {uploadable(s) && onReuploadSource && (
                      <label className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg" title={`Replace the ${SOURCE_BADGE[s.kind].label.toLowerCase()} with a newer export`}>
                        Upload a new file
                        <input
                          type="file"
                          accept="application/json,.json"
                          className="sr-only"
                          aria-label={`Upload a new file for ${s.label}`}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = '';
                            if (file) void onReuploadSource(s, file);
                          }}
                        />
                      </label>
                    )}
                    <Button
                      variant="ghost"
                      className="shrink-0 px-2 py-1 text-xs hover:text-error"
                      title="Remove this source and everything read from it"
                      aria-label={`Remove ${s.label}`}
                      onClick={() => void onRemoveSource(s)}
                    >
                      Remove
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </ConnectionCard>

        <ConnectionCard
          step={2}
          title="LaunchDarkly"
          icon={<LdMark className="h-5 w-5 text-logo" />}
          done={ldDone}
          action={
            <Button variant={ld.status === 'connected' ? 'secondary' : 'primary'} onClick={onOpenLd} disabled={ld.status === 'connecting'}>
              {ld.status === 'connected' ? (ld.projectKey ? 'Manage connection' : 'Choose a project') : 'Connect LaunchDarkly'}
            </Button>
          }
          status={
            ld.status === 'connecting' ? (
              <span className="flex items-center gap-2 text-sm text-fg-muted">
                <Spinner /> Connecting…
              </span>
            ) : ld.status === 'connected' ? (
              <StatusLine tone={ldDone ? 'green' : 'amber'}>
                Connected to {LD_INSTANCES[ld.instance ?? 'us'].label}
                {ld.projectKey ? '' : ' · choose a project'}
              </StatusLine>
            ) : ld.status === 'error' ? (
              <StatusLine tone="red">Connection failed</StatusLine>
            ) : (
              <StatusLine tone="slate">Not connected</StatusLine>
            )
          }
        >
          {ld.status === 'connected' ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {ld.projectKey ? (
                <>
                  <span className="text-fg-muted">Target project</span>
                  <Badge tone="blue">{ld.projectKey}</Badge>
                </>
              ) : (
                <span className="text-fg-muted">Pick the project this workspace migrates into.</span>
              )}
              {ld.matrix && <Badge>{ld.matrix.capabilities.filter((c) => c.status === 'available').length} capabilities available</Badge>}
              {ld.probing && (
                <span className="flex items-center gap-1.5 text-xs text-fg-muted">
                  <Spinner /> {ld.probing}
                </span>
              )}
            </div>
          ) : (
            <p className="text-sm text-fg-muted">
              Connect with an <b>access token</b> (a Writer service token is recommended), then choose the target project. Capabilities and permissions are probed with
              read-only requests before anything is written.
            </p>
          )}
          {ld.status === 'error' && ld.error && <p className="text-sm text-error">{ld.error}</p>}
        </ConnectionCard>
      </div>

      {statsigDone && (
        <div className="flex items-center gap-3">
          <Button variant={ldDone ? 'primary' : 'secondary'} onClick={onOpenGates}>
            Open gates →
          </Button>
          {!ldDone && <span className="text-sm text-fg-muted">You can browse StatSig now; connect LaunchDarkly to see the comparison and migrate.</span>}
        </div>
      )}
    </div>
  );
}

function ConnectionCard({
  step,
  title,
  icon,
  done,
  status,
  action,
  children,
}: {
  step: number;
  title: string;
  icon: ReactNode;
  done: boolean;
  status: ReactNode;
  /** The card's one button, pinned to the bottom so the two cards' buttons line up whatever their content. */
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className={cx('flex flex-col gap-4 p-5', done && 'border-success-line/60')}>
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cx(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums',
            done ? 'bg-success-fill text-white' : 'bg-surface-2 text-fg-muted ring-1 ring-line ring-inset',
          )}
        >
          {done ? '✓' : step}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {icon}
            <h3 className="font-display text-lg font-semibold tracking-tight">{title}</h3>
          </div>
          <div className="mt-1">{status}</div>
        </div>
      </div>
      <div className="flex-1 space-y-3">{children}</div>
      <div>{action}</div>
    </Card>
  );
}

function StatusLine({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-sm">
      <Dot tone={tone} />
      <span className={cx(tone === 'red' ? 'text-error' : tone === 'amber' ? 'text-warning' : 'text-fg-muted')}>{children}</span>
    </span>
  );
}

/** Neutral placeholder glyph for StatSig; we don't ship their brand mark. */
function StatsigGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5 text-fg-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 15l4-6 4 3 6-8" />
      <path d="M3 17h14" />
    </svg>
  );
}
