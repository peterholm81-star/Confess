import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from './supabase'
import type { Confession } from './supabase'
import {
  fetchFeed,
  insertConfession,
  fetchPopularPlaces,
  resolvePlace,
  type PageCursor,
  type CachedPlace,
  type InsertConfessionResult,
} from './api'
import { getCachedPlace, setCachedPlace, getRandomFromList, type ResolvedPlace } from './placeCache'
import './App.css'

// Hush icon (finger over lips) as inline SVG component
function HushIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="11" r="7" />
      <circle cx="9.5" cy="9.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="9.5" r="0.8" fill="currentColor" stroke="none" />
      <path d="M10 13.5 Q12 14.5 14 13.5" />
      <path d="M12 19 L12 13" strokeWidth="2.5" />
      <ellipse cx="12" cy="12.8" rx="1.2" ry="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

const MAX_LENGTH = 120

// Share content (easy to edit)
const SHARE_TITLE = 'Confess'
const SHARE_TEXT = `If no one ever knew, what would you…?

A quiet place for the things people never admit.
Nothing lasts.`
const RULES_ACK_PREFIX = 'confess_rules_ack_'
const ENABLE_CARD_GLOW = false // Toggle subtle glow effect on confession cards

// Near me auto-expand radius settings
const NEAR_ME_RADII = [100, 250, 500, 1000, 2000] // meters, in order
const MIN_RESULTS = 10 // minimum posts to consider "enough"
const MAX_ATTEMPTS = 3 // max radii to try before giving up

// Format radius for display
function formatRadius(meters: number): string {
  if (meters >= 1000) {
    return `${meters / 1000} km`
  }
  return `${meters} m`
}

type Tab = 'world' | 'near' | 'somewhere'
type GeoStatus = 'idle' | 'requesting' | 'granted' | 'denied' | 'error'
type ReportReason = 'identifying' | 'contact' | 'threats' | 'spam' | 'other'

const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: 'identifying', label: 'Too identifying' },
  { value: 'contact', label: 'Mentions contact info' },
  { value: 'threats', label: 'Feels threatening' },
  { value: 'spam', label: 'Spam' },
  { value: 'other', label: 'Something else' },
]

// Get today's date as YYYY-MM-DD in local timezone
function getTodayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Check if rules were acknowledged today
function hasAcknowledgedToday(): boolean {
  try {
    return localStorage.getItem(RULES_ACK_PREFIX + getTodayKey()) === '1'
  } catch {
    return false
  }
}

// Store acknowledgment for today
function acknowledgeRules(): void {
  try {
    localStorage.setItem(RULES_ACK_PREFIX + getTodayKey(), '1')
  } catch {
    // Ignore storage errors
  }
}

type FeedState = {
  confessions: Confession[]
  cursor: PageCursor
  hasMore: boolean
  loading: boolean
}

const emptyFeed: FeedState = {
  confessions: [],
  cursor: null,
  hasMore: false,
  loading: false,
}

