import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api.js';
import { useStaff } from './StaffContext.jsx';

const ScopeContext = createContext(null);

// A per-viewer convenience only (which branch this browser last looked
// at) -- never the source of truth for what a branch-locked staff member
// can see, that's enforced server-side (lib/auth.js's scopeToBranch)
// regardless of what's stored here.
const STORAGE_KEY = 'ebos_scope';

// scope is one of:
//   null       -- default, today's exact unscoped view (every existing
//                 page keeps behaving exactly as it does now)
//   'all'      -- the branches comparison view (no order rail)
//   <branch id> -- one specific branch, filtered
export function ScopeProvider({ children }) {
  const { staff } = useStaff();
  const [branches, setBranches] = useState([]);
  const [scope, setScopeState] = useState(null);

  function loadBranches() {
    return api
      .get('/branches')
      .then(setBranches)
      .catch(() => setBranches([]));
  }

  useEffect(() => {
    if (staff) loadBranches();
  }, [staff]);

  // Chidera, 2026-09-20: "why is my ipad orders page still showing me
  // compare branches" -- real bug, not a stale bookmark (found nothing
  // wrong in the earlier search because the switcher itself is invisible
  // on a single-branch business, showScopeSwitcher below). scope is
  // per-device localStorage (STORAGE_KEY's own comment) -- once it's
  // stuck at 'all' or a branch id on a device, and the business later has
  // only 1 branch (or always did, and this got set some other way), the
  // ONLY UI that can ever change it back also stops rendering
  // (Layout.jsx: branches.length > 1). A genuine dead end with no escape
  // except clearing browser storage by hand. Self-heals here instead:
  // once branches actually loads, a stuck scope on a business that no
  // longer has anything to scope BY just gets cleared, same "genuinely
  // inert while off" rule every other add-on in this file already
  // follows.
  useEffect(() => {
    if (branches.length > 1) return;
    if (scope) setScope(null);
  }, [branches, scope]);

  useEffect(() => {
    if (!staff) return;
    // A staff member locked to a branch is hard-pinned to it -- never
    // overridable by anything stored in this browser from a previous
    // login. Everyone else picks up whatever they last looked at here.
    if (staff.branch_id) {
      setScopeState(staff.branch_id);
      return;
    }
    try {
      setScopeState(localStorage.getItem(STORAGE_KEY) || null);
    } catch {
      setScopeState(null);
    }
  }, [staff?.branch_id]);

  function setScope(next) {
    if (staff?.branch_id) return; // locked -- no-op, matches "no branch control anywhere in the UI"
    setScopeState(next);
    try {
      if (next) localStorage.setItem(STORAGE_KEY, next);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private window / storage blocked -- the switcher still works for
      // this page load, it just won't be remembered next visit.
    }
  }

  // Only ever a real, addressable question, never rendered when it can't
  // matter -- see Layout.jsx, which checks branches.length before mounting
  // anything from this context at all.
  const locked = Boolean(staff?.branch_id);

  return (
    <ScopeContext.Provider value={{ scope, setScope, branches, locked, refreshBranches: loadBranches }}>
      {children}
    </ScopeContext.Provider>
  );
}

export function useScope() {
  return useContext(ScopeContext);
}

// The one place every data-fetching page turns "current scope" into the
// query string suffix to append to its api.get(...) calls -- '' for the
// default unscoped view or the all-branches view (that one uses its own
// endpoint, not this), '?branch_id=...' for one selected branch.
export function scopeQuery(scope) {
  return scope && scope !== 'all' ? `?branch_id=${scope}` : '';
}
