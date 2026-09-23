import { useMemo, type JSX } from 'react';
import { captionStyle, panelStyle, readoutStyle } from '../hud/styles.js';
import { distributionRules, earningRules } from './rewards-primer.js';

/**
 * How rewards are earned and paid (§11, §16, §35).
 *
 * `rewards-primer.ts` holds the figures, all of them read from the locked
 * constants; this draws them. It sits under whatever the page is saying —
 * including under "connect a wallet", which was one panel with half a screen
 * of nothing beneath it.
 *
 * Nothing here is a wallet's own: no amount, no share, no estimate. §30 makes
 * a promised payout the one thing a rewards page must never print.
 */
export function RewardsPrimer(): JSX.Element {
  const earning = useMemo(() => earningRules(), []);
  const distribution = useMemo(() => distributionRules(), []);

  return (
    <section style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-4)' }}>
      <div style={{ display: 'grid', gap: 'var(--pw-space-2)' }}>
        <div style={captionStyle}>HOW REWARDS WORK</div>
        <h2 style={{ ...readoutStyle, margin: 0, fontSize: 18 }}>
          WAR POINTS ARE EARNED, THEN SETTLED ON CHAIN
        </h2>
        <p style={{ margin: 0, color: 'var(--pw-text-2)', fontSize: 13, lineHeight: 1.55 }}>
          Backing a side that wins earns War Points, and the wallet that earned them claims its
          share of the pool itself. Nothing is promised in advance — a window pays what the pool
          holds when it closes.
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 'var(--pw-space-5)',
        }}
      >
        <div style={{ display: 'grid', gap: 'var(--pw-space-2)', alignContent: 'start' }}>
          <div style={captionStyle}>EARNING</div>
          {earning.map((rule) => (
            <div
              key={rule.what}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 'var(--pw-space-3)',
                alignItems: 'baseline',
                borderBottom: '1px solid var(--pw-border-1)',
                paddingBottom: 6,
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--pw-text-1)' }}>{rule.what}</span>
              <span
                className="pw-tabular"
                style={{ fontSize: 13, color: 'var(--pw-accent)', whiteSpace: 'nowrap' }}
              >
                +{rule.points} WP
              </span>
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gap: 'var(--pw-space-3)', alignContent: 'start' }}>
          <div style={captionStyle}>PAYING OUT</div>
          {distribution.map((rule) => (
            <div key={rule.title} style={{ display: 'grid', gap: 2 }}>
              <div style={{ ...captionStyle, color: 'var(--pw-text-1)' }}>{rule.title}</div>
              <div style={{ fontSize: 12, color: 'var(--pw-text-2)', lineHeight: 1.5 }}>
                {rule.detail}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
