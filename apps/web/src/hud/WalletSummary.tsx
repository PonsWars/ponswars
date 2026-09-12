import type { JSX } from 'react';
import { useSession } from '../state/session.js';
import { captionStyle, panelStyle } from './styles.js';

/**
 * The wallet fragment at the global view (§42.2).
 *
 * Address fragment, `$WAR` balance and current War Points — nothing more. §42.1
 * keeps the world the hero, and a full wallet panel at the level where the
 * player is choosing which war to watch is a sidebar §42.2 explicitly rejects.
 *
 * A disconnected wallet renders as disconnected. §42.14 wants useful sync states
 * rather than a placeholder, and a zero balance shown to someone who never
 * connected is a placeholder that reads as fact.
 */
export function WalletSummary(): JSX.Element | null {
  const wallet = useSession((state) => state.wallet);

  // Nothing at all when nobody is connected. The bar's own wallet control sits
  // beside this and already says so — two panels captioned WALLET, one saying
  // NOT CONNECTED and the other offering to connect, is the same sentence
  // twice in a bar §42.1 wants out of the way.
  if (wallet === null) {
    return null;
  }

  return (
    <div style={{ ...panelStyle, display: 'flex', gap: 'var(--pw-space-4)' }}>
      <Field caption="WALLET" value={wallet.addressFragment} />
      {/*
        An em dash rather than a zero for a figure nobody has read yet (§42.14).
        The balance needs a chain client and the RPC vendor is OPEN (§59.3); War
        Points show once the wallet's record has been read. Showing `0` to
        somebody holding a million $WAR would be a placeholder read as fact.
      */}
      <Field caption="$WAR" value={wallet.warBalance ?? '—'} />
      <Field caption="WP" value={wallet.warPoints === null ? '—' : String(wallet.warPoints)} />
    </div>
  );
}

function Field({
  caption,
  value,
}: {
  readonly caption: string;
  readonly value: string;
}): JSX.Element {
  return (
    <div>
      <div style={captionStyle}>{caption}</div>
      <div className="pw-tabular" style={{ fontSize: 13, color: 'var(--pw-text-1)' }}>
        {value}
      </div>
    </div>
  );
}
