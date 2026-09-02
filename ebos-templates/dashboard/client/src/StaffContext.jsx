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

  async function logout() {
    await api.post('/logout');
    setStaff(null);
  }

  return <StaffContext.Provider value={{ staff, login, logout }}>{children}</StaffContext.Provider>;
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
