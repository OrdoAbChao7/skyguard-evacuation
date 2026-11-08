import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { BgColorsOutlined } from '@ant-design/icons';
import './ThemeSettings.css';

type Theme = { background: string; accent: string };
const KEY = 'skyguard.ui-theme.v3';
const DEFAULT: Theme = { background: '#f3f5f7', accent: '#1f6feb' };
const PRESETS = [
  { name: '指挥白', background: '#f3f5f7', accent: '#1f6feb' },
  { name: '深空', background: '#070b13', accent: '#34e0c8' },
  { name: '极夜', background: '#080d1a', accent: '#6d8dff' },
  { name: '苔原', background: '#0a1512', accent: '#6fe0a8' },
];
const valid = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
function luminance(hex: string) {
  const values = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
}
function mix(a: string, b: string, weight: number) {
  return '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - weight) + parseInt(b.slice(i, i + 2), 16) * weight).toString(16).padStart(2, '0')).join('');
}
function load(): Theme {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (valid(saved?.background) && valid(saved?.accent)) return saved;
  } catch { /* Invalid or unavailable storage uses the default theme. */ }
  return DEFAULT;
}
export function useWorkspaceTheme() {
  const [theme, setTheme] = useState<Theme>(load);
  const [storageError, setStorageError] = useState(false);
  function update(next: Theme) {
    setTheme(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); setStorageError(false); }
    catch { setStorageError(true); }
  }
  const dark = luminance(theme.background) < .179;
  const foreground = dark ? '#e9eff8' : '#101828';
  // Panel surfaces sit above the background; borders stay low-contrast but visible.
  const surface = dark ? mix(theme.background, '#7f9cc4', .055) : mix(theme.background, '#ffffff', .72);
  const raised = dark ? mix(theme.background, '#9bb8df', .095) : '#ffffff';
  const accentText = luminance(theme.accent) > .36 ? '#04110f' : '#ffffff';
  const style = {
    '--bg': theme.background, '--panel': surface, '--panel-2': raised,
    '--text': foreground, '--muted': mix(theme.background, foreground, .62),
    '--faint': mix(theme.background, foreground, dark ? .46 : .56),
    '--border': mix(theme.background, foreground, .16),
    '--border-strong': mix(theme.background, foreground, .26),
    '--hover': mix(theme.background, foreground, .09),
    '--accent': theme.accent, '--accent-text': accentText,
    '--info': dark ? '#7aa2ff' : '#2456c7',
    '--ok': dark ? '#43e0a0' : '#14714a',
    '--bad': dark ? '#ff6b81' : '#b21e34',
    '--warn': dark ? '#f2c15c' : '#7a5600',
    '--degraded': dark ? '#ff9b57' : '#8a4400',
    colorScheme: dark ? 'dark' : 'light',
  } as CSSProperties;
  return { theme, update, style, storageError, mode: dark ? 'dark' : 'light' as const };
}
export default function ThemeSettings({ theme, update, storageError }: ReturnType<typeof useWorkspaceTheme>) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOnOutside = (event: PointerEvent) => {
      const element = detailsRef.current;
      if (element?.open && !element.contains(event.target as Node)) element.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && detailsRef.current?.open) {
        detailsRef.current.open = false;
        detailsRef.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  return <details className="theme-settings" ref={detailsRef}>
    <summary><BgColorsOutlined aria-hidden="true" /><span>界面配色</span></summary>
    <div className="theme-settings-body">
      <strong>工作台配色</strong>
      <p>即时预览，自动保存在当前浏览器。安全状态语义色不随主题改变。</p>
      <div className="theme-presets">{PRESETS.map(preset => <button key={preset.name} type="button"
        aria-pressed={theme.background === preset.background && theme.accent === preset.accent}
        onClick={() => update({ background: preset.background, accent: preset.accent })}>
        <i style={{ background: preset.background, borderColor: preset.accent }} aria-hidden="true" />
        <span>{preset.name}</span>
      </button>)}</div>
      <label>背景色 <span>{theme.background}</span><input aria-label="自定义背景色" type="color" value={theme.background} onChange={e => update({ ...theme, background: e.target.value })} /></label>
      <label>强调色 <span>{theme.accent}</span><input aria-label="自定义强调色" type="color" value={theme.accent} onChange={e => update({ ...theme, accent: e.target.value })} /></label>
      <p>文字与面板自动适配对比度。地图和安全状态保留独立语义配色。</p>
      {storageError && <p role="status" className="theme-settings-error">浏览器无法保存设置，本次预览仍有效。</p>}
      <button type="button" className="theme-reset" onClick={() => update(DEFAULT)}>恢复默认配色</button>
    </div>
  </details>;
}
