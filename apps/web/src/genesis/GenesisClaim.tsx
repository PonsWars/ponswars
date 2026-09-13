import type { JSX, ReactNode } from 'react';
import { captionStyle, controlStyle, panelStyle, readoutStyle } from '../hud/styles.js';
import type { PageCopy } from '../presentation/unpublished.js';
import { GenesisReveal } from './GenesisReveal.js';
import type { GenesisView } from './genesis-view.js';

/**
 * The Genesis page for a signed-in wallet (§6, §27.2, §27.3).
 *
 * One request per wallet, ever, so the page is plain about each state it can be
 * in: what the wallet needs, what it is waiting on, and the card once it is
 * dealt. Nothing here decides anything — eligibility, the block and the card
 * are the server's.
 */
export interface GenesisPageData {
  readonly view: GenesisView;
  /** Asks for the card; `null` where asking is not possible (a preview). */
  readonly request: (() => void) | null;
  readonly requesting: boolean;
  /** Why the last request failed, in the player's terms. */
  readonly requestFailure: PageCopy | null;
}

export function GenesisClaim({
  page,
  onDone,
}: {
  readonly page: GenesisPageData;
  readonly onDone: () => void;
}): JSX.Element {
  const { view } = page;
  switch (view.kind) {
    case 'CARD':
      return <GenesisReveal outcome={view.outcome} onDone={onDone} />;

    case 'UNPUBLISHED':
      return (
        <Panel caption="GENESIS" headline="THIS SERVER CANNOT DEAL A GENESIS CARD">
          <Body>
            A Genesis Card is dealt from a finalized Robinhood Chain block, and this server does not
            read the chain. Watching and picking work without a card.
          </Body>
        </Panel>
      );

    case 'OFFER':
      return (
        <Panel caption="GENESIS" headline="OPEN YOUR GENESIS CARD">
          <Body>
            A wallet holding at least 1,000,000 $WAR opens one Genesis Card — once, forever. The
            card is dealt from a Robinhood Chain block that does not exist yet when you ask, so
            nobody can choose it, and it is revealed once that block is final.
          </Body>
          {page.request === null ? null : (
            <button
              type="button"
              onClick={page.request}
              disabled={page.requesting}
              style={{ ...controlStyle, justifySelf: 'start' }}
            >
              {page.requesting ? 'CHECKING YOUR $WAR…' : 'OPEN MY GENESIS CARD'}
            </button>
          )}
          <RequestFailure copy={page.requestFailure} />
        </Panel>
      );

    case 'NOT_ELIGIBLE':
      return (
        <Panel caption="GENESIS" headline="NOT ELIGIBLE YET">
          <div style={{ display: 'flex', gap: 'var(--pw-space-5)', flexWrap: 'wrap' }}>
            <Figure caption="$WAR HELD" value={view.balance} />
            <Figure caption="NEEDED" value={view.threshold} />
          </div>
          <Body>
            Genesis opens for a wallet holding at least {view.threshold} $WAR right now. Nothing was
            recorded, so you can ask again once this wallet holds enough.
          </Body>
          {page.request === null ? null : (
            <button
              type="button"
              onClick={page.request}
              disabled={page.requesting}
              style={{ ...controlStyle, justifySelf: 'start' }}
            >
              {page.requesting ? 'CHECKING YOUR $WAR…' : 'CHECK AGAIN'}
            </button>
          )}
          <RequestFailure copy={page.requestFailure} />
        </Panel>
      );

    case 'SEALING':
      return (
        <Panel caption="GENESIS" headline="SEALING YOUR CARD ON ROBINHOOD CHAIN" busy>
          <Figure caption="ROBINHOOD CHAIN BLOCK" value={`#${String(view.targetBlock)}`} />
          <Body>
            Your card is bound to this block and will be dealt from its hash once the block is
            finalized. That usually takes a few minutes — often around twenty. Nothing about your
            card can change while you wait, and this page checks on its own.
          </Body>
        </Panel>
      );

    case 'RESERVING':
      return (
        <Panel caption="GENESIS" headline="YOUR REWARD IS BEING RESERVED" busy>
          <Body>
            Your card is decided, and its reward is being reserved before it is revealed. This page
            will show it once the reservation is confirmed.
          </Body>
        </Panel>
      );
  }
}

function Panel({
  caption,
  headline,
  busy = false,
  children,
}: {
  readonly caption: string;
  readonly headline: string;
  readonly busy?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      role={busy ? 'status' : undefined}
      aria-busy={busy || undefined}
      style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-3)', maxWidth: 560 }}
    >
      <div style={captionStyle}>{caption}</div>
      <h2 style={{ ...readoutStyle, margin: 0, fontSize: 18 }}>{headline}</h2>
      {children}
    </div>
  );
}

function Body({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <p style={{ margin: 0, color: 'var(--pw-text-2)', fontSize: 13, lineHeight: 1.55 }}>
      {children}
    </p>
  );
}

function Figure({
  caption,
  value,
}: {
  readonly caption: string;
  readonly value: string;
}): JSX.Element {
  return (
    <div>
      <div style={captionStyle}>{caption}</div>
      <div className="pw-tabular" style={{ ...readoutStyle, fontSize: 20 }}>
        {value}
      </div>
    </div>
  );
}

function RequestFailure({ copy }: { readonly copy: PageCopy | null }): JSX.Element | null {
  if (copy === null) {
    return null;
  }
  return (
    <div role="alert" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--pw-warning)' }}>
      <strong>{copy.headline}</strong> {copy.body}
    </div>
  );
}
