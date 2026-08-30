import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useOwner } from '../OwnerContext.jsx';
import { api } from '../api.js';

const NAV = [
  { to: '/', label: 'Today', end: true },
  { to: '/staff', label: 'Staff' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/alerts', label: 'Alerts' },
];

export default function Layout() {
  const { owner, logout } = useOwner();
  const [businessName, setBusinessName] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    api.get('/business').then((b) => setBusinessName(b?.name || ''));
  }, []);

  // A route change is the clearest signal the owner picked something on
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
        <div className="mobile-header-brand">{businessName || 'ERA StaffFlow'}</div>
      </header>

      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}

      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <div className="brand">
          <span className="brand-mark">SF</span>
          <div>
            StaffFlow
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
        <div className="owner-info">
          <div className="name">{owner?.email}</div>
          <div>{owner?.role}</div>
          <button onClick={logout}>Log out</button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
