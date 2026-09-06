import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, CheckCircle2 } from 'lucide-react';
import api from '../api/client';
import { theme } from '../theme';
import { AuthShell } from '../components/layout/AuthShell';
import { Button, Field } from '../components/ui';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // The server always responds success (it won't reveal whether the email
      // has an account), so we just show the confirmation screen.
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } catch (err) {
      setError(err.response?.data?.error ?? 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        footer={<Link to="/login" style={{ color: theme.color.accent, fontWeight: 700, textDecoration: 'none' }}>Back to sign in</Link>}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, color: theme.color.success }}>
          <CheckCircle2 size={26} style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ color: theme.color.text, fontSize: 14 }}>
            If an account exists for <strong>{email}</strong>, we’ve sent a link to reset your
            password. The link expires in 1 hour.
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Forgot your password?"
      subtitle="Enter your email and we’ll send you a reset link"
      footer={<Link to="/login" style={{ color: theme.color.accent, fontWeight: 700, textDecoration: 'none' }}>Back to sign in</Link>}
    >
      <form onSubmit={handleSubmit}>
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
          placeholder="you@example.com"
          leftIcon={<Mail size={16} color={theme.color.textMuted} />}
          style={{ marginBottom: 18 }}
        />
        {error && (
          <p style={{ color: theme.color.danger, background: theme.color.dangerSoft, padding: '8px 12px', borderRadius: theme.radius.sm, fontSize: 13, margin: '0 0 14px' }}>
            {error}
          </p>
        )}
        <Button type="submit" disabled={loading} style={{ width: '100%' }}>
          {loading ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
    </AuthShell>
  );
}
