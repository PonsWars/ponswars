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
export function WalletSummary(): JSX.Element {
  const wallet = useSession((state) => state.wallet);

  if (wallet === null) {
    return (
      <div style={panelStyle}>
        <div style={captionStyle}>WALLET</div>
        <div style={{ fontFamily: 'var(--pw-font-display)', fontSize: 13 }}>NOT CONNECTED</div>
      </div>
    );
  }

  return (
    <div style={{ ...panelStyle, display: 'flex', gap: 'var(--pw-space-4)' }}>
      <Field caption="WALLET" value={wallet.addressFragment} />
      <Field caption="$WAR" value={wallet.warBalance} />
      <Field caption="WP" value={String(wallet.warPoints)} />
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
