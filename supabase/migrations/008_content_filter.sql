-- Migration: Content filtering for insert_confession RPC
-- Blocks confessions that might identify real people or contain contact info

CREATE OR REPLACE FUNCTION insert_confession(
  p_text TEXT,
  p_place_label TEXT DEFAULT NULL,
  p_lat DOUBLE PRECISION DEFAULT NULL,
  p_lng DOUBLE PRECISION DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  text TEXT,
  created_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_text TEXT;
  v_user_id UUID;
  v_last_post TIMESTAMPTZ;
  v_inserted_id UUID;
  v_digits_only TEXT;
BEGIN
  -- Get current user (anonymous or authenticated)
  v_user_id := auth.uid();
  
  -- Trim and validate text
  v_text := btrim(p_text);
  
  IF v_text IS NULL OR v_text = '' THEN
    RAISE EXCEPTION 'EMPTY_TEXT: Confession text cannot be empty';
  END IF;
  
  IF char_length(v_text) > 120 THEN
    RAISE EXCEPTION 'TEXT_TOO_LONG: Confession must be 120 characters or less';
  END IF;

  -- ==========================================================================
  -- CONTENT FILTER: Block patterns that might identify real people
  -- ==========================================================================
  
  -- A) Contact / handles / links
  
  -- Block @ character (emails, social handles)
  IF position('@' IN v_text) > 0 THEN
    RAISE EXCEPTION 'CONTENT_BLOCKED: Please keep it abstract. This looks like it might identify a real person.';
  END IF;
  
  -- Block URLs (http, https, www)
  IF v_text ~* 'https?://' OR v_text ~* '\mwww\.' THEN
    RAISE EXCEPTION 'CONTENT_BLOCKED: Please keep it abstract. This looks like it might identify a real person.';
  END IF;
  
  -- Block common TLDs
  IF v_text ~* '\.(com|net|org|no|io|co|app)\M' THEN
    RAISE EXCEPTION 'CONTENT_BLOCKED: Please keep it abstract. This looks like it might identify a real person.';
  END IF;
  
  -- B) Phone-like sequences
  
  -- Extract digits only (remove spaces, hyphens, parentheses)
  v_digits_only := regexp_replace(v_text, '[^0-9]', '', 'g');
  
  -- Block 8+ consecutive digits
  IF length(v_digits_only) >= 8 THEN
    RAISE EXCEPTION 'CONTENT_BLOCKED: Please keep it abstract. This looks like it might identify a real person.';
  END IF;
  
  -- Block +<digits> country code pattern (e.g., +47, +1)
  IF v_text ~ '\+\s*[0-9]' THEN
    RAISE EXCEPTION 'CONTENT_BLOCKED: Please keep it abstract. This looks like it might identify a real person.';
  END IF;
  
  -- C) Obvious real-name pattern
  -- Two capitalized words (e.g., "John Smith", "Kari Nordmann")
  -- Pattern: capital letter followed by lowercase, space, capital followed by lowercase
  IF v_text ~ '\m[A-Z][a-z]+\s+[A-Z][a-z]+\M' THEN
    RAISE EXCEPTION 'CONTENT_BLOCKED: Please keep it abstract. This looks like it might identify a real person.';
  END IF;

  -- ==========================================================================
  -- RATE LIMITING
  -- ==========================================================================
  
  IF v_user_id IS NOT NULL THEN
    SELECT c.created_at INTO v_last_post
    FROM confessions c
    WHERE c.user_id = v_user_id
    ORDER BY c.created_at DESC
    LIMIT 1;
    
    IF v_last_post IS NOT NULL AND v_last_post > now() - interval '15 seconds' THEN
      RAISE EXCEPTION 'RATE_LIMIT: Please wait before posting again';
    END IF;
  END IF;
  
  -- ==========================================================================
  -- INSERT
  -- ==========================================================================
  
  INSERT INTO confessions (
    text,
    lat,
    lng,
    expires_at,
    is_hidden,
    user_id
  ) VALUES (
    v_text,
    p_lat,
    p_lng,
    now() + interval '24 hours',
    false,
    v_user_id
  )
  RETURNING confessions.id INTO v_inserted_id;
  
  -- Return the inserted row (selected fields only)
  RETURN QUERY
  SELECT 
    c.id,
    c.text,
    c.created_at,
    c.expires_at,
    c.lat,
    c.lng
  FROM confessions c
  WHERE c.id = v_inserted_id;
END;
$$;

-- Grants already exist from previous migration, but ensure they're set
GRANT EXECUTE ON FUNCTION insert_confession TO anon;
GRANT EXECUTE ON FUNCTION insert_confession TO authenticated;
