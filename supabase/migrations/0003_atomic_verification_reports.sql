-- Atomic report + evidence save. Additive migration: no existing rows or RLS policies change.
begin;

create or replace function public.save_verification_report(p_report jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_report public.verification_reports%rowtype;
  v_id uuid;
  v_opportunity_id uuid;
  v_expected jsonb;
  v_actual jsonb;
  v_evidence jsonb;
begin
  if p_report is null or jsonb_typeof(p_report) is distinct from 'object'
    or jsonb_typeof(p_report->'findings') is distinct from 'array'
    or jsonb_typeof(p_report->'evidence') is distinct from 'array'
    or (p_report->>'status') is null
    or (p_report->>'status') not in ('VERIFIED','PARTIALLY_VERIFIED','UNVERIFIED','CONFLICTING','RISK_FLAGGED')
  then
    raise exception 'Invalid verification report payload' using errcode = '22023';
  end if;
  v_id := (p_report->>'id')::uuid;
  v_opportunity_id := (p_report->>'opportunity_id')::uuid;
  if v_id is null or v_opportunity_id is null then
    raise exception 'Report and opportunity IDs are required' using errcode = '22023';
  end if;

  -- Typed normalization makes timestamp representations and evidence order irrelevant on retry.
  select coalesce(jsonb_agg(to_jsonb(e) order by to_jsonb(e)::text), '[]'::jsonb)
    into v_expected
    from jsonb_to_recordset(p_report->'evidence') as e(
      source_url text, source_type text, excerpt text, retrieved_at timestamptz, supports text, confidence numeric
    );

  insert into public.verification_reports(id, opportunity_id, status, summary, findings)
    values(v_id, v_opportunity_id, p_report->>'status', p_report->>'summary', p_report->'findings')
    on conflict (id) do nothing
    returning * into v_report;

  if found then
    -- Do not catch errors here: a failed evidence insert must roll back the parent insert too.
    insert into public.evidence_items(report_id, source_url, source_type, excerpt, retrieved_at, supports, confidence)
      select v_id, e.source_url, e.source_type, e.excerpt, e.retrieved_at, e.supports, e.confidence
      from jsonb_to_recordset(v_expected) as e(
        source_url text, source_type text, excerpt text, retrieved_at timestamptz, supports text, confidence numeric
      );
  else
    -- Same ID + same payload is an idempotent retry, never permission to overwrite a historical report.
    select * into v_report from public.verification_reports where id = v_id;
    select coalesce(jsonb_agg(to_jsonb(e) order by to_jsonb(e)::text), '[]'::jsonb)
      into v_actual from (
        select source_url, source_type, excerpt, retrieved_at, supports, confidence
        from public.evidence_items where report_id = v_id
      ) e;
    if v_report.id is null
      or v_report.opportunity_id is distinct from v_opportunity_id
      or v_report.status is distinct from (p_report->>'status')
      or v_report.summary is distinct from (p_report->>'summary')
      or v_report.findings is distinct from (p_report->'findings')
      or v_actual is distinct from v_expected
    then
      raise exception 'Report ID already exists with different content; nothing was overwritten' using errcode = '23505';
    end if;
  end if;

  select coalesce(jsonb_agg(to_jsonb(e) order by e.id), '[]'::jsonb) into v_evidence
    from public.evidence_items e where e.report_id = v_id;
  return to_jsonb(v_report) || jsonb_build_object('evidence_items', v_evidence);
end;
$$;

-- Caller privileges and the existing table RLS still apply. No SECURITY DEFINER or write-policy grant.
revoke all on function public.save_verification_report(jsonb) from public, anon;
grant execute on function public.save_verification_report(jsonb) to authenticated, service_role;
notify pgrst, 'reload schema';
commit;
