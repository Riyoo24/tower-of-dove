/* =====================================================================
   admin/profile.js - Owner / Staff profile view (#a-prof)
   Opened from the sidebar name (owner and staff land on the Overview after logging in, not here).
   Name, email and password forms come from account/profilePanel.js.
   ===================================================================== */

import { OWNER } from './helpers.js';
import { mountProfilePanel } from '../account/profilePanel.js';
import { ROOT } from '../config/paths.js';
import { updateSidebarName } from '../shared/layout.js';
import { $ } from '../shared/utils.js';

export function initProfileView() {
    $('#a-prof h1').textContent = OWNER ? 'Owner profile' : 'My profile';
    return mountProfilePanel({
        container: $('#owner-profile-panel'),
        emailRedirectUrl: ROOT + 'pages/admin.html#a-prof',
        onNameSaved: updateSidebarName
    });
}
