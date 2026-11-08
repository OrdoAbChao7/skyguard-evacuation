/**
 * 感知回放面板（CityStreet C3 单机位派生数据）。
 *
 * 设计约束：
 *  - 只渲染后端 `/api/v1/perception/*` 返回的内容，组件内不做任何人数/风险推断；
 *  - 永久标注 `DEMO 回放 · 非实时 · 无真值`，不得出现"已验证""实时"等表述；
 *  - 底图缺失（许可未确认、未随仓库分发）时退回无底图坐标系，而不是伪造底图。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import perceptionApi from '../../services/perceptionApi';
import type { PerceptionDisplayDetail, PerceptionFrame } from '../../services/perceptionApi';
import './PerceptionReplayPanel.css';

interface Props {
  /** 要回放的展示包 ID；默认使用仓库内的 CityStreet 示例包。 */
  packageId?: string;
}

const PLAYBACK_INTERVAL_MS = 250;

function centroid(points: Array<[number, number]>): [number, number] {
  const total = points.reduce<[number, number]>((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]);
  return [total[0] / points.length, total[1] / points.length];
}

function polygonPoints(points: Array<[number, number]>): string {
  return points.map(point => `${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' ');
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

export default function PerceptionReplayPanel({ packageId = 'citystreet-display' }: Props) {
  const [display, setDisplay] = useState<PerceptionDisplayDetail | null>(null);
  const [frames, setFrames] = useState<PerceptionFrame[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPlaying(false);
    setIndex(0);
    (async () => {
      try {
        const detail = await perceptionApi.display(packageId);
        const page = await perceptionApi.frames(packageId, { limit: 240 });
        if (cancelled) return;
        setDisplay(detail);
        setFrames(page.frames);
        setSelectedZone(detail.zones[0]?.zone_id ?? null);
      } catch (cause) {
        if (cancelled) return;
        const detail = (cause as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message;
        setError(detail ?? (cause as Error).message ?? '感知回放数据加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [packageId]);

  useEffect(() => {
    if (!playing || frames.length < 2) return undefined;
    const timer = setInterval(() => {
      setIndex(current => (current + 1 >= frames.length ? current : current + 1));
    }, PLAYBACK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, frames.length]);

  useEffect(() => {
    if (playing && frames.length > 0 && index >= frames.length - 1) setPlaying(false);
  }, [playing, index, frames.length]);

  const frame = frames[index] ?? null;
  const zones = display?.zones ?? [];
  const zoneStatsById = useMemo(() => {
    const map = new Map<string, PerceptionFrame['zone_stats'][number]>();
    for (const stat of frame?.zone_stats ?? []) map.set(stat.zone_id, stat);
    return map;
  }, [frame]);

  const togglePlayback = useCallback(() => {
    if (frames.length < 2) return;
    if (!playing && index >= frames.length - 1) setIndex(0);
    setPlaying(current => !current);
  }, [frames.length, index, playing]);

  if (loading) {
    return (
      <section className="cc-panel perception-panel" aria-label="感知回放">
        <div className="perception-head">
          <h4>感知回放 · 单机位派生数据</h4>
          <span className="perception-badge perception-badge-demo">DEMO 回放</span>
        </div>
        <p className="cc-muted">正在读取回放展示包…</p>
      </section>
    );
  }

  if (error || !display || frames.length === 0) {
    return (
      <section className="cc-panel perception-panel" aria-label="感知回放">
        <div className="perception-head">
          <h4>感知回放 · 单机位派生数据</h4>
          <span className="perception-badge perception-badge-demo">DEMO 回放</span>
        </div>
        <p className="cc-bad">不可用：{error ?? '展示包为空'}</p>
        <p className="cc-muted cc-small">
          回放数据缺失时不显示任何点位，也不会回退到合成或推测数据。
        </p>
      </section>
    );
  }

  const width = display.map.width_px;
  const height = display.map.height_px;
  const selectedStat = selectedZone ? zoneStatsById.get(selectedZone) : undefined;
  const selectedGeometry = zones.find(zone => zone.zone_id === selectedZone);
  const visiblePeople = frame?.people.filter(person => person.map_xy_px) ?? [];
  const totalEstimated = frame?.zone_stats.reduce((sum, stat) => sum + stat.estimated_people, 0) ?? 0;

  return (
    <section className="cc-panel perception-panel" aria-label="感知回放">
      <div className="perception-head">
        <h4>
          感知回放 · {display.scene_id} / {display.camera_id}
          <span className="cc-muted"> {display.display_name}</span>
        </h4>
        <div className="perception-badges">
          <span className="perception-badge perception-badge-demo">DEMO 回放 · 非实时</span>
          <span className={`perception-badge ${display.ground_truth_available ? 'perception-badge-ok' : 'perception-badge-warn'}`}>
            {display.ground_truth_available ? '含真值' : '无真值标注'}
          </span>
          <span className={`perception-badge ${display.license_status === 'UNVERIFIED' ? 'perception-badge-warn' : 'perception-badge-muted'}`}>
            许可 {display.license_status}
          </span>
        </div>
      </div>

      <div className="perception-body">
        <div className="perception-canvas">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`${display.scene_id} 第 ${frame?.frame_id ?? 0} 帧人流点位回放`}
            className="perception-svg"
          >
            <defs>
              <radialGradient id="perception-heat">
                <stop offset="0%" stopColor="#ff4d3d" stopOpacity="0.55" />
                <stop offset="60%" stopColor="#ff9a1f" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#ff9a1f" stopOpacity="0" />
              </radialGradient>
            </defs>

            {display.basemap.available ? (
              <image
                href={display.basemap.url}
                x="0"
                y="0"
                width={width}
                height={height}
                opacity="0.55"
                preserveAspectRatio="none"
              />
            ) : (
              <g>
                <rect x="0" y="0" width={width} height={height} className="perception-nobase" />
                {[0.25, 0.5, 0.75].map(ratio => (
                  <g key={ratio}>
                    <line x1={width * ratio} y1="0" x2={width * ratio} y2={height} className="perception-nobase-grid" />
                    <line x1="0" y1={height * ratio} x2={width} y2={height * ratio} className="perception-nobase-grid" />
                  </g>
                ))}
                <text x={width / 2} y={height / 2 - 6} textAnchor="middle" className="perception-nobase-label">
                  航拍底图未随仓库分发（许可未确认）
                </text>
                <text x={width / 2} y={height / 2 + 16} textAnchor="middle" className="perception-nobase-hint">
                  坐标为原始底图 768 × 768 像素系，区域边界与人流点位仍然有效
                </text>
              </g>
            )}

            {zones.map(zone => (
              <polygon
                key={zone.zone_id}
                points={polygonPoints(zone.map_polygon_px)}
                className={`perception-zone ${zone.zone_id === selectedZone ? 'selected' : ''}`}
                onClick={() => setSelectedZone(zone.zone_id)}
              >
                <title>{`区域 ${zone.zone_id} · 估计 ${zoneStatsById.get(zone.zone_id)?.estimated_people ?? 0} 人`}</title>
              </polygon>
            ))}

            {visiblePeople.map(person => {
              const [x, y] = person.map_xy_px as [number, number];
              const radius = 18 + 10 * (person.confidence ?? 0.6);
              return (
                <circle key={String(person.track_id)} cx={x} cy={y} r={radius} fill="url(#perception-heat)">
                  <title>
                    {`track ${person.track_id} · 置信 ${person.confidence?.toFixed(2) ?? '—'} · ${
                      person.zone_id ?? '区域未知'
                    }${person.speed_mps ? ` · ${person.speed_mps.toFixed(2)} m/s` : ''}`}
                  </title>
                </circle>
              );
            })}

            {zones.map(zone => {
              const [cx, cy] = centroid(zone.map_polygon_px);
              const count = zoneStatsById.get(zone.zone_id)?.estimated_people;
              return (
                <text key={`${zone.zone_id}-label`} x={cx} y={cy} textAnchor="middle" className="perception-zone-label">
                  {zone.zone_id}
                  {count === undefined ? '' : ` · ${count}`}
                </text>
              );
            })}
          </svg>
        </div>

        <aside className="perception-side">
          <div className="perception-frameinfo">
            <div>
              <span>帧号</span>
              <strong>{frame?.frame_id ?? '—'}</strong>
            </div>
            <div>
              <span>片段内时间</span>
              <strong>{frame ? formatSeconds(frame.timestamp_ms) : '—'}</strong>
            </div>
            <div>
              <span>点位</span>
              <strong>{frame?.people.length ?? 0}</strong>
            </div>
            <div>
              <span>区域估计合计</span>
              <strong>{totalEstimated}</strong>
            </div>
          </div>

          <p className="cc-muted cc-small">
            区域人数为逐帧估计值，非过线流量，也不是预测。帧状态：{frame?.frame_status ?? '—'}。
          </p>

          <div className="perception-framectl">
            <button type="button" onClick={togglePlayback} aria-label={playing ? '暂停回放' : '播放回放'}>
              {playing ? '暂停' : '播放'}
            </button>
            <input
              type="range"
              aria-label="回放帧位置"
              min={0}
              max={Math.max(0, frames.length - 1)}
              value={index}
              onChange={event => {
                setPlaying(false);
                setIndex(Number(event.target.value));
              }}
            />
            <span className="cc-muted cc-small">
              {index + 1}/{frames.length}
            </span>
          </div>

          {selectedGeometry && selectedStat ? (
            <div className="perception-zonecard">
              <h5>
                区域 {selectedZone}
                <span className="cc-muted"> · 估计 {selectedStat.estimated_people} 人</span>
              </h5>
              <ul>
                <li>
                  中位速度：{selectedStat.median_speed_mps == null ? '无样本' : `${selectedStat.median_speed_mps.toFixed(3)} m/s`}
                  （样本 {selectedStat.speed_sample_count}）
                </li>
                <li>
                  朝向路口 {selectedStat.direction_counts.toward_junction} · 离开路口{' '}
                  {selectedStat.direction_counts.away_from_junction} · 未知 {selectedStat.direction_counts.unknown}
                </li>
                <li>
                  地面范围：{selectedGeometry.ground_polygon_m.length} 点边界 ·{' '}
                  {selectedGeometry.ground_polygon_m.length >= 3 ? '已按米制投影' : '未标定'}
                </li>
              </ul>
            </div>
          ) : (
            <p className="cc-muted cc-small">点击画布中的区域边界或下方列表查看该区统计。</p>
          )}

          <table className="cc-table perception-zonetable">
            <caption className="cc-muted cc-small">区域估计人数（当前帧）</caption>
            <thead>
              <tr>
                <th>区域</th>
                <th>人数</th>
                <th>中位速度</th>
              </tr>
            </thead>
            <tbody>
              {[...(frame?.zone_stats ?? [])]
                .sort((a, b) => b.estimated_people - a.estimated_people)
                .map(stat => (
                  <tr
                    key={stat.zone_id}
                    className={stat.zone_id === selectedZone ? 'selected' : ''}
                    onClick={() => setSelectedZone(stat.zone_id)}
                  >
                    <td>{stat.zone_id}</td>
                    <td>{stat.estimated_people}</td>
                    <td>{stat.median_speed_mps == null ? '—' : stat.median_speed_mps.toFixed(2)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </aside>
      </div>

      <footer className="perception-foot">
        <p>
          {display.notice} 时间基 <code>{display.time_base}</code>，标定 <code>{display.calibration_id}</code>。
        </p>
        <details>
          <summary>数据来源与已知误差 · {display.limitations.length} 条</summary>
          <ul>
            {display.limitations.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="cc-muted cc-small">
            该面板不参与疏散规划与独立校验：区域 ID、容量与通道配置一律以
            <code> data/scenarios/*.json </code>为准。
          </p>
        </details>
      </footer>
    </section>
  );
}
