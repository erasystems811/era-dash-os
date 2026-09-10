import React from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { StaffProvider, useStaff, isPinTier } from './StaffContext.jsx';
import { ScopeProvider } from './ScopeContext.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import PinLogin from './pages/PinLogin.jsx';
import Orders from './pages/Orders.jsx';
import OrderDetail from './pages/OrderDetail.jsx';
import Bookings from './pages/Bookings.jsx';
import Catalogue from './pages/Catalogue.jsx';
import Branches from './pages/Branches.jsx';
import Conversations from './pages/Conversations.jsx';
import ConversationDetail from './pages/ConversationDetail.jsx';
import KnowledgeBase from './pages/KnowledgeBase.jsx';
import Documents from './pages/Documents.jsx';
import Staff from './pages/Staff.jsx';
import ActivityLog from './pages/ActivityLog.jsx';
import Settings from './pages/Settings.jsx';
import Delivery from './pages/Delivery.jsx';
import Voice from './pages/Voice.jsx';
import DineIn from './pages/DineIn.jsx';

// Every path a PIN-tier (Tier 3) session is allowed to land on -- matches
// Layout.jsx's PIN_NAV exactly. Not just a nav-hiding trick: this actually
// redirects a Tier 3 session away from a URL typed or bookmarked directly,
// on top of requireFullAccessApi already refusing the underlying API calls
// server-side either way.
const PIN_ALLOWED_PREFIXES = ['/', '/orders', '/catalogue', '/conversations', '/knowledge-base', '/documents'];

function Protected({ children }) {
  const { staff } = useStaff();
  const location = useLocation();
  if (staff === undefined) return null; // still loading /api/me
  if (staff === null) return <Navigate to="/login" replace />;
  if (isPinTier(staff) && !PIN_ALLOWED_PREFIXES.some((p) => location.pathname === p || location.pathname.startsWith(p + '/'))) {
    return <Navigate to="/" replace />;
  }
  return children;
}

export default function App() {
  return (
    <StaffProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/staff-login" element={<PinLogin />} />
        <Route
          element={
            <Protected>
              <ScopeProvider>
                <Layout />
              </ScopeProvider>
            </Protected>
          }
        >
          <Route path="/" element={<Orders />} />
          <Route path="/orders/:id" element={<OrderDetail />} />
          <Route path="/bookings" element={<Bookings />} />
          <Route path="/catalogue" element={<Catalogue />} />
          <Route path="/branches" element={<Branches />} />
          <Route path="/delivery" element={<Delivery />} />
          <Route path="/voice" element={<Voice />} />
          <Route path="/dinein" element={<DineIn />} />
          <Route path="/conversations" element={<Conversations />} />
          <Route path="/conversations/:id" element={<ConversationDetail />} />
          <Route path="/knowledge-base" element={<KnowledgeBase />} />
          <Route path="/documents" element={<Documents />} />
          <Route path="/staff" element={<Staff />} />
          <Route path="/activity-log" element={<ActivityLog />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </StaffProvider>
  );
}
