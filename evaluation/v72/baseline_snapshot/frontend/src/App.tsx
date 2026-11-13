import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

const CommandCenterPage = lazy(() => import('./pages/command-center/CommandCenterPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const StaffPage = lazy(() => import('./pages/StaffPage'));

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div className="app-loading">正在加载 SkyGuard…</div>}>
        <Routes>
          <Route path="/" element={<CommandCenterPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/staff" element={<StaffPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
