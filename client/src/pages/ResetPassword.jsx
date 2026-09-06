import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Lock, CheckCircle2 } from 'lucide-react';
import api from '../api/client';
import { theme } from '../theme';
import { AuthShell } from '../components/layout/AuthShell';
import { Button, Field } from '../components/ui';

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!token) {
    return (
      <AuthShell
        title="Reset link not valid"
        footer={<Link to="/forgot-password" style={{ color: theme.color.accent, fontWeight: 700, textDecoration: 'none' }}>Request a new link</Link>}
      >
        <p style={{ color: theme.color.textMuted, fontSize: 14, margin: 0 }}>
          This password-reset link is missing or incomplete. Please request a new one.
        </p>
      </AuthShell>
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('The two passwords don’t match.');
      return;
    }
    if (password.length < 8) {
      setError('Please choose a password with at least 8 characters.');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      setSuccess(true);
      setTimeout(() => navigate('/login', { replace: true }), 2500);
    } catch (err) {
      setError(err.response?.data?.error ?? 'We couldn’t reset your password. The link may have expired.');
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <AuthShell title="Password updated">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: theme.color.success }}>
          <CheckCircle2 size={28} />
          <div style={{ color: theme.color.text, fontSize: 14 }}>
            Your password has been reset. Taking you to sign in…
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle="Enter a new password for your account">
      <form onSubmit={handleSubmit}>
        <Field
          label="New password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoFocus
          hint="At least 8 characters"
          placeholder="Create a password"
          leftIcon={<Lock size={16} color={theme.color.textMuted} />}
          style={{ marginBottom: 14 }}
        />
        <Field
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          placeholder="Re-enter your password"
          leftIcon={<Lock size={16} color={theme.color.textMuted} />}
          style={{ marginBottom: 18 }}
        />
        {error && (
          <p style={{ color: theme.color.danger, background: theme.color.dangerSoft, padding: '8px 12px', borderRadius: theme.radius.sm, fontSize: 13, margin: '0 0 14px' }}>
            {error}
          </p>
        )}
        <Button type="submit" disabled={loading} style={{ width: '100%' }}>
          {loading ? 'Updating…' : 'Reset password'}
        </Button>
      </form>
    </AuthShell>
  );
}
