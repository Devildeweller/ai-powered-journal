import { lazy } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import AppShell from './components/AppShell.jsx';
import { Spinner } from './components/ui.jsx';
import { useAuth } from './context/AuthContext.jsx';
import AuthPage from './pages/AuthPage.jsx';
import EntryPage from './pages/EntryPage.jsx';
import JournalPage from './pages/JournalPage.jsx';

// Pages that are not needed for the first screen load on demand, which keeps
// the Markdown renderer and the charts out of the initial bundle.
const ChatPage = lazy(() => import('./pages/ChatPage.jsx'));
const InsightsPage = lazy(() => import('./pages/InsightsPage.jsx'));
const MemoriesPage = lazy(() => import('./pages/MemoriesPage.jsx'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'));

function FullScreenLoader() {
  return (
    <div className="grid min-h-dvh place-items-center text-ink-3" role="status" aria-label="Loading">
      <Spinner className="size-6" />
    </div>
  );
}

/** Signed-in area: bounces to /login and remembers where the user was heading. */
function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullScreenLoader />;
  if (status === 'signedOut') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

/** Login and register are only for visitors who are not signed in. */
function GuestOnly() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullScreenLoader />;
  if (status === 'signedIn') return <Navigate to={location.state?.from ?? '/journal'} replace />;
  return <Outlet />;
}

export default function App() {
  return (
    <Routes>
      <Route element={<GuestOnly />}>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
      </Route>

      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/journal" element={<JournalPage />} />
          <Route path="/journal/new" element={<EntryPage key="new" />} />
          <Route path="/journal/:id" element={<EntryPage />} />
          {/* One route with an optional id, so the page keeps its state when a
              new conversation receives its id mid-answer. */}
          <Route path="/chat/:id?" element={<ChatPage />} />
          <Route path="/memories" element={<MemoriesPage />} />
          <Route path="/insights" element={<InsightsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/journal" replace />} />
    </Routes>
  );
}
