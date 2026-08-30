import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const OwnerContext = createContext(null);

export function OwnerProvider({ children }) {
  const [owner, setOwner] = useState(undefined); // undefined = still loading

  useEffect(() => {
    api
      .get('/me')
      .then((d) => setOwner(d.owner))
      .catch(() => setOwner(null));
  }, []);

  async function login(email, password) {
    const { owner } = await api.post('/login', { email, password });
    setOwner(owner);
  }

  async function logout() {
    await api.post('/logout');
    setOwner(null);
  }

  return <OwnerContext.Provider value={{ owner, login, logout }}>{children}</OwnerContext.Provider>;
}

export function useOwner() {
  return useContext(OwnerContext);
}

export function canOverride(owner) {
  return owner?.role === 'owner' || (owner?.role === 'manager' && owner?.can_override);
}
