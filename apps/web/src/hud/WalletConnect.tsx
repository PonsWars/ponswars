import { useState, type JSX } from 'react';
import { useWalletSessionContext } from '../live/WalletSessionContext.js';
import { captionStyle, controlStyle } from './styles.js';

/**
 * Connecting a wallet, from the bar (§42.2, §45.2, §68.2).
 *
 * Small on purpose. §42.1 keeps the world the hero and §42.2 rejects a sidebar
 * at the global view, so this is one control and one line of state — the full
 * account surface is the war room (§34), not the bar over the world.
 *
 * §5 is the reason it is a button rather than a gate. Watching needs no wallet,
 * so nothing here blocks anything: it offers, and a visitor who never presses
 * it sees the whole world.
 */
export function WalletConnect({
  compact = false,
}: {
  /**
   * One line, for a narrow bar. The explanatory sentence moves into the
   * element's title: on a phone it wrapped to three lines and made the bar the
   * tallest thing over the world.
   */
  readonly compact?: boolean;
}): JSX.Element {
  const session = useWalletSessionContext();
  const [busy, setBusy] = useState(false);

  const run = (action: () => Promise<void>) => () => {
    // A second click while the wallet is showing its own prompt would open a
    // second prompt behind the first, which most wallets answer by rejecting
    // both.
    if (busy) {
      return;
    }
    setBusy(true);
    void action().finally(() => {
      setBusy(false);
    });
  };

  switch (session.status.kind) {
    case 'UNAVAILABLE':
      return (
        <Line
          caption="WALLET"
          value="NO WALLET"
          // Not an error and not a dead end: §5 makes watching the whole
          // product. The sentence says what is missing without suggesting the
          // visitor has done something wrong.
          detail="Install a browser wallet to play. Watching needs none."
          compact={compact}
        />
      );

    case 'DISCONNECTED':
      return (
        <button type="button" onClick={run(session.connect)} style={buttonStyle} disabled={busy}>
          CONNECT WALLET
        </button>
      );

    case 'CONNECTING':
      return <Line caption="WALLET" value={stepLabel(session.status.step)} />;

    case 'CONNECTED':
      return (
        <button
          type="button"
          onClick={run(session.disconnect)}
          style={buttonStyle}
          disabled={busy}
          // The address is in the HUD's wallet panel; this says what pressing
          // does. A button labelled with an address does not look like one that
          // signs out.
          title={session.status.wallet}
        >
          SIGN OUT
        </button>
      );

    case 'REFUSED':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--pw-space-2)' }}>
          <Line
            caption="WALLET"
            value="NOT CONNECTED"
            detail={session.status.nextStep}
            compact={compact}
          />
          <button type="button" onClick={run(session.connect)} style={buttonStyle} disabled={busy}>
            RETRY
          </button>
        </div>
      );
  }
}

/** What the wallet is doing, in the player's terms rather than the protocol's. */
function stepLabel(step: 'WALLET' | 'SIGNATURE' | 'SESSION'): string {
  switch (step) {
    case 'WALLET':
      return 'OPENING WALLET…';
    case 'SIGNATURE':
      return 'CHECK YOUR WALLET…';
    case 'SESSION':
      return 'SIGNING IN…';
  }
}

function Line({
  caption,
  value,
  detail,
  compact = false,
}: {
  readonly caption: string;
  readonly value: string;
  readonly detail?: string;
  readonly compact?: boolean;
}): JSX.Element {
  return (
    <div
      style={{ minWidth: 0, textAlign: compact ? 'right' : undefined }}
      title={compact ? detail : undefined}
    >
      <div style={captionStyle}>{caption}</div>
      <div style={{ fontFamily: 'var(--pw-font-display)', fontSize: 13 }}>{value}</div>
      {detail === undefined || compact ? null : (
        <div style={{ ...captionStyle, letterSpacing: 0, maxWidth: 220 }}>{detail}</div>
      )}
    </div>
  );
}

const buttonStyle = {
  ...controlStyle,
  padding: 'var(--pw-space-2) var(--pw-space-3)',
  fontFamily: 'var(--pw-font-display)',
  fontSize: 12,
  letterSpacing: '0.08em',
  whiteSpace: 'nowrap' as const,
};
