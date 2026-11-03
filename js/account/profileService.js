/* =====================================================================
   account/profileService.js - profile management for logged-in accounts
   Used by pages/account.html (customers) and the Owner/Staff profile view in pages/admin.html.
   DB: auth.updateUser (email, password), tables app_user (owner, staff) and customer.
   Every function throws an Error with a message that is safe to show on screen.
   ===================================================================== */

import { requestPasswordReset } from '../auth/authService.js';
import { sb } from '../config/supabaseClient.js';
import { getUser, setUser } from '../shared/session.js';
import { isEmail, isName, normalizeEmail } from '../shared/utils.js';

const STAFF_TABLE = 'app_user';
const CUSTOMER_TABLE = 'customer';

/* Everything the profile forms need: which table holds the person, their name and login email. */
export async function loadAccountProfile() {
    const { data: authData } = await sb.auth.getUser();
    const authUser = authData && authData.user;
    if (!authUser)
        return null;

    const { data: staffRow } = await sb.from(STAFF_TABLE)
        .select('username, first_name, last_name, role').eq('auth_user_id', authUser.id).maybeSingle();
    const { data: customerRow } = staffRow ? { data: null } : await sb.from(CUSTOMER_TABLE)
        .select('username, first_name, last_name').eq('auth_user_id', authUser.id).maybeSingle();

    const profileRow = staffRow || customerRow;
    if (!profileRow)
        return null;

    return {
        profileTable: staffRow ? STAFF_TABLE : CUSTOMER_TABLE,
        authUserId: authUser.id,
        roleName: staffRow ? staffRow.role : 'Customer',
        username: profileRow.username || '',
        firstName: profileRow.first_name || '',
        lastName: profileRow.last_name || '',
        loginEmail: authUser.email || '',
        pendingEmail: authUser.new_email || ''   // set while an email change waits for its confirmation link
    };
}

/* Cache database values and notify the current page; storage events update other tabs. */
function applyDisplayName(profile) {
    const cachedUser = getUser();
    if (!cachedUser)
        return null;
    setUser({
        ...cachedUser,
        label: profile.username,
        username: profile.username,
        firstName: profile.firstName,
        lastName: profile.lastName
    });
    return profile.username;
}

export function syncDisplayName(profile) {
    return applyDisplayName(profile);
}

/* Saves username, first name and last name in one database update.
   The label comes from the row the database sends back, so the sidebar always shows what was really stored. */
export async function updateAccountName(profile, usernameInput, firstNameInput, lastNameInput) {
    const username = usernameInput.trim().toLowerCase();
    if (!/^[a-z0-9_.]{3,30}$/.test(username))
        throw new Error('Use 3-30 letters, numbers, underscores or periods for your username.');
    const firstName = firstNameInput.trim();
    const lastName = lastNameInput.trim();
    if (!firstName)
        throw new Error('Enter your first name.');
    if (!isName(firstName) || (lastName && !isName(lastName)))
        throw new Error('Names can only contain letters.');
    if (profile.profileTable === STAFF_TABLE && !lastName)
        throw new Error('Enter your last name.');

    const { data: savedRow, error } = await sb.from(profile.profileTable)
        .update({
            username,
            first_name: firstName,
            last_name: lastName
        })
        .eq('auth_user_id', profile.authUserId)
        .select('username, first_name, last_name')
        .maybeSingle();
    if (error?.code === '23505')
        throw new Error('That username is already taken. Choose another.');
    if (error || !savedRow)
        throw new Error('Could not save your account name. Please try again.');

    profile.username = savedRow.username || '';
    profile.firstName = savedRow.first_name || '';
    profile.lastName = savedRow.last_name || '';
    return applyDisplayName(profile);
}

/* Supabase e-mails a confirmation link to the new address (and the old one, when "Secure email change" is on).
   The login email only changes after the link is opened. The database trigger in
   supabase/26_profile_management.sql then copies the new address into the profile row. */
export async function requestEmailChange(profile, newEmailInput, redirectUrl) {
    const newEmail = normalizeEmail(newEmailInput);
    if (!isEmail(newEmail))
        throw new Error('Enter a valid email address, like name@gmail.com.');
    if (newEmail === normalizeEmail(profile.loginEmail))
        throw new Error('That is already your email address.');

    const { error } = await sb.auth.updateUser({ email: newEmail }, { emailRedirectTo: redirectUrl });
    if (error) {
        if (/already|registered|exists/i.test(error.message))
            throw new Error('That email address is already used by another account.');
        if (/rate|seconds|too many/i.test(error.message))
            throw new Error('Please wait a minute before asking for another email.');
        throw new Error('Could not change the email address. Please try again.');
    }
    profile.pendingEmail = newEmail;
    return newEmail;
}

/* The password is never changed on this page. Supabase e-mails a reset link to the login address, and the new
   password is chosen on the login page after that link is opened (see setNewPassword in auth/authService.js). */
export async function requestPasswordChangeEmail(profile) {
    await requestPasswordReset(profile.loginEmail);
}
