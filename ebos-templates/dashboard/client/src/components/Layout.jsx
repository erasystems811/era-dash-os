import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useStaff, isPinTier, workAreaOf } from '../StaffContext.jsx';
import { useScope } from '../ScopeContext.jsx';
import { api } from '../api.js';

// Order is Chidera's own explicit call, 2026-09-03: "orders-conversations-
// delivery-catalogue-knowledge base-branches-documents-roles and numbers-
// activity log-settings". Delivery/Voice aren't listed here since they're
// add-ons spliced in conditionally below (right after Conversations, so
// they land in the same spot the requested order puts Delivery).
//
// Branches removed from here, 2026-09-16 -- Chidera: "remove that branches
// tab i should be the one able to add a branch not them" then "customer
// with no branch shouldnt have branch tab". Two separate things: adding a
// branch stays ERA's own call (Branches.jsx's own "Add branch" form is
// gated off below, not removed here), and the TAB itself is spliced in
// conditionally further down, alongside the other add-ons, only once a
// business actually has 2+ branches to look at -- a single-location
// business has nothing to show there at all.
const BASE_NAV = [
  { to: '/', label: 'Orders', end: true },
  { to: '/conversations', label: 'Conversations' },
  { to: '/catalogue', label: 'Catalogue' },
  { to: '/knowledge-base', label: 'Knowledge base' },
  { to: '/documents', label: 'Documents' },
  { to: '/feedback', label: 'Feedback' },
  { to: '/staff', label: 'Roles and numbers' },
  { to: '/activity-log', label: 'Activity log' },
  { to: '/settings', label: 'Settings' },
];

// Tier 3 (PIN) staff -- exactly these 5, nothing else, regardless of
// add-ons the business has on (Delivery/Voice included) or how many
// branches exist. No Branches/Staff/Settings/Activity log: none of those
// are staff's to see, per the RBAC spec, and requireFullAccessApi already
// blocks the underlying API calls server-side even if this list were
// bypassed some other way -- this is the "don't even render the tab" half
// of that same defense-in-depth.
const PIN_NAV = [
  { to: '/', label: 'Orders', end: true },
  { to: '/conversations', label: 'Conversations' },
  { to: '/catalogue', label: 'Catalogue' },
  { to: '/knowledge-base', label: 'Knowledge base' },
  { to: '/documents', label: 'Documents' },
];

// work_area splits PIN staff further, once a business has dine-in on --
// Chidera 2026-09-11: "theyll be 2 types of staff... the in house and
// online staff... i can just give them their part to manage." 'online'
// stays PIN_NAV's Orders board (server-side filtered to non-dine-in
// orders, lib/auth.js's scopeToWorkArea) and never sees Dine-in.
// 'in_house' is deliberately the SMALLEST nav in the app -- just their
// pending-orders queue and the table/QR management they'd actually need on
// the floor, nothing a counter/delivery-focused tab would ever mean to
// them.
const IN_HOUSE_NAV = [
  { to: '/in-house', label: 'In House', end: true },
  { to: '/dinein', label: 'Dine-in' },
];

