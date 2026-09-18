-- 0007: public booking pages — unauthenticated lookup bridge.
-- booking_pages is store-scoped RLS (admin CRUD runs under personal GUCs).
-- The public form needs exactly one read path: slug -> safe display fields.
-- No list/search surface exists publicly (slug is a high-entropy URL part,
-- unique globally); submissions go through the normal bookings path in
-- app code under resolved tenant GUCs, never through this bridge.
BEGIN;

CREATE OR REPLACE FUNCTION nightclub.booking_page_lookup(p_slug text)
  RETURNS TABLE(tenant_id uuid, store_id uuid, event_id uuid,
                title text, message text, collect_phone boolean,
                max_party integer,
                event_name text, event_starts_at timestamptz,
                store_name text, currency char(3))
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nightclub, public AS $$
  SELECT bp.tenant_id, bp.store_id, bp.event_id,
         bp.title, bp.message, bp.collect_phone, bp.max_party,
         e.name, e.opens_at, s.name, s.currency
    FROM nightclub.booking_pages bp
    JOIN nightclub.events e
      ON e.tenant_id = bp.tenant_id AND e.store_id = bp.store_id
     AND e.id = bp.event_id
    JOIN nightclub.stores s
      ON s.tenant_id = bp.tenant_id AND s.id = bp.store_id
   WHERE bp.slug = lower(p_slug) AND bp.status = 'OPEN'
     AND e.status NOT IN ('CANCELED')
$$;

REVOKE ALL ON FUNCTION nightclub.booking_page_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nightclub.booking_page_lookup(text) TO app_runtime;

COMMIT;
