/* =====================================================================
   admin/state.js - shared variables of the dashboard
   Variables that several dashboard modules change live in this object.
   ===================================================================== */

export const state = {
    bkF: 'All',   // Bookings tab: status filter (also set from Overview shortcuts)
    payF: 'All',
    // Payments tab: status filter (also set from Overview shortcuts)
    // which "Past and closed" groups are open (closed by default; the button in the group row toggles it)
    pastOpen: { bk: false, rn: false, pay: false }
};
