import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { OwnerProvider, useOwner } from './OwnerContext.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Today from './pages/Today.jsx';
import Staff from './pages/Staff.jsx';
import Tasks from './pages/Tasks.jsx';
import TaskDetail from './pages/TaskDetail.jsx';
import AlertRoutes from './pages/AlertRoutes.jsx';

function Protected({ children }) {
  const { owner } = useOwner();
  if (owner === undefined) return null; // still loading /api/me
  if (owner === null) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <OwnerProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <Protected>
              <Layout />
            </Protected>
          }
        >
          <Route path="/" element={<Today />} />
          <Route path="/staff" element={<Staff />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/alerts" element={<AlertRoutes />} />
        </Route>
      </Routes>
    </OwnerProvider>
  );
}
