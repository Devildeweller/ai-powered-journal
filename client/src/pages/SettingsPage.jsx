import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, LogOut, Monitor, Moon, Sun, X } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, Dialog, ErrorNote, Field, PageHeader, cx } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { api } from '../lib/api.js';
import { useTheme } from '../lib/theme.js';

function Section({ title, description, children }) {
  return (
    <Card as="section" className="p-4 md:p-6">
      <h2 className="font-serif text-lg font-medium text-ink">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-ink-3">{description}</p>}
      <div className="mt-5">{children}</div>
    </Card>
  );
}

function ProfileForm() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const save = useMutation({
    mutationFn: () => api('/auth/me', { method: 'PATCH', body: { name } }),
    onSuccess: (data) => {
      setUser(data.user);
      toast.success('Profile updated');
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
      className="max-w-sm space-y-4"
    >
      <Field label="Name" value={name} onChange={(event) => setName(event.target.value)} error={save.error?.fieldErrors.name} maxLength={80} required />
      <Field label="Email" value={user.email} readOnly disabled hint="Your sign-in email cannot be changed." />
      <Button type="submit" loading={save.isPending} disabled={!name.trim() || name.trim() === user.name}>
        Save profile
      </Button>
    </form>
  );
}

function PasswordForm() {
  const { replaceAccessToken } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' });
  const change = useMutation({
    mutationFn: () => api('/auth/change-password', { method: 'POST', body: form }),
    onSuccess: (data) => {
      replaceAccessToken(data.accessToken);
      setForm({ currentPassword: '', newPassword: '' });
      toast.success('Password changed. Other devices have been signed out.');
    },
  });
  const fieldErrors = change.error?.status === 422 ? change.error.fieldErrors : {};

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        change.mutate();
      }}
      className="max-w-sm space-y-4"
    >
      {change.error && change.error.status !== 422 && <ErrorNote>{change.error.message}</ErrorNote>}
      <Field
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={form.currentPassword}
        onChange={(event) => setForm({ ...form, currentPassword: event.target.value })}
        error={fieldErrors.currentPassword}
        required
      />
      <Field
        label="New password"
        type="password"
        autoComplete="new-password"
        value={form.newPassword}
        onChange={(event) => setForm({ ...form, newPassword: event.target.value })}
        error={fieldErrors.newPassword}
        hint="At least 8 characters."
        required
      />
      <Button type="submit" loading={change.isPending} disabled={!form.currentPassword || form.newPassword.length < 8}>
        Change password
      </Button>
    </form>
  );
}

const THEMES = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
];

function ThemePicker() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="inline-flex rounded-xl border border-line-strong bg-surface p-1" role="radiogroup" aria-label="Theme">
      {THEMES.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          onClick={() => setTheme(value)}
          className={cx(
            'inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-sm font-medium transition-colors',
            theme === value ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:text-ink',
          )}
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}

function FeatureRow({ enabled, label, detail }) {
  const Icon = enabled ? Check : X;
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className={cx('mt-0.5 grid size-5 shrink-0 place-items-center rounded-full', enabled ? 'bg-accent-soft text-accent' : 'bg-sunken text-ink-3')}>
        <Icon className="size-3" aria-hidden />
      </span>
      <span>
        <span className="block text-sm font-medium text-ink">
          {label} <span className="font-normal text-ink-3">· {enabled ? 'on' : 'off'}</span>
        </span>
        <span className="block text-[13px] text-ink-3">{detail}</span>
      </span>
    </li>
  );
}

function Deployment() {
  const config = useQuery({ queryKey: ['config'], queryFn: () => api('/config'), staleTime: Infinity });
  if (!config.data) return null;
  const { features, models } = config.data;
  return (
    <ul className="divide-y divide-line">
      <FeatureRow
        enabled={features.assistant}
        label="AI assistant"
        detail={features.assistant ? `Answers are written by ${models.chat}.` : 'Set GEMINI_API_KEY on the server to enable chat.'}
      />
      <FeatureRow
        enabled={features.semanticEmbeddings}
        label="Semantic search"
        detail={
          features.semanticEmbeddings
            ? `Entries are embedded with ${models.embeddings}.`
            : 'Using the offline keyword embedder. Set GEMINI_API_KEY on the server for search by meaning.'
        }
      />
      <FeatureRow
        enabled={features.memoryExtraction}
        label="Long-term memory"
        detail="The assistant saves durable facts from your entries and conversations."
      />
      <FeatureRow
        enabled={features.attachments}
        label="Photo attachments"
        detail={features.attachments ? 'Photos are stored privately in Amazon S3.' : 'Set S3_BUCKET and AWS credentials on the server to attach photos.'}
      />
    </ul>
  );
}

function DeleteAccount() {
  const { clear } = useAuth();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const remove = useMutation({
    mutationFn: () => api('/auth/me', { method: 'DELETE', body: { password } }),
    onSuccess: clear,
  });
  const close = () => {
    setOpen(false);
    setPassword('');
    remove.reset();
  };

  return (
    <>
      <Button variant="dangerGhost" className="border border-danger/40" onClick={() => setOpen(true)}>
        Delete my account
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title="Delete your account?"
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => remove.mutate()} loading={remove.isPending} disabled={!password}>
              Delete everything
            </Button>
          </>
        }
      >
        <p>Your entries, photos, conversations and memories will be permanently deleted. This cannot be undone.</p>
        <div className="mt-4 space-y-3">
          {remove.error && <ErrorNote>{remove.error.message}</ErrorNote>}
          <Field
            label="Enter your password to confirm"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
      </Dialog>
    </>
  );
}

export default function SettingsPage() {
  const { logout } = useAuth();
  return (
    <>
      <PageHeader
        title="Settings"
        actions={
          <Button variant="secondary" onClick={logout}>
            <LogOut className="size-4" aria-hidden />
            Sign out
          </Button>
        }
      />
      <div className="space-y-4">
        <Section title="Profile">
          <ProfileForm />
        </Section>
        <Section title="Appearance" description="Inkwell follows your device by default.">
          <ThemePicker />
        </Section>
        <Section title="Password" description="Changing your password signs you out everywhere else.">
          <PasswordForm />
        </Section>
        <Section title="This deployment" description="Which optional services the server is connected to.">
          <Deployment />
        </Section>
        <Section title="Delete account" description="Remove your account and all of its data from Inkwell.">
          <DeleteAccount />
        </Section>
      </div>
    </>
  );
}
