import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const StaffContext = createContext(null);

export function StaffProvider({ children }) {
  const [staff, setStaff] = useState(undefined); // undefined = still loading

  useEffect(() => {
    api
      .get('/me')
      .then((d) => setStaff(d.staff))
      .catch(() => setStaff(null));
  }, []);

  async function login(email, password) {
    const { staff } = await api.post('/login', { email, password });
    setStaff(staff);
  }

  // Tier 3 login: pick a branch, pick a name, enter the 4-digit PIN. Sets
  // the same staff shape as the email/password login above -- everything
  // downstream (canEdit, isPinTier, the nav) just reads staff.role/
  // branch_id/auth_type, regardless of which flow set it.
  async function loginWithPin(branchId, staffId, pin) {
    const { staff } = await api.post('/pin-login', { branch_id: branchId, staff_id: staffId, pin });
    setStaff(staff);
  }

  async function logout() {
    await api.post('/logout');
    setStaff(null);
  }

  return <StaffContext.Provider value={{ staff, login, loginWithPin, logout }}>{children}</StaffContext.Provider>;
}

export function useStaff() {
  return useContext(StaffContext);
}

export function canEdit(staff) {
  return staff?.role === 'owner' || staff?.role === 'manager';
}

// Branch-lock, not edit-permission -- orthogonal to canEdit above (a branch
// manager can edit within their branch; an owner can edit everywhere; both
// are still "can edit"). null means "all branches" -- true for every login
// today, and for an owner/admin even once other staff start getting
// locked. Used only by the dashboard's scope switcher to decide whether to
// show one at all, never to gate a feature.
export function visibleBranchId(staff) {
  return staff?.branch_id || null;
}

// Tier 3: name+PIN login, always branch-locked, always the restricted
// 5-tab view -- see Layout.jsx's nav split and App.jsx's route guard.
// Mirrors lib/auth.js's server-side isPinTier; intentionally duplicated
// rather than shared, same as canEdit/visibleBranchId above -- different
// runtimes, not meant to be the same module.
export function isPinTier(staff) {
  return staff?.auth_type === 'pin';
}

// null (owner/manager, or any staff account from before this existed) means
// unrestricted -- same null-means-everything idiom as visibleBranchId
// above. 'online'/'in_house' split floor/counter staff into two
// non-overlapping worlds once a business has dine-in on, see Layout.jsx's
// nav split and lib/auth.js's server-side scopeToWorkArea.
export function workAreaOf(staff) {
  return staff?.work_area || null;
}
