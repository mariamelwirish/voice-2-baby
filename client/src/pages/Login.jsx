import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Mail, Lock } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import api from '../api/client';
import { theme } from '../theme';
import { AuthShell } from '../components/layout/AuthShell';
import { Button, Field } from '../components/ui';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', { email, password });
      login(data.token, data.user);
      navigate(`/${data.user.role}`, { replace: true });
    } catch (err) {
      setError(err.response?.data?.error ?? 'We couldn’t sign you in. Please check your email and password.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to continue">
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
          style={{ marginBottom: 14 }}
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          placeholder="Your password"
          leftIcon={<Lock size={16} color={theme.color.textMuted} />}
          style={{ marginBottom: 18 }}
        />
        {error && (
          <p style={{ color: theme.color.danger, background: theme.color.dangerSoft, padding: '8px 12px', borderRadius: theme.radius.sm, fontSize: 13, margin: '0 0 14px' }}>
            {error}
          </p>
        )}
        <Button type="submit" disabled={loading} style={{ width: '100%' }}>
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Link to="/forgot-password" style={{ color: theme.color.accent, fontWeight: 700, fontSize: 13, textDecoration: 'none' }}>
            Forgot your password?
          </Link>
        </div>
      </form>
    </AuthShell>
  );
}
