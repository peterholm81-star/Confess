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
import { logEvent } from './analytics'
import {
  initSessionIfNeeded,
  onAppBackground,
  onAppForeground,
  recordPageFetch,
  isAdArmed,
  hasAdShown,
  markAdShown,
} from './state/session'
import { AdCard } from './components/AdCard'
import { Onboarding } from './components/Onboarding'
import './App.css'

// Share icon (arrow up from box) as inline SVG component
function ShareIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  )
}

const MAX_LENGTH = 120

// Share content (easy to edit)
const SHARE_TITLE = 'Confess'
const SHARE_TEXT = `If no one ever knew, what would you…?

A quiet place for the things people never admit.
Nothing lasts.`
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

type FeedState = {
  confessions: Confession[]
  cursor: PageCursor
  hasMore: boolean
  loading: boolean
  hasFetched: boolean // true after first fetch attempt completes
}

const emptyFeed: FeedState = {
  confessions: [],
  cursor: null,
  hasMore: false,
  loading: false,
  hasFetched: false,
}

function App() {
  // Write state
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Device GPS location (ONLY for "near" mode - never overwritten by Somewhere)
  const [deviceLocation, setDeviceLocation] = useState<{ lat: number; lng: number } | null>(null)
  const [geoStatus, setGeoStatus] = useState<GeoStatus>('idle')
  const [geoError, setGeoError] = useState<string | null>(null)

  // Tab + feed state
  const [tab, setTab] = useState<Tab>('world')
  const [worldFeed, setWorldFeed] = useState<FeedState>(emptyFeed)
  const [placeFeed, setPlaceFeed] = useState<FeedState>(emptyFeed)

  // Somewhere place (ONLY for "somewhere" mode - resolved from search)
  const [somewherePlace, setSomewherePlace] = useState<ResolvedPlace | null>(null)
  const [somewhereQuery, setSomewhereQuery] = useState('')
  const [popularPlaces, setPopularPlaces] = useState<CachedPlace[]>([])
  const [resolvingPlace, setResolvingPlace] = useState(false)

  // Near me auto-expand radius (stored for pagination)
  const [nearMeRadius, setNearMeRadius] = useState<number>(NEAR_ME_RADII[NEAR_ME_RADII.length - 1])

  // Toast state
  const [toast, setToast] = useState<string | null>(null)

  // FAB (floating action button) state
  const [showFab, setShowFab] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Ad insertion state (tracks if ad has been inserted this session)
  const [adInserted, setAdInserted] = useState(false)
  const [adInsertIndex, setAdInsertIndex] = useState<number | null>(null)
  const adMarkedRef = useRef(false) // Guard to call markAdShown only once

  // Onboarding state
  const [showOnboarding, setShowOnboarding] = useState(() => {
    return !localStorage.getItem('lethe_onboarding_seen')
  })

  function handleOnboardingContinue() {
    localStorage.setItem('lethe_onboarding_seen', 'true')
    setShowOnboarding(false)
  }

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

  // Initialize session manager on mount
  useEffect(() => {
    initSessionIfNeeded()
  }, [])

  // Handle app visibility changes for session management
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        onAppBackground()
      } else if (document.visibilityState === 'visible') {
        // Check if ad was previously shown before foreground
        const wasAdShown = hasAdShown()
        onAppForeground()
        // If session was reset (adShown became false), reset our local ad state
        if (wasAdShown && !hasAdShown()) {
          setAdInserted(false)
          setAdInsertIndex(null)
          adMarkedRef.current = false
          if (import.meta.env.DEV) {
            console.log('[ads] Ad state reset (new session)')
          }
        }
      }
    }
    
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  // Log session_start event on mount
  useEffect(() => {
    logEvent('session_start')
  }, [])

  // Log feed_view event and debug location state when tab changes
  useEffect(() => {
    console.log('[location] mode', tab, { deviceLocation, somewherePlace })
    logEvent('feed_view', { mode: tab })
  }, [tab, deviceLocation, somewherePlace])

  // Handle ad insertion: when ad is armed and not yet inserted, insert it at the END of current feed
  useEffect(() => {
    if (isAdArmed() && !hasAdShown() && !adInserted && !adMarkedRef.current) {
      // Capture current feed length as stable insertion point (end of visible feed)
      const feedLength = tab === 'world' ? worldFeed.confessions.length : placeFeed.confessions.length
      
      adMarkedRef.current = true
      setAdInsertIndex(feedLength) // Insert at the end of current feed
      setAdInserted(true)
      markAdShown()
      if (import.meta.env.DEV) {
        console.log('[ads] Ad inserted at index', feedLength)
      }
    }
  })

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
    console.log('[location] fetching world feed', { deviceLocation, somewherePlace, usedLatLng: null })
    setWorldFeed((prev) => ({ ...prev, loading: true }))
    const cursor = reset ? null : worldFeed.cursor
    const result = await fetchFeed({ mode: 'world', cursor })
    
    // Record page fetch for pagination (not initial load)
    if (!reset && result.confessions.length > 0) {
      recordPageFetch()
    }
    
    setWorldFeed((prev) => ({
      confessions: reset ? result.confessions : [...prev.confessions, ...result.confessions],
      cursor: result.nextCursor,
      hasMore: result.hasMore,
      loading: false,
      hasFetched: true,
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

    console.log('[location] fetching somewhere feed', { deviceLocation, somewherePlace, usedLatLng: { lat: place.lat, lng: place.lng } })
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
    
    // Record page fetch for pagination (not initial load)
    if (!reset && result.confessions.length > 0) {
      recordPageFetch()
    }
    
    setPlaceFeed((prev) => ({
      confessions: reset ? result.confessions : [...prev.confessions, ...result.confessions],
      cursor: result.nextCursor,
      hasMore: result.hasMore,
      loading: false,
      hasFetched: true,
    }))
  }, [placeFeed.cursor])

  // Near me feed with auto-expanding radius
  // On initial fetch (reset=true): try progressively larger radii until MIN_RESULTS or MAX_ATTEMPTS
  // On pagination (reset=false): use the stored nearMeRadius
  const loadNearMe = useCallback(async (lat: number, lng: number, reset: boolean) => {
    console.log('[location] fetching near feed', { deviceLocation, somewherePlace, usedLatLng: { lat, lng } })
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
      
      // Record page fetch for pagination (not initial load)
      if (result.confessions.length > 0) {
        recordPageFetch()
      }
      
      setPlaceFeed((prev) => ({
        confessions: [...prev.confessions, ...result.confessions],
        cursor: result.nextCursor,
        hasMore: result.hasMore,
        loading: false,
        hasFetched: true,
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
          hasFetched: true,
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
      hasFetched: true,
    })
  }, [placeFeed.cursor, nearMeRadius])

  // Handle Near me click - request location and use auto-expand radius
  async function handleNearMeClick() {
    console.log('[near] clicked')
    setTab('near')
    setError('')
    setNotice('')

    // If we already have device location, use it directly (never use somewherePlace)
    if (deviceLocation) {
      console.log('[location] mode near', { deviceLocation, somewherePlace, usedLatLng: deviceLocation })
      loadNearMe(deviceLocation.lat, deviceLocation.lng, true)
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

        // Store device location (NEVER overwritten by Somewhere)
        setDeviceLocation({ lat, lng })
        setGeoStatus('granted')
        setGeoError(null)

        console.log('[location] mode near', { deviceLocation: { lat, lng }, somewherePlace, usedLatLng: { lat, lng } })
        loadNearMe(lat, lng, true)
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
      setSomewherePlace(cached)
      console.log('[location] mode somewhere', { deviceLocation, somewherePlace: cached, usedLatLng: { lat: cached.lat, lng: cached.lng } })
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
        // Success: set somewherePlace (NEVER touch deviceLocation)
        const place: ResolvedPlace = { query, name: result.place.name, lat: result.place.lat, lng: result.place.lng }
        setCachedPlace(place)
        setSomewherePlace(place)
        console.log('[location] mode somewhere', { deviceLocation, somewherePlace: place, usedLatLng: { lat: place.lat, lng: place.lng } })
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

    // If we already have deviceLocation, use it immediately (never use somewherePlace)
    if (deviceLocation) {
      console.log('[fallback] using existing deviceLocation:', deviceLocation)
      setTab('near')
      console.log('[location] mode near (fallback)', { deviceLocation, somewherePlace, usedLatLng: deviceLocation })
      loadNearMe(deviceLocation.lat, deviceLocation.lng, true)
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

        // Store device location (NEVER overwritten by Somewhere)
        setDeviceLocation({ lat, lng })
        setGeoStatus('granted')
        setGeoError(null)

        console.log('[location] mode near (fallback)', { deviceLocation: { lat, lng }, somewherePlace, usedLatLng: { lat, lng } })
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

  // Pick a popular place (for Somewhere mode only)
  function handlePickPlace(place: CachedPlace) {
    console.log('[somewhere] picked:', place.name)
    const resolved: ResolvedPlace = { query: place.name, name: place.name, lat: place.lat, lng: place.lng }
    setSomewherePlace(resolved)
    setCachedPlace(resolved)
    console.log('[location] mode somewhere (picked)', { deviceLocation, somewherePlace: resolved, usedLatLng: { lat: resolved.lat, lng: resolved.lng } })
    loadPlace(resolved, true)
  }

  // Random place
  function handleRandomPlace() {
    const random = getRandomFromList(popularPlaces)
    if (random) {
      handlePickPlace(random)
    }
  }

  // Submit confession
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    // Log post attempt
    logEvent('post_attempt', { mode: tab })

    if (!supabase) return

    // ALWAYS use device GPS coords for posting (not somewherePlace coords)
    // This ensures confessions appear in "Near me" based on where user physically is,
    // regardless of which feed they're viewing when posting.
    const postLat = deviceLocation?.lat
    const postLng = deviceLocation?.lng
    const placeLabel = deviceLocation ? 'Near you' : undefined

    // Debug log showing what coords we're using for this post
    console.log('[submit] posting confession', { 
      mode: tab, 
      deviceLocation, 
      somewherePlace, 
      usedLatLng: postLat && postLng ? { lat: postLat, lng: postLng } : null 
    })

    const trimmed = text.trim()
    if (!trimmed) {
      setError('Write something first.')
      logEvent('post_reject', { mode: tab, reason_bucket: 'validation' })
      return
    }

    setSubmitting(true)
    setError('')
    setNotice('')

    const result: InsertConfessionResult = await insertConfession({
      text: trimmed,
      placeLabel,
      lat: postLat,
      lng: postLng,
    })

    if (!result.ok) {
      setError(result.message)
      setSubmitting(false)
      // Map error type to rejection reason bucket
      const reasonBucket = 
        result.error === 'CONTENT_BLOCKED' || result.error === 'EMPTY_TEXT' || result.error === 'TEXT_TOO_LONG'
          ? 'validation'
          : result.error === 'RATE_LIMIT'
            ? 'rate_limit'
            : 'network'
      logEvent('post_reject', { mode: tab, reason_bucket: reasonBucket })
      return
    }

    // Log success
    logEvent('post_success', { mode: tab })

    setText('')
    setSubmitting(false)

    // Prepend new confession to current feed for instant feedback
    const newConfession = result.confession
    if (tab === 'world') {
      setWorldFeed(prev => ({
        ...prev,
        confessions: [newConfession, ...prev.confessions],
      }))
    } else if (tab === 'near' || tab === 'somewhere') {
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

  // canSubmit: always use device GPS for coords (not somewherePlace)
  // - world: can post without location (appears only in World)
  // - near: requires deviceLocation (so it appears in Near me)
  // - somewhere: can post without deviceLocation (uses device GPS if available)
  const canSubmit = supabase && text.trim() && !submitting && (
    tab === 'world' ||
    tab === 'somewhere' ||
    (tab === 'near' && deviceLocation)
  )

  // Current feed based on tab
  const currentFeed = tab === 'world' ? worldFeed : placeFeed

  // Derive listening label based on mode (NEVER cross-contaminate coords)
  let listeningLabel: string | null = null
  if (tab === 'near' && deviceLocation) {
    listeningLabel = 'Near you'
  } else if (tab === 'somewhere' && somewherePlace) {
    listeningLabel = somewherePlace.name
  }
  const showListeningIn = listeningLabel !== null

  return (
    <main>
      {/* Sticky topbar */}
      <header className="topbar">
        <span className="topbar-brand">Confess</span>
        <button
          className="topbar-share"
          onClick={handleShare}
          aria-label="Share Confess"
          title="Share"
        >
          <ShareIcon />
        </button>
      </header>

      <h1>If no one ever knew, I would…</h1>
      <p className="subheading">A place for the thoughts you never say out loud.</p>

      <form onSubmit={handleSubmit}>
        <textarea
          id="confessionText"
          name="confessionText"
          aria-label="Write your confession"
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
      {!deviceLocation && geoStatus === 'idle' && (
        <p className="notice">Tap "Near me" to enable location.</p>
      )}
      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}

      <div className={`tabs${showListeningIn ? ' tabs--listening' : ''}`}>
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
          Listening in: {listeningLabel}
          {tab === 'near' && ` · ${formatRadius(nearMeRadius)}`}
        </p>
      )}

      {tab === 'somewhere' && (
        <div className="somewhere">
          <div className="somewhere-input">
            <input
              id="somewherePlace"
              name="somewherePlace"
              aria-label="City or place"
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

          {!somewherePlace && popularPlaces.length > 0 && (
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

      {tab === 'near' && !deviceLocation && geoStatus !== 'requesting' && (
        <div className="geo-prompt">
          {(geoStatus === 'denied' || geoStatus === 'error') && geoError && (
            <p className="notice">{geoError}</p>
          )}
          <button onClick={handleNearMeClick}>
            {geoStatus === 'denied' || geoStatus === 'error' ? 'Try again' : 'Enable location'}
          </button>
        </div>
      )}

      {/* Empty feed state - only show after fetch attempt completes */}
      {currentFeed.confessions.length === 0 && !currentFeed.loading && currentFeed.hasFetched && (
        (tab === 'world') ||
        (tab === 'near' && deviceLocation) ||
        (tab === 'somewhere' && somewherePlace)
      ) && (
        <div className="empty-feed">
          {tab === 'world' && (
            <>
              <p className="empty-feed-primary">Nothing here right now.</p>
              <p className="empty-feed-secondary">It disappears.</p>
            </>
          )}
          {tab === 'near' && (
            <>
              <p className="empty-feed-primary">Quiet where you are.</p>
              <p className="empty-feed-secondary">Check back later.</p>
            </>
          )}
          {tab === 'somewhere' && (
            <>
              <p className="empty-feed-primary">Nothing from this place right now.</p>
              <p className="empty-feed-secondary">Try somewhere else.</p>
            </>
          )}
        </div>
      )}

      <ul className="confessions-list">
        {(() => {
          // Show ad at the captured insertion index (where user was when ad became armed)
          const shouldShowAd = adInserted && adInsertIndex !== null
          
          const items: React.ReactNode[] = []
          let adRendered = false
          
          currentFeed.confessions.forEach((c, index) => {
            // Insert ad before this item if we've reached the insertion point
            if (shouldShowAd && !adRendered && index === adInsertIndex) {
              items.push(<li key="ad-card" className="confession-item"><AdCard /></li>)
              adRendered = true
            }
            
            items.push(
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
            )
          })
          
          // If ad wasn't rendered yet (index >= confessions length), append at end
          if (shouldShowAd && !adRendered) {
            items.push(<li key="ad-card" className="confession-item"><AdCard /></li>)
          }
          
          return items
        })()}
      </ul>

      {currentFeed.hasMore && !currentFeed.loading && (
        <button
          className="load-more"
          onClick={() => {
            if (tab === 'world') loadWorld(false)
            else if (tab === 'near' && deviceLocation) loadNearMe(deviceLocation.lat, deviceLocation.lng, false)
            else if (tab === 'somewhere' && somewherePlace) loadPlace(somewherePlace, false)
          }}
        >
          Load more
        </button>
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
                  id="reportDetails"
                  name="reportDetails"
                  aria-label="Additional report details"
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

      {/* Onboarding overlay */}
      {showOnboarding && (
        <Onboarding onComplete={handleOnboardingContinue} />
      )}
    </main>
  )
}

export default App
