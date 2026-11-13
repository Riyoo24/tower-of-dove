-- =====================================================================
-- 72_customer_swap_followup.sql
-- Lets the customer's My rental page know that a rental is waiting for the studio to follow up, so the status can say
-- "Studio will contact you" instead of a plain "Approved".
--
-- That is the case when the customer said "None of these suit me" (offer Declined) or did not answer in time and nothing
-- could be assigned (offer Expired), and the line has not been swapped by staff since. It ends by itself as soon as staff
-- swap the item, or the rental is issued, returned, rejected or cancelled.
--
-- Run once in the Supabase SQL Editor (after 71_customer_swap_choice.sql). Safe to run again.
-- =====================================================================

drop function if exists public.my_swap_followups();
create function public.my_swap_followups()
returns table (rental_ref text, status text)
language sql stable security definer set search_path = public as $$
  select f.rental_ref::text, f.status::text
    from public.rental_swap_offer f
    join public.rental_order o on o.rental_order_id = f.rental_order_id
   where o.customer_id = public.current_customer_id()
     and o.status in ('Pending', 'Approved')
     and f.status in ('Declined', 'Expired')
     -- only the newest offer of each rental line counts
     and f.offer_id = (select max(x.offer_id) from public.rental_swap_offer x where x.rental_detail_id = f.rental_detail_id)
     -- and staff have not swapped that line since
     and not exists (select 1 from public.rental_item_swap s
                      where s.rental_detail_id = f.rental_detail_id
                        and s.created_at >= coalesce(f.resolved_at, f.created_at));
$$;
grant execute on function public.my_swap_followups() to authenticated;

-- end of 72_customer_swap_followup.sql