export default function Layout() {
  const { staff, logout } = useStaff();
  const { scope, setScope, branches, locked } = useScope();
  const [businessName, setBusinessName] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  // Delivery (own_riders mode) is an ERA-switched add-on -- off by default,
  // and "off" must be genuinely inert: with mode !== 'own_riders', this nav
  // item doesn't exist in the DOM at all, not just hidden, exactly the same
  // "no navigation item appears" rule the branch scope switcher above
  // already follows.
  const [deliveryMode, setDeliveryMode] = useState('none');
  // Voice ordering add-on -- same "genuinely inert while off" rule as
  // deliveryMode above.
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  // Dine-in add-on (QR table ordering) -- same "genuinely inert while off"
  // rule as deliveryMode/voiceEnabled above.
  const [dineinEnabled, setDineinEnabled] = useState(false);
  // Customer database (CRM) add-on -- same "genuinely inert while off"
  // rule as the other add-ons above.
  const [crmEnabled, setCrmEnabled] = useState(false);
  // POS sync add-on (real Moniepoint terminal transactions) -- same
  // "genuinely inert while off" rule as the other add-ons above.
  const [posEnabled, setPosEnabled] = useState(false);
  const location = useLocation();
  // Zero DOM below one branch, not just hidden -- a single-location
  // business must not be able to tell this feature exists at all. Also
  // never shown to a branch-locked staff member, regardless of how many
  // branches the business has -- "no branch control anywhere in the
  // interface" is the whole point of locking them, not a default to
  // override.
  const showScopeSwitcher = branches.length > 1 && !locked;

  const addOnItems = [
    ...(deliveryMode === 'own_riders' ? [{ to: '/delivery', label: 'Delivery' }] : []),
    ...(voiceEnabled ? [{ to: '/voice', label: 'Voice' }] : []),
    ...(dineinEnabled ? [{ to: '/dinein', label: 'Dine-in' }] : []),
    ...(crmEnabled ? [{ to: '/customers', label: 'Customers' }] : []),
    ...(posEnabled ? [{ to: '/pos', label: 'POS' }] : []),
  ];
  // Staff/Settings/Activity log stay owner-or-manager-visible in the nav
  // even when branch-locked; requireEditorApi on their write routes already
  // governs who can actually change anything once there. Branches is
  // spliced in here (not folded into addOnItems above, which all land
  // right after Conversations) so it keeps its own requested position --
  // "orders-conversations-...-knowledge base-branches-documents-..." --
  // right after Knowledge base, only once there's actually more than one
  // branch to look at.
  const baseNav =
    branches.length > 1
      ? [...BASE_NAV.slice(0, 4), { to: '/branches', label: 'Branches' }, ...BASE_NAV.slice(4)]
      : BASE_NAV;
  const workArea = workAreaOf(staff);
  // The /in-house URL is deliberately handed out as its own link (Chidera
  // 2026-09-11: "i need a era-demo.erasystems.com.ng/in-house link that
  // opend the management for the in house guest, so staffs arent
  // confused") -- so it must show only these 2 tabs for WHOEVER is
  // logged in while looking at it, not only for an account actually
  // locked to work_area = 'in_house'. Found live: an owner/manager
  // opening that same link saw their own full sidebar instead, because
  // the nav was keyed off the session's work_area alone with no regard
  // for which page they were actually on.
  const onInHousePage = location.pathname === '/in-house' || location.pathname.startsWith('/in-house/');
  const NAV =
    workArea === 'in_house' || onInHousePage
      ? IN_HOUSE_NAV
      : isPinTier(staff)
        ? PIN_NAV
        : addOnItems.length
          ? [...baseNav.slice(0, 2), ...addOnItems, ...baseNav.slice(2)]
          : baseNav;

  useEffect(() => {
    api.get('/business').then((b) => setBusinessName(b?.name || ''));
    api.get('/delivery-config').then((c) => setDeliveryMode(c?.mode || 'none'));
    api.get('/voice-config').then((c) => setVoiceEnabled(Boolean(c?.enabled)));
    api.get('/dinein-config').then((c) => setDineinEnabled(Boolean(c?.enabled)));
    api.get('/crm-config').then((c) => setCrmEnabled(Boolean(c?.enabled)));
    api.get('/pos-sync-config').then((c) => setPosEnabled(Boolean(c?.enabled)));
  }, []);

  // A route change is the clearest signal the user picked something on
  // mobile -- close the drawer so the next screen isn't hidden behind it.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  return (
    <div className="app-shell">
      <header className="mobile-header">
        <button className="nav-toggle" aria-label="Open menu" onClick={() => setNavOpen(true)}>
          ☰
        </button>
        <div className="mobile-header-brand">{businessName || 'EBOS'}</div>
      </header>

      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}

      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <div className="brand">
          <span className="brand-mark">EB</span>
          <div>
            {businessName || 'EBOS'}
            <small>Powered by ERA Systems</small>
          </div>
        </div>
        {showScopeSwitcher && (
          <div className="scope-switcher">
            <label>Viewing</label>
            <select value={scope === 'all' ? 'all' : scope || ''} onChange={(e) => setScope(e.target.value || null)}>
              <option value="">All orders</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
              <option value="all">Compare branches</option>
            </select>
          </div>
        )}
        <nav>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="staff-info">
          <div className="name">{staff?.name}</div>
          <div>{staff?.role}</div>
          <button onClick={logout}>Log out</button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
