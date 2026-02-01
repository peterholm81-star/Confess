/**
 * AdCard - Native-style sponsored placeholder for in-feed monetization
 * 
 * Pure presentational component - displays a minimal "Sponsored" unit.
 * Designed to feel native to the Lethe/Confess dark UI.
 * No side effects, no session management.
 */

export function AdCard() {
  return (
    <div className="ad-card">
      <span className="ad-label">Sponsored</span>
      <div className="ad-content">
        <p className="ad-main">A short break.</p>
        <p className="ad-sub">Back to confessions in a moment.</p>
      </div>
    </div>
  )
}
