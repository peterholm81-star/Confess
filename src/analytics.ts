import { supabase } from './supabase'

const SESSION_HASH_KEY = 'lethe_session_hash'
const SESSION_CREATED_KEY = 'lethe_session_created_at'
const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

// Generate a random UUID
function generateUUID(): string {
  return crypto.randomUUID()
}

// Get current session hash, rotating if older than 24 hours
function getSessionHash(): string {
  try {
    const existingHash = localStorage.getItem(SESSION_HASH_KEY)
    const createdAt = localStorage.getItem(SESSION_CREATED_KEY)
    
    if (existingHash && createdAt) {
      const age = Date.now() - parseInt(createdAt, 10)
      if (age < SESSION_TTL_MS) {
        return existingHash
      }
    }
    
    // Create new session hash
    const newHash = generateUUID()
    localStorage.setItem(SESSION_HASH_KEY, newHash)
    localStorage.setItem(SESSION_CREATED_KEY, String(Date.now()))
    return newHash
  } catch {
    // Fallback if localStorage unavailable
    return generateUUID()
  }
}

// Get current local date as YYYY-MM-DD
function getDayBucket(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Get current local hour (0-23)
function getTimeBucket(): number {
  return new Date().getHours()
}

// Log an analytics event (best effort, fail silently)
export async function logEvent(
  eventName: string,
  meta?: {
    mode?: string
    city_code?: string
    language_detected?: string
    emotion_bucket?: string
    reason_bucket?: string
  }
): Promise<void> {
  if (!supabase) return

  try {
    await supabase.from('event_logs').insert({
      event_name: eventName,
      day_bucket: getDayBucket(),
      time_bucket: getTimeBucket(),
      session_hash: getSessionHash(),
      mode: meta?.mode ?? null,
      city_code: meta?.city_code ?? null,
      language_detected: meta?.language_detected ?? null,
      emotion_bucket: meta?.emotion_bucket ?? null,
      reason_bucket: meta?.reason_bucket ?? null,
    })
  } catch {
    // Fail silently - analytics must never block UX
  }
}
