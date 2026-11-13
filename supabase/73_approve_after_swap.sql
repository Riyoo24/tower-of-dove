-- =====================================================================
-- 73_approve_after_swap.sql  (safe to re-run)
-- One Verify only. When staff verify a rental's payment but the item is out of stock, the order stays Pending and
-- staff must replace the item (Swap item, or Let customer choose). As soon as the replacement is in (staff swap, the
-- customer chooses, or the deadline assigns the first choice), the order is APPROVED by itself, so nobody has to
-- verify a second time.
--   * only a Pending order whose own payment is already Verified is approved
--   * the normal stock check still runs; if another line is still short, the order simply stays Pending
--   * the approver is the staff member who verified the payment (not the customer who picked the item)
-- Run once in the Supabase SQL Editor (after 72_customer_swap_followup.sql).
-- =====================================================================

create or replace function public.approve_after_swap() returns trigger
language plpgsql security definer set search_path = public as $$
declare o record; vby bigint;
begin
  select rental_order_id, status into o from public.rental_order where rental_order_id = new.rental_order_id;
  if not found or o.status <> 'Pending' then
    return null;
  end if;
  select p.verified_by into vby
    from public.payment p
   where p.rental_order_id = o.rental_order_id and p.status = 'Verified'
   order by p.payment_id desc limit 1;
  if not found then
    return null;   -- payment not verified yet: nothing to approve
  end if;
  begin
    update public.rental_order
       set status = 'Approved', approved_by = coalesce(approved_by, vby)
     where rental_order_id = o.rental_order_id;   -- the stock check runs here
  exception when others then
    null;          -- still short (another line, or nothing free): stays Pending, the swap itself is kept
  end;
  return null;
end $$;

drop trigger if exists trg_approve_after_swap on public.rental_item_swap;
create trigger trg_approve_after_swap after insert on public.rental_item_swap
  for each row execute function public.approve_after_swap();

-- end of 73_approve_after_swap.sql
