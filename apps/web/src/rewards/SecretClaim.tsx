import type { JSX } from 'react';
import { GenesisTrophy } from '../art/GenesisTrophy.js';
import { captionStyle, controlStyle, panelStyle, readoutStyle } from '../hud/styles.js';
import type { SecretClaimView } from './secret-view.js';

/**
 * The Secret Stock Drop a wallet holds, and the claim for it (§8.5, §35.7).
 *
 * Shown only to the wallet that holds one. The reward is the vault's own
 * `REWARD_AMOUNT`, the claim is sent by the player's wallet to the vault, and
 * a claimed Secret keeps its trophy: §8.5 makes the entitlement permanent in
 * the profile rather than something that disappears once it is paid.
 */
export function SecretClaim({
  view,
  onClaim,
}: {
  readonly view: SecretClaimView;
  readonly onClaim: () => void;
}): JSX.Element {
  return (
    <div
      style={{
        ...panelStyle,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--pw-space-3)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--pw-space-3)' }}>
        <GenesisTrophy size={76} />
        <div style={{ display: 'grid', gap: 'var(--pw-space-1)' }}>
          <div style={captionStyle}>SECRET STOCK DROP</div>
          <div className="pw-tabular" style={{ ...readoutStyle, fontSize: 18 }}>
            {view.amount}
          </div>
          <div style={{ fontSize: 12, color: 'var(--pw-text-2)' }}>
            Held for this wallet in the Secret Stock Vault. It has no expiry.
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 'var(--pw-space-1)', justifyItems: 'end' }}>
        <div
          style={{
            ...readoutStyle,
            fontSize: 13,
            color:
              view.status === 'FAILED'
                ? 'var(--pw-danger)'
                : view.status === 'CLAIMED'
                  ? 'var(--pw-accent)'
                  : 'var(--pw-text-1)',
          }}
        >
          {view.headline}
        </div>
        {view.detail === null ? null : (
          <div
            style={{ fontSize: 12, color: 'var(--pw-text-2)', maxWidth: 320, textAlign: 'right' }}
          >
            {view.detail}
          </div>
        )}
        {view.actionable ? (
          <button type="button" style={controlStyle} onClick={onClaim}>
            {view.status === 'FAILED' ? 'TRY AGAIN' : 'CLAIM'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
