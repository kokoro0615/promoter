-- 0006: auth step-up exposure + auth-alternative support.
-- auth_resolve_session gains step_up_at so request context can enforce the
-- money-area step-up gate. CREATE OR REPLACE cannot change a function's
-- return type, so it is dropped and recreated with the widened signature.
BEGIN;

DROP FUNCTION nightclub.auth_resolve_session(text);
CREATE FUNCTION nightclub.auth_resolve_session(p_token_hash text)
  RETURNS TABLE(session_id uuid, user_id uuid, user_status text,
                expires_at timestamptz, revoked_at timestamptz,
                step_up_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nightclub, public AS $$
  SELECT s.id, s.user_id, u.status, s.expires_at, s.revoked_at, s.step_up_at
  FROM nightclub.auth_sessions s JOIN nightclub.app_users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash
$$;
REVOKE ALL ON FUNCTION nightclub.auth_resolve_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nightclub.auth_resolve_session(text) TO app_runtime;

-- email_link_redeem also returns the token's email so the bind-confirm flow
-- can persist the identity without touching the deny-all table directly.
DROP FUNCTION nightclub.email_link_redeem(text);
CREATE FUNCTION nightclub.email_link_redeem(p_token_hash text)
  RETURNS TABLE(user_id uuid, email text, already_used boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
DECLARE
  v_tok nightclub.email_login_tokens%ROWTYPE;
BEGIN
  UPDATE nightclub.email_login_tokens
     SET attempts = attempts + 1
   WHERE token_hash = p_token_hash
  RETURNING * INTO v_tok;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_tok.used_at IS NOT NULL THEN
    RETURN QUERY SELECT NULL::uuid, v_tok.email, true; RETURN;
  END IF;
  IF v_tok.expires_at <= CURRENT_TIMESTAMP OR v_tok.attempts > 10 THEN
    RETURN; END IF;
  UPDATE nightclub.email_login_tokens SET used_at = CURRENT_TIMESTAMP
   WHERE id = v_tok.id;
  RETURN QUERY SELECT v_tok.user_id, v_tok.email, false;
END $$;
REVOKE ALL ON FUNCTION nightclub.email_link_redeem(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nightclub.email_link_redeem(text) TO app_runtime;

COMMIT;
