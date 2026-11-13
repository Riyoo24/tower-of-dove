/* =====================================================================
   shared/query.js - lean Supabase reads
   Ask only for the columns the pages use (not select('*')) and cap long lists.
   If the database is missing a column listed here (an older project that has not run every
   numbered SQL file), the read is repeated once with select('*') so the page still works.
   ===================================================================== */

/* Columns the site reads from each view / table (columns no script uses are left out). */
export const COLS = {
    studio: 'studio_id,name,image,description,hourly_rate,status',
    v_equipment_stock: 'equipment_id,name,image,description,category_name,total_quantity,in_use,available,stock_status,add_on_rate,outside_rate,allow_addon,allow_outside,min_hours,owned_quantity,out_of_service',
    v_booking_summary: 'booking_id,booking_ref,status,source,studio_id,studio_name,customer_id,customer_name,customer_number,is_guest,start_at,end_at,hours,total_amount,payment_id,payment_method,gcash_reference,payment_status,created_at,rejected_reason,down_payment,payment_option,balance_paid_amount,balance_paid_at,balance_paid_method,balance_due',
    v_payment_queue: 'payment_id,status,method,gcash_reference,amount,created_at,reference,kind,customer_name,extension_id,payment_option,balance_paid_amount,balance_paid_at,balance_paid_method',
    v_rental_lines: 'rental_ref,rental_type,status,source,customer_id,customer_name,customer_number,booking_ref,rental_detail_id,equipment_id,equipment_name,quantity,unit_price_at_request,rental_hours,line_returned_at,pickup_date,return_date,due_at,days_overdue,rejected_reason,returned_at,created_at,late_fee,down_payment,hours_overdue,balance_paid_amount,balance_paid_at,balance_due,before_photo_path,return_condition,return_description,after_photo_path,handover_photo_path,rental_order_id,issued_at,late_fee_paid_method,late_fee_reference,late_fee_paid_at,late_fee_tendered,late_fee_deferred,late_fee_pending_reference,late_fee_customer_paid_at,late_fee_reject_reason',
    v_booking_extension: 'extension_id,booking_id,booking_ref,customer_id,extra_hours,hourly_rate,extra_cost,down_payment,balance_due,old_end_at,new_end_at,status,rejected_reason,created_at,payment_id,payment_status,payment_method,gcash_reference,payment_option',
    // damage fees of outside rentals (needs 58_damage_charges.sql)
    v_damage_charge: 'damage_charge_id,rental_detail_id,rental_order_id,rental_ref,customer_id,customer_name,equipment_id,equipment_name,quantity,condition,reason,amount,status,paid_method,gcash_reference,customer_paid_at,paid_at,recorded_by,collected_by,created_at,updated_at,line_returned_at,return_description,before_photo_path,after_photo_path,handover_photo_path,line_rental_value'
};

/* Longest lists the site loads at once (newest first). */
export const LIMIT = { bookings: 1000, rentals: 1500, payments: 1000, extensions: 500, mine: 300 };

/* run(table, cols, q => q.order(...).limit(...)) -> the usual { data, error } */
export async function run(sb, table, cols, build) {
    let r = await build(sb.from(table).select(cols));
    if (r.error && cols !== '*' && /42703|PGRST204|column/i.test(`${r.error.code} ${r.error.message}`))
        r = await build(sb.from(table).select('*'));
    return r;
}
