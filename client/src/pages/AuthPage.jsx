import { Brain, Lock, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../components/AppShell.jsx';
import { Button, ErrorNote, Field } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const POINTS = [
  { Icon: Search, title: 'Ask your journal anything', body: 'Questions are answered from what you actually wrote, with links back to the entries.' },
  { Icon: Brain, title: 'It remembers what matters', body: 'People, goals and patterns carry over from one conversation to the next.' },
  { Icon: Lock, title: 'Private by design', body: 'Your entries are yours alone. You can see, edit and delete everything it remembers.' },
];

export default function AuthPage({ mode }) {
  const isRegister = mode === 'register';
  const { login, register } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const update = (field) => (event) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };

  async function onSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setFormError('');
    setFieldErrors({});
    try {
      if (isRegister) await register(form);
      else await login({ email: form.email, password: form.password });
      // On success the route guard redirects into the app.
    } catch (error) {
      if (error.status === 422) setFieldErrors(error.fieldErrors);
      else if (error.code === 'email_taken') setFieldErrors({ email: error.message });
      else setFormError(error.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel */}
      <section className="relative hidden flex-col justify-between overflow-hidden bg-accent-soft p-12 lg:flex">
        <Logo />
        <div className="max-w-md">
          <h1 className="font-serif text-[44px] font-medium leading-[1.1] tracking-tight text-ink">
            A journal that <em className="italic text-accent">listens back.</em>
          </h1>
          <ul className="mt-10 space-y-6">
            {POINTS.map(({ Icon, title, body }) => (
              <li key={title} className="flex gap-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface text-accent shadow-card">
                  <Icon className="size-[18px]" aria-hidden />
                </span>
                <div>
                  <p className="font-medium text-ink">{title}</p>
                  <p className="mt-0.5 text-ink-2">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-ink-3">Built with Node.js, PostgreSQL and pgvector.</p>
      </section>

      {/* Form */}
      <section className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm animate-rise">
          <Logo className="mb-10 lg:hidden" />
          <h2 className="font-serif text-[30px] font-medium leading-tight tracking-tight">
            {isRegister ? 'Start your journal' : 'Welcome back'}
          </h2>
          <p className="mt-1.5 text-ink-2">
            {isRegister ? 'Create an account to begin writing.' : 'Sign in to pick up where you left off.'}
          </p>

          <form onSubmit={onSubmit} className="mt-8 space-y-4" noValidate>
            {formError && <ErrorNote>{formError}</ErrorNote>}
            {isRegister && (
              <Field label="Name" value={form.name} onChange={update('name')} error={fieldErrors.name} autoComplete="name" required autoFocus />
            )}
            <Field
              label="Email"
              type="email"
              value={form.email}
              onChange={update('email')}
              error={fieldErrors.email}
              autoComplete="email"
              required
              autoFocus={!isRegister}
            />
            <Field
              label="Password"
              type="password"
              value={form.password}
              onChange={update('password')}
              error={fieldErrors.password}
              hint={isRegister ? 'At least 8 characters.' : undefined}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              required
            />
            <Button type="submit" loading={submitting} className="mt-2 h-11 w-full">
              {isRegister ? 'Create account' : 'Sign in'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-ink-2">
            {isRegister ? 'Already have an account?' : 'New to Inkwell?'}{' '}
            <Link to={isRegister ? '/login' : '/register'} className="font-medium text-accent hover:underline">
              {isRegister ? 'Sign in' : 'Create an account'}
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}
