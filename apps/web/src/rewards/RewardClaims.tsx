import type { JSX } from 'react';
import { captionStyle, controlStyle, panelStyle, readoutStyle } from '../hud/styles.js';
import type { ClaimEntryView } from './claims-view.js';
import { claimCopy } from './reward-view.js';

/**
 * Published rewards the wallet can claim (§35.4, §35.6).
 *
 * One row per published distribution with an allocation for this wallet. A
 * claimed one says so; one the chain could not confirm either way offers no
 * button, because a claim sent for an already-claimed reward only reverts.
 */
export interface RewardClaimsData {
  readonly entries: readonly ClaimEntryView[];
  readonly onClaim: (distributionId: string) => void;
}

export function RewardClaims({ data }: { readonly data: RewardClaimsData }): JSX.Element {
  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-3)' }}>
      <div style={captionStyle}>PUBLISHED REWARDS</div>
      {data.entries.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--pw-text-2)' }}>
          No published distribution has an allocation for this wallet yet. Allocations appear here
          once a distribution is published on Robinhood Chain.
        </div>
      ) : (
        data.entries.map((entry) => (
          <ClaimRow key={entry.distributionId} entry={entry} onClaim={data.onClaim} />
        ))
      )}
    </div>
  );
}

function ClaimRow({
  entry,
  onClaim,
}: {
  readonly entry: ClaimEntryView;
  readonly onClaim: (distributionId: string) => void;
}): JSX.Element {
  const status =
    entry.status === 'CLAIMED'
      ? { headline: 'CLAIMED ✓', detail: null, actionable: false }
      : entry.status === 'UNKNOWN'
        ? {
            headline: 'STATUS NOT READ',
            detail: 'Robinhood Chain did not answer. Open this page again to check.',
            actionable: false,
          }
        : claimCopy(entry.status);

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--pw-space-3)',
        borderTop: '1px solid var(--pw-border-1)',
        paddingTop: 'var(--pw-space-3)',
      }}
    >
      <div style={{ display: 'grid', gap: 'var(--pw-space-1)' }}>
        <div style={captionStyle}>{entry.label}</div>
        <div className="pw-tabular" style={{ ...readoutStyle, fontSize: 18 }}>
          {entry.amount}
        </div>
      </div>
      <div style={{ display: 'grid', gap: 'var(--pw-space-1)', justifyItems: 'end' }}>
        <div
          style={{
            ...readoutStyle,
            fontSize: 13,
            color:
              entry.status === 'FAILED'
                ? 'var(--pw-danger)'
                : entry.status === 'CLAIMED'
                  ? 'var(--pw-accent)'
                  : 'var(--pw-text-1)',
          }}
        >
          {status.headline}
        </div>
        {status.detail === null ? null : (
          <div
            style={{ fontSize: 12, color: 'var(--pw-text-2)', maxWidth: 320, textAlign: 'right' }}
          >
            {status.detail}
          </div>
        )}
        {entry.failure === null ? null : (
          <div
            style={{ fontSize: 12, color: 'var(--pw-text-2)', maxWidth: 320, textAlign: 'right' }}
          >
            {entry.failure}
          </div>
        )}
        {status.actionable ? (
          <button
            type="button"
            style={controlStyle}
            onClick={() => {
              onClaim(entry.distributionId);
            }}
          >
            {entry.status === 'FAILED' ? 'TRY AGAIN' : 'CLAIM'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
