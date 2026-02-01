/**
 * Lethe Session Manager v1
 * 
 * Manages anonymous sessions for metrics + monetization without user identifiers.
 * 
 * Session Rules (LOCKED):
 * - New session starts on: cold start OR foreground after >= 10 min background
 * - Session continues if backgrounded < 10 min
 * - No idle timeout while in foreground
 * 
 * Persistence (LOCKED):
 * - ONLY lastBackgroundAt is stored in localStorage (for threshold detection)
 * - All other state (sessionId, pageFetchCount, adArmed, adShown) is in-memory only
 * - Page refresh = new session (by design)
 * 
 * Monetization Rules (LOCKED):
 * - pageFetchCount increments on "next page" fetches (not initial load)
 * - When pageFetchCount reaches AD_TRIGGER_THRESHOLD, adArmed becomes true
 * - Max 1 ad per session (adShown prevents further ads)
 */

// Debug logging (dev only)
const DEBUG = import.meta.env.DEV

function log(...args: unknown[]) {
  if (DEBUG) {
    console.log('[session]', ...args)
  }
}

// Constants
const BACKGROUND_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes
const AD_TRIGGER_THRESHOLD = 4 // Page fetches before ad arms
const STORAGE_KEY_BACKGROUND = 'lethe:lastBackgroundAt'

// Session state interface (in-memory only, except lastBackgroundAt)
interface SessionState {
  sessionId: string
  pageFetchCount: number
  adArmed: boolean
  adShown: boolean
}

// In-memory state (source of truth during runtime)
let state: SessionState = {
  sessionId: '',
  pageFetchCount: 0,
  adArmed: false,
  adShown: false,
}

/**
 * Generate a random session ID (UUID-like)
 */
function generateSessionId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * Get lastBackgroundAt from localStorage
 */
function getLastBackgroundAt(): number | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_BACKGROUND)
    if (stored) {
      const ts = parseInt(stored, 10)
      return Number.isNaN(ts) ? null : ts
    }
  } catch {
    // localStorage may be unavailable
  }
  return null
}

/**
 * Set lastBackgroundAt in localStorage
 */
function setLastBackgroundAt(timestamp: number): void {
  try {
    localStorage.setItem(STORAGE_KEY_BACKGROUND, String(timestamp))
  } catch {
    // localStorage may be unavailable
  }
}

/**
 * Clear lastBackgroundAt from localStorage
 */
function clearLastBackgroundAt(): void {
  try {
    localStorage.removeItem(STORAGE_KEY_BACKGROUND)
  } catch {
    // localStorage may be unavailable
  }
}

/**
 * Start a new session: generate new ID, reset all counters/flags
 */
export function startNewSession(): void {
  state = {
    sessionId: generateSessionId(),
    pageFetchCount: 0,
    adArmed: false,
    adShown: false,
  }
  // Clear background timestamp when starting new session
  clearLastBackgroundAt()
  log('NEW SESSION started', { sessionId: state.sessionId })
}

/**
 * Initialize session on app load (cold start)
 * Always creates a new in-memory session.
 */
export function initSessionIfNeeded(): void {
  // Cold start: always create new session (in-memory only)
  startNewSession()
}

/**
 * Called when app goes to background (hidden)
 */
export function onAppBackground(): void {
  const timestamp = Date.now()
  setLastBackgroundAt(timestamp)
  log('App backgrounded at', new Date(timestamp).toISOString())
}

/**
 * Called when app returns to foreground (visible)
 * If backgrounded >= 10 min, start new session
 */
export function onAppForeground(): void {
  const lastBackgroundAt = getLastBackgroundAt()
  
  if (lastBackgroundAt !== null) {
    const elapsed = Date.now() - lastBackgroundAt
    log('App foregrounded, elapsed:', Math.round(elapsed / 1000), 'seconds')
    
    if (elapsed >= BACKGROUND_THRESHOLD_MS) {
      log('Background threshold exceeded, starting new session')
      startNewSession()
    } else {
      // Clear background timestamp, session continues
      clearLastBackgroundAt()
      log('Session continues (background < 10 min)')
    }
  }
}

/**
 * Record a "next page" fetch (pagination beyond initial load)
 * Increments counter and arms ad when threshold reached.
 * Does nothing if ad already shown this session.
 */
export function recordPageFetch(): void {
  // Don't count if ad already shown this session
  if (state.adShown) {
    log('Page fetch ignored (ad already shown this session)')
    return
  }
  
  state.pageFetchCount++
  log('Page fetch recorded, count:', state.pageFetchCount)
  
  // Check if we should arm the ad
  if (!state.adArmed && state.pageFetchCount >= AD_TRIGGER_THRESHOLD) {
    state.adArmed = true
    log('AD ARMED at pageFetchCount:', state.pageFetchCount)
  }
}

/**
 * Mark ad as shown (called after ad displays)
 * Prevents further ads this session.
 */
export function markAdShown(): void {
  state.adShown = true
  state.adArmed = false
  log('Ad marked as shown, no more ads this session')
}

/**
 * Get current session state (read-only snapshot)
 */
export function getSessionState(): Readonly<SessionState> {
  return { ...state }
}

/**
 * Check if ad is currently armed and ready to show
 */
export function isAdArmed(): boolean {
  return state.adArmed && !state.adShown
}

/**
 * Check if ad has already been shown this session
 */
export function hasAdShown(): boolean {
  return state.adShown
}

/**
 * Get current session ID
 */
export function getSessionId(): string {
  return state.sessionId
}

/**
 * Get current page fetch count
 */
export function getPageFetchCount(): number {
  return state.pageFetchCount
}
