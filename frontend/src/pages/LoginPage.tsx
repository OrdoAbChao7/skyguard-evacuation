/**
 * 运维登录页。
 *
 * 大屏读取免登录；写操作（事件登记、方案重算、演示运行）需要 JWT，
 * 因此仅需在需要操作时登录。账号由后端 `SKYGUARD_ADMIN_USERNAME/PASSWORD` 初始化。
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import './LoginPage.css';

export default function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    setHasToken(Boolean(localStorage.getItem('admin_token')));
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await axios.post('/api/v1/auth/login', { username, password });
      localStorage.setItem('admin_token', response.data.access_token);
      localStorage.setItem('admin_username', response.data.username ?? username);
      navigate('/', { replace: true });
    } catch (caught) {
      const message = (caught as { response?: { data?: { error?: string } } }).response?.data?.error;
      setError(message ?? '登录失败，请确认后端已启动');
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_username');
    setHasToken(false);
  }

  return (
    <main className="login-root">
      <section className="login-card" aria-labelledby="login-title">
        <p className="login-eyebrow">SkyGuard · 操作员入口</p>
        <h1 id="login-title">安全决策操作登录</h1>
        <p className="login-note">
          读取态势无需登录；登记事件、重新规划与运行演示需要运维角色。
        </p>

        {hasToken ? (
          <div className="login-session">
            <p>当前浏览器已有操作令牌。</p>
            <div className="login-actions">
              <button type="button" className="login-primary" onClick={() => navigate('/')}>
                进入指挥大屏
              </button>
              <button type="button" onClick={logout}>清除令牌</button>
            </div>
          </div>
        ) : (
          <form className="login-form" onSubmit={onSubmit}>
            <label htmlFor="username">用户名</label>
            <input
              id="username"
              name="username"
              autoComplete="username"
              value={username}
              onChange={event => setUsername(event.target.value)}
              required
            />
            <label htmlFor="password">密码</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              required
            />
            {error ? <p className="login-error" role="alert">{error}</p> : null}
            <div className="login-actions">
              <button type="submit" className="login-primary" disabled={busy}>
                {busy ? '登录中…' : '登录'}
              </button>
              <button type="button" onClick={() => navigate('/')}>返回大屏</button>
            </div>
          </form>
        )}

        <p className="login-foot">
          研究原型，不得用于真实应急指挥。账号初始化见 <code>README.md</code>。
        </p>
      </section>
    </main>
  );
}
