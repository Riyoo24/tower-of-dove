# Tower of Dove Music Studio

Open `index.html` to start.

```
index.html              Home (landing page)
pages/
  customer.html         Book a studio, rent equipment, my bookings, my rentals
  admin.html            Owner and staff dashboard
  login.html            Log in and register
css/
  style.css             Shared styles
js/
  shared.js             Config (ROUTES, STUDIOS, EQUIPMENT), helpers, session, sidebar
  home.js               Home page
  customer.js           Customer page
  login.js              Log in and register
  admin.js              Owner and staff dashboard
assets/
  img/logo.png
```

Links are set in `ROUTES` in `js/shared.js`, relative to the site root.
To add a page, put the HTML in `pages/`, its script in `js/`, and add a route.

## Owner and staff dashboard

`pages/admin.html` (script: `js/admin.js`). Log in with the username `owner` or `staff`
(any password, demo only). Staff do not see Studio Management, Reports or Settings.
All dashboard data is demo data inside `js/admin.js`, ready to swap for backend calls.