function App() {
  // Write state
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // User location state (for writing confessions)
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null)
  const [geoStatus, setGeoStatus] = useState<GeoStatus>('idle')
  const [geoError, setGeoError] = useState<string | null>(null)

  // Tab + feed state
  const [tab, setTab] = useState<Tab>('world')
  const [worldFeed, setWorldFeed] = useState<FeedState>(emptyFeed)
  const [placeFeed, setPlaceFeed] = useState<FeedState>(emptyFeed)

  // Current listening place (shared by Near me + Somewhere)
  const [currentPlace, setCurrentPlace] = useState<ResolvedPlace | null>(null)
  const [somewhereQuery, setSomewhereQuery] = useState('')
  const [popularPlaces, setPopularPlaces] = useState<CachedPlace[]>([])
  const [resolvingPlace, setResolvingPlace] = useState(false)

  // Near me auto-expand radius (stored for pagination)
  const [nearMeRadius, setNearMeRadius] = useState<number>(NEAR_ME_RADII[NEAR_ME_RADII.length - 1])

  // Rules modal state
  const [showRulesModal, setShowRulesModal] = useState(() => !hasAcknowledgedToday())
  const [rulesChecked, setRulesChecked] = useState(false)

  // Toast state
  const [toast, setToast] = useState<string | null>(null)

  // FAB (floating action button) state
  const [showFab, setShowFab] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Report modal state
  const [reportConfessionId, setReportConfessionId] = useState<string | null>(null)
  const [reportReason, setReportReason] = useState<ReportReason | null>(null)
  const [reportDetails, setReportDetails] = useState('')
  const [reportSubmitting, setReportSubmitting] = useState(false)
  const [reportError, setReportError] = useState<string | null>(null)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)

  // Track scroll position for FAB visibility
  useEffect(() => {
    function handleScroll() {
      setShowFab(window.scrollY > 200)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  // FAB click: scroll to top and focus textarea
  function handleFabClick() {
    window.scrollTo({ top: 0, behavior: 'smooth' })
    // Focus after scroll animation
    setTimeout(() => {
      textareaRef.current?.focus()
    }, 300)
  }

  // Show toast with auto-dismiss
  function showToast(message: string) {
    setToast(message)
    setTimeout(() => setToast(null), 1500)
  }

  // Share handler
  async function handleShare() {
    const shareData = {
      title: SHARE_TITLE,
      text: SHARE_TEXT,
      url: window.location.href,
    }

    try {
      if (navigator.share) {
        await navigator.share(shareData)
      } else {
        // Fallback: copy to clipboard
        const shareText = `${SHARE_TEXT}\n\n${window.location.href}`
        await navigator.clipboard.writeText(shareText)
        showToast('Copied link')
      }
    } catch (err) {
      // User cancelled share or error
      if ((err as Error).name !== 'AbortError') {
        showToast('Could not share')
      }
    }
  }

  // Report handlers
  function openReportModal(confessionId: string) {
    setReportConfessionId(confessionId)
    setReportReason(null)
    setReportDetails('')
    setReportError(null)
    setOpenMenuId(null)
  }

  function closeReportModal() {
    setReportConfessionId(null)
    setReportReason(null)
    setReportDetails('')
    setReportError(null)
  }

  async function handleReportSubmit() {
    if (!reportConfessionId || !reportReason || !supabase) return

    setReportSubmitting(true)
    setReportError(null)

    try {
      const { error } = await supabase.rpc('report_confession', {
        p_confession_id: reportConfessionId,
        p_reason: reportReason,
        p_details: reportDetails.trim() || null,
      })

      if (error) {
        console.error('[report] RPC error:', error)
        setReportError('Something went wrong. Please try again.')
        setReportSubmitting(false)
        return
      }

      // Success
      setReportSubmitting(false)
      closeReportModal()
      showToast('Thanks. This helps keep the space safe.')
    } catch (err) {
      console.error('[report] exception:', err)
      setReportError('Something went wrong. Please try again.')
      setReportSubmitting(false)
    }
  }

  // Close menu when clicking outside
  useEffect(() => {
    if (!openMenuId) return
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest('.confession-menu')) {
        setOpenMenuId(null)
      }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [openMenuId])

  // Load popular places on mount
  useEffect(() => {
    fetchPopularPlaces().then(setPopularPlaces)
  }, [])

  // Load world feed when tab changes
  useEffect(() => {
    if (!supabase) return
    if (tab === 'world' && worldFeed.confessions.length === 0 && !worldFeed.loading) {
      loadWorld(true)
    }
  }, [tab])

  // World feed - uses unified fetchFeed with mode='world'
  const loadWorld = useCallback(async (reset: boolean) => {
    setWorldFeed((prev) => ({ ...prev, loading: true }))
    const cursor = reset ? null : worldFeed.cursor
    const result = await fetchFeed({ mode: 'world', cursor })
    setWorldFeed((prev) => ({
      confessions: reset ? result.confessions : [...prev.confessions, ...result.confessions],
      cursor: result.nextCursor,
      hasMore: result.hasMore,
      loading: false,
    }))
  }, [worldFeed.cursor])

  // Place feed (used by Somewhere) - uses unified fetchFeed with mode='near'
  const loadPlace = useCallback(async (place: ResolvedPlace, reset: boolean, radiusM: number = 10000) => {
    // Guard: validate coordinates
    if (
      place.lat == null ||
      place.lng == null ||
      typeof place.lat !== 'number' ||
      typeof place.lng !== 'number' ||
      Number.isNaN(place.lat) ||
      Number.isNaN(place.lng)
    ) {
      console.error('[loadPlace] invalid coordinates for place:', place.name, { lat: place.lat, lng: place.lng })
      setError('Could not determine location for this place.')
      return
    }

    console.log('[loadPlace]', place.name, reset ? '(reset)' : '(more)', `radius=${radiusM}m`)
    setPlaceFeed((prev) => ({ ...prev, loading: true }))
    const cursor = reset ? null : placeFeed.cursor
    const result = await fetchFeed({
      mode: 'near',
      lat: place.lat,
      lng: place.lng,
      radiusM,
      cursor,
    })
    setPlaceFeed((prev) => ({
      confessions: reset ? result.confessions : [...prev.confessions, ...result.confessions],
      cursor: result.nextCursor,
      hasMore: result.hasMore,
      loading: false,
    }))
  }, [placeFeed.cursor])

  // Near me feed with auto-expanding radius
  // On initial fetch (reset=true): try progressively larger radii until MIN_RESULTS or MAX_ATTEMPTS
  // On pagination (reset=false): use the stored nearMeRadius
  const loadNearMe = useCallback(async (lat: number, lng: number, reset: boolean) => {
    console.log('[nearMe] load', reset ? '(reset, auto-expand)' : '(more)')
    setPlaceFeed((prev) => ({ ...prev, loading: true }))

    // For pagination, use stored radius
    if (!reset) {
      const cursor = placeFeed.cursor
      console.log('[nearMe] pagination with radius:', nearMeRadius)
      const result = await fetchFeed({
        mode: 'near',
        lat,
        lng,
        radiusM: nearMeRadius,
        cursor,
      })
      setPlaceFeed((prev) => ({
        confessions: [...prev.confessions, ...result.confessions],
        cursor: result.nextCursor,
        hasMore: result.hasMore,
        loading: false,
      }))
      return
    }

    // Auto-expand: try radii until we get enough results or hit MAX_ATTEMPTS
    let usedRadius = NEAR_ME_RADII[0]
    let attempts = 0

    for (const radius of NEAR_ME_RADII) {
      if (attempts >= MAX_ATTEMPTS) {
        console.log('[nearMe] max attempts reached, using last radius:', usedRadius)
        break
      }

      attempts++
      usedRadius = radius
      console.log('[nearMe] trying radius:', radius, `(attempt ${attempts}/${MAX_ATTEMPTS})`)

      const result = await fetchFeed({
        mode: 'near',
        lat,
        lng,
        radiusM: radius,
        cursor: null,
      })

      if (result.confessions.length >= MIN_RESULTS || radius === NEAR_ME_RADII[NEAR_ME_RADII.length - 1]) {
        console.log('[nearMe] found', result.confessions.length, 'posts at radius:', radius)
        setNearMeRadius(radius)
        setPlaceFeed({
          confessions: result.confessions,
          cursor: result.nextCursor,
          hasMore: result.hasMore,
          loading: false,
        })
        return
      }

      console.log('[nearMe] only', result.confessions.length, 'posts, expanding...')
    }

    // Fallback: use last tried radius
    console.log('[nearMe] using fallback radius:', usedRadius)
    setNearMeRadius(usedRadius)
    const result = await fetchFeed({
      mode: 'near',
      lat,
      lng,
      radiusM: usedRadius,
      cursor: null,
    })
    setPlaceFeed({
      confessions: result.confessions,
      cursor: result.nextCursor,
      hasMore: result.hasMore,
      loading: false,
    })
  }, [placeFeed.cursor, nearMeRadius])

  // Handle Near me click - request location and use auto-expand radius
  async function handleNearMeClick() {
    console.log('[near] clicked')
    setTab('near')
    setError('')
    setNotice('')

    // If we already have location, set place and load with auto-expand
    if (userLocation) {
      console.log('[near] using existing location:', userLocation)
      const place: ResolvedPlace = {
        query: 'near me',
        name: 'Near you',
        lat: userLocation.lat,
        lng: userLocation.lng,
      }
      setCurrentPlace(place)
      loadNearMe(userLocation.lat, userLocation.lng, true)
      return
    }

    // Request location
    if (geoStatus === 'requesting') {
      console.log('[near] already requesting')
      return
    }

    if (!navigator.geolocation) {
      console.log('[near] geolocation not supported')
      setGeoStatus('error')
      setGeoError('Geolocation not supported')
      return
    }

    console.log('[near] requesting location...')
    setGeoStatus('requesting')
    setGeoError(null)

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude
        const lng = pos.coords.longitude
        console.log('[near] success:', lat, lng)

        setUserLocation({ lat, lng })
        setGeoStatus('granted')
        setGeoError(null)

        const place: ResolvedPlace = {
          query: 'near me',
          name: 'Near you',
          lat,
          lng,
        }
        setCurrentPlace(place)
        loadNearMe(lat, lng, true)
        console.log('[near] place set:', place.name)
      },
      (err) => {
        console.log('[near] error:', err.code, err.message)
        if (err.code === err.PERMISSION_DENIED) {
          setGeoStatus('denied')
          setGeoError('Location permission denied. Try "Somewhere" instead.')
        } else {
          setGeoStatus('error')
          setGeoError('Unable to get your location')
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000,
      }
    )
  }

  // Handle Somewhere "Listen" - calls edge function to resolve place
  async function handleSomewhereListen() {
    const query = somewhereQuery.trim()
    console.log('[somewhere] query:', query)
    setError('')
    setNotice('')

    // Check in-memory cache first
    const cached = getCachedPlace(query)
    if (cached) {
      console.log('[somewhere] cache HIT:', cached.name)
      setCurrentPlace(cached)
      loadPlace(cached, true)
      return
    }

    console.log('[somewhere] cache MISS, calling edge function')

    if (query.length < 2) {
      console.log('[somewhere] query too short')
      return
    }

    setResolvingPlace(true)
    try {
      const result = await resolvePlace(query)
      console.log('[somewhere] result:', result)

      if (result.ok) {
        // Success: set place and load
        const place: ResolvedPlace = { query, name: result.place.name, lat: result.place.lat, lng: result.place.lng }
        setCachedPlace(place)
        setCurrentPlace(place)
        loadPlace(place, true)
        console.log('[somewhere] place set:', place.name)
      } else if (result.reason === 'NOT_FOUND') {
        // NOT_FOUND: fallback to Near me
        console.log('[somewhere] NOT_FOUND, falling back to Near me')
        fallbackToNearMe()
      } else {
        // ERROR: show generic error, do NOT fallback
        console.error('[somewhere] ERROR:', result.message)
        setError('Could not resolve that place right now.')
      }
    } catch (err) {
      console.error('[somewhere] exception:', err)
      setError('Failed to look up place')
    } finally {
      setResolvingPlace(false)
    }
  }

  // Fallback to Near me when place not found
  function fallbackToNearMe() {
    console.log('[fallback] NOT_FOUND — switching to near me')
    setError('')
    setNotice('Could not find that place — listening near you instead.')

    // If we already have userLocation, use it immediately
    if (userLocation) {
      console.log('[fallback] using existing location:', userLocation)
      const place: ResolvedPlace = {
        query: 'near me',
        name: 'Near you',
        lat: userLocation.lat,
        lng: userLocation.lng,
      }
      setCurrentPlace(place)
      setTab('near')
      loadNearMe(userLocation.lat, userLocation.lng, true)
      return
    }

    // Otherwise, request location (same as handleNearMeClick)
    if (geoStatus === 'requesting') {
      console.log('[fallback] already requesting location')
      setTab('near')
      return
    }

    if (!navigator.geolocation) {
      console.log('[fallback] geolocation not supported')
      setGeoStatus('error')
      setGeoError('Geolocation not supported')
      setTab('near')
      return
    }

    console.log('[fallback] requesting location...')
    setGeoStatus('requesting')
    setGeoError(null)
    setTab('near')

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude
        const lng = pos.coords.longitude
        console.log('[fallback] location success:', lat, lng)

        setUserLocation({ lat, lng })
        setGeoStatus('granted')
        setGeoError(null)

        const place: ResolvedPlace = {
          query: 'near me',
          name: 'Near you',
          lat,
          lng,
        }
        setCurrentPlace(place)
        loadNearMe(lat, lng, true)
      },
      (err) => {
        console.log('[fallback] location error:', err.code, err.message)
        if (err.code === err.PERMISSION_DENIED) {
          setGeoStatus('denied')
          setGeoError('Location permission denied.')
        } else {
          setGeoStatus('error')
          setGeoError('Unable to get your location')
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000,
      }
    )
  }

  // Pick a popular place
  function handlePickPlace(place: CachedPlace) {
    console.log('[somewhere] picked:', place.name)
    const resolved: ResolvedPlace = { query: place.name, name: place.name, lat: place.lat, lng: place.lng }
    setCurrentPlace(resolved)
    setCachedPlace(resolved)
    loadPlace(resolved, true)
  }

  // Random place
  function handleRandomPlace() {
    const random = getRandomFromList(popularPlaces)
    if (random) {
      handlePickPlace(random)
    }
  }

  // Handle rules modal continue
  function handleRulesContinue() {
    if (rulesChecked) {
      acknowledgeRules()
      setShowRulesModal(false)
    }
  }

  // Submit confession
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (showRulesModal) return // Guard: must acknowledge rules first
    if (!supabase) return
    if (!userLocation) {
      setError('Location required to confess. Tap "Near me" first.')
      return
    }

    const trimmed = text.trim()
    if (!trimmed) {
      setError('Write something first.')
      return
    }

    setSubmitting(true)
    setError('')
    setNotice('')

    // Determine place label from current listening context
    const placeLabel = currentPlace?.name || (userLocation ? 'Near you' : undefined)

    const result: InsertConfessionResult = await insertConfession({
      text: trimmed,
      placeLabel,
      lat: userLocation.lat,
      lng: userLocation.lng,
    })

    if (!result.ok) {
      setError(result.message)
      setSubmitting(false)
      return
    }

    setText('')
    setSubmitting(false)

    // Prepend new confession to current feed for instant feedback
    const newConfession = result.confession
    if (tab === 'world') {
      setWorldFeed(prev => ({
        ...prev,
        confessions: [newConfession, ...prev.confessions],
      }))
    } else if (currentPlace) {
      setPlaceFeed(prev => ({
        ...prev,
        confessions: [newConfession, ...prev.confessions],
      }))
    }
  }

  function formatTime(dateString: string) {
    const date = new Date(dateString)
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const canSubmit = supabase && text.trim() && userLocation && !submitting && !showRulesModal

  // Current feed based on tab
  const currentFeed = tab === 'world' ? worldFeed : placeFeed

  // Show "Listening in" for both near and somewhere tabs
  const showListeningIn = (tab === 'near' || tab === 'somewhere') && currentPlace

  return (
    <main>
      {/* Sticky topbar */}
      <header className="topbar">
        <span className="topbar-brand">Confess</span>
        <button
          className="topbar-share"
          onClick={handleShare}
          aria-label="Share"
          title="Share"
        >
          <HushIcon />
        </button>
      </header>

      <h1>If no one ever knew, I would…</h1>
      <p className="subheading">Read what people would never admit. Anywhere.</p>

      <form onSubmit={handleSubmit}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX_LENGTH))}
          placeholder="Write your confession"
          rows={3}
          disabled={submitting || !supabase}
        />
        <div className="char-counter-row">
          <span className={`char-counter ${text.length >= MAX_LENGTH ? 'at-limit' : ''}`}>
            {text.length} / {MAX_LENGTH}
          </span>
          {text.length >= MAX_LENGTH && (
            <span className="char-limit-hint">Max 120 characters</span>
          )}
        </div>
        <button type="submit" disabled={!canSubmit}>
          Confess
        </button>
      </form>

      {!supabase && <p className="notice">Supabase not configured yet.</p>}
      {!userLocation && geoStatus === 'idle' && (
        <p className="notice">Tap "Near me" to enable location.</p>
      )}
      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}

      <div className="tabs">
        <button className={tab === 'world' ? 'active' : ''} onClick={() => setTab('world')}>
          World
        </button>
        <button className={tab === 'near' ? 'active' : ''} onClick={handleNearMeClick}>
          Near me
        </button>
        <button className={tab === 'somewhere' ? 'active' : ''} onClick={() => setTab('somewhere')}>
          Somewhere
        </button>
      </div>

      {geoStatus === 'requesting' && (
        <p className="notice">Getting your location…</p>
      )}

      {showListeningIn && (
        <p className="notice">
          Listening in: {currentPlace.name}
          {tab === 'near' && ` · ${formatRadius(nearMeRadius)}`}
        </p>
      )}

      {tab === 'somewhere' && (
        <div className="somewhere">
          <div className="somewhere-input">
            <input
              type="text"
              placeholder="City or place"
              value={somewhereQuery}
              onChange={(e) => setSomewhereQuery(e.target.value)}
            />
            <button onClick={handleSomewhereListen} disabled={somewhereQuery.trim().length < 2 || resolvingPlace}>
              Listen
            </button>
          </div>

          {resolvingPlace && <p className="notice">Looking up place...</p>}

          {!currentPlace && popularPlaces.length > 0 && (
            <div className="popular-places">
              <p className="notice">Pick a place to start:</p>
              <div className="place-buttons">
                {popularPlaces.slice(0, 6).map((p) => (
                  <button key={p.id} onClick={() => handlePickPlace(p)}>
                    {p.name}
                  </button>
                ))}
                <button onClick={handleRandomPlace}>Random</button>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'near' && !userLocation && geoStatus !== 'requesting' && (
        <div className="geo-prompt">
          {(geoStatus === 'denied' || geoStatus === 'error') && geoError && (
            <p className="notice">{geoError}</p>
          )}
          <button onClick={handleNearMeClick}>
            {geoStatus === 'denied' || geoStatus === 'error' ? 'Try again' : 'Enable location'}
          </button>
        </div>
      )}

      {/* Empty feed state */}
      {currentFeed.confessions.length === 0 && !currentFeed.loading && (
        (tab === 'world') ||
        ((tab === 'near' || tab === 'somewhere') && currentPlace)
      ) && (
        <div className="empty-feed">
          <p>Nothing here right now.</p>
          <p>Some thoughts only appear when someone is ready to say them.</p>
        </div>
      )}

      <ul className="confessions-list">
        {currentFeed.confessions.map((c) => (
          <li key={c.id} className="confession-item">
            <div className={`confession-card${ENABLE_CARD_GLOW ? ' confession-card--glow' : ''}`}>
              <div className="confession-header">
                <span className="confession-text">{c.text}</span>
                <div className="confession-menu">
                  <button
                    className="confession-menu-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenMenuId(openMenuId === c.id ? null : c.id)
                    }}
                    aria-label="More options"
                  >
                    ···
                  </button>
                  {openMenuId === c.id && (
                    <div className="confession-menu-dropdown">
                      <button onClick={() => openReportModal(c.id)}>Report</button>
                    </div>
                  )}
                </div>
              </div>
              <span className="confession-time">{formatTime(c.created_at)}</span>
            </div>
          </li>
        ))}
      </ul>

      {currentFeed.hasMore && !currentFeed.loading && (
        <button
          className="load-more"
          onClick={() => {
            if (tab === 'world') loadWorld(false)
            else if (tab === 'near' && userLocation) loadNearMe(userLocation.lat, userLocation.lng, false)
            else if (currentPlace) loadPlace(currentPlace, false)
          }}
        >
          Load more
        </button>
      )}

      {/* Rules Modal */}
      {showRulesModal && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>Keep it abstract.</h2>
            <ul className="modal-rules">
              <li>No names or identifying details.</li>
              <li>No contact info (phone numbers, emails, @handles, links).</li>
              <li>No threats or incitement of violence.</li>
              <li>Some posts may be removed if they break the rules.</li>
            </ul>
            <p className="modal-footer">Help us keep this space safe.</p>
            <label className="modal-checkbox">
              <input
                type="checkbox"
                checked={rulesChecked}
                onChange={(e) => setRulesChecked(e.target.checked)}
              />
              I understand
            </label>
            <button
              className="modal-continue"
              disabled={!rulesChecked}
              onClick={handleRulesContinue}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {/* Report Modal */}
      {reportConfessionId && (
        <div className="modal-backdrop" onClick={closeReportModal}>
          <div className="report-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Help us keep this space safe</h2>
            <p className="report-subtitle">Some posts may cross the line. You can let us know quietly.</p>

            <div className="report-reasons">
              {REPORT_REASONS.map((r) => (
                <label key={r.value} className="report-reason">
                  <input
                    type="radio"
                    name="report-reason"
                    checked={reportReason === r.value}
                    onChange={() => setReportReason(r.value)}
                  />
                  <span>{r.label}</span>
                </label>
              ))}
            </div>

            {reportReason === 'other' && (
              <div className="report-details">
                <textarea
                  placeholder="Optional (max 280 characters)"
                  value={reportDetails}
                  onChange={(e) => setReportDetails(e.target.value.slice(0, 280))}
                  rows={3}
                />
                <span className="report-details-hint">This is only for context.</span>
              </div>
            )}

            {reportError && <p className="report-error">{reportError}</p>}

            <div className="report-actions">
              <button className="report-cancel" onClick={closeReportModal}>
                Cancel
              </button>
              <button
                className="report-submit"
                disabled={!reportReason || reportSubmitting}
                onClick={handleReportSubmit}
              >
                {reportSubmitting ? 'Sending...' : 'Send report'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* FAB (floating action button) */}
      {showFab && (
        <button
          className="fab"
          onClick={handleFabClick}
          aria-label="Write confession"
          title="Write confession"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      )}

      {/* Toast */}
      {toast && (
        <div className="toast">{toast}</div>
      )}
    </main>
  )
}

export default App
