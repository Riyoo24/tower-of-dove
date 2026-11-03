/* =====================================================================
   account/index.js - entry point of pages/account.html
   Profile page for registered customers: change name, email and password.
   ===================================================================== */

import { mountProfilePanel } from './profilePanel.js';
import { ROOT } from '../config/paths.js';
import { injectChrome, updateSidebarName } from '../shared/layout.js';
import { getUser, isMember } from '../shared/session.js';
import { $ } from '../shared/utils.js';
import '../shared/formRules.js';

injectChrome();   // sidebar + mobile bar

/* Only logged-in customers have an account page; owner and staff use their own profile view. */
const cachedUser = getUser();
if (!cachedUser)
    location.replace(ROOT + 'pages/login.html#login');
else if (!isMember())
    location.replace(ROOT + 'pages/admin.html#a-prof');
else
    mountProfilePanel({
        container: $('#account-profile'),
        emailRedirectUrl: ROOT + 'pages/account.html',
        onNameSaved: updateSidebarName
    });
