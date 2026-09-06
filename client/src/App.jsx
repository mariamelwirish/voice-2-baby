import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute } from './components/layout/ProtectedRoute';
import { useAuth } from './hooks/useAuth';
import Login from './pages/Login';
import Signup from './pages/Signup';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import ParentDashboard from './pages/parent/ParentDashboard';
import NurseLayout from './pages/nurse/NurseLayout';
import AdminLayout from './pages/admin/AdminLayout';

// Sends logged-in users to their role's dashboard, guests to /login
function RootRedirect() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={`/${user.role}`} replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Public routes — no auth needed */}
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />

          {/* Protected routes — wrong role gets redirected to their own dashboard */}
          <Route
            path="/admin/*"
            element={<ProtectedRoute role="admin"><AdminLayout /></ProtectedRoute>}
          />
          <Route
            path="/nurse/*"
            element={<ProtectedRoute role="nurse"><NurseLayout /></ProtectedRoute>}
          />
          <Route
            path="/parent/*"
            element={<ProtectedRoute role="parent"><ParentDashboard /></ProtectedRoute>}
          />

          {/* Root → role-based redirect */}
          <Route path="/" element={<RootRedirect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
