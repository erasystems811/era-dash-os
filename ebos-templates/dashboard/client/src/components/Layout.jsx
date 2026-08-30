import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useStaff } from '../StaffContext.jsx';
import { api } from '../api.js';

const NAV = [
  { to: '/', label: 'Orders', end: true },
  { to: '/catalogue', label: 'Catalogue' },
  { to: '/branches', label: 'Branches' },
  { to: '/conversations', label: 'Conversations' },
  { to: '/knowledge-base', label: 'Knowledge base' },
  { to: '/documents', label: 'Documents' },
  { to: '/staff', label: 'Roles and numbers' },
  { to: '/settings', label: 'Settings' },
];

export default function Layout() {
  const { staff, logout } = useStaff();
  const [businessName, setBusinessName] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    api.get('/business').then((b) => setBusinessName(b?.name || ''));
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
            EBOS
            <small>{businessName}</small>
          </div>
        </div>
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
