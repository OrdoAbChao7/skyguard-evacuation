import { useEffect, useMemo, useRef } from 'react';
import type {
  EvacuationPlan,
  EvacuationRoute,
  SafetyRegion,
  SafetyStatus,
  ScenarioMap,
} from '../../../services/safetyApi';
import { MAP_DRAG_CLICK_THRESHOLD_PX, MAP_WHEEL_FACTOR, MAP_MAX_ZOOM, MAP_MIN_ZOOM, centreOf, formatSince } from '../commandCenterUtils';


/** 地图上使用短标签：完整区域名在点选详情里展示。 */
function mapRegionLabel(region: SafetyRegion): string {
  const gate = region.id.match(/^R_GATE_(\d+)_PLAZA$/);
  if (gate) return `G${gate[1]} 门区`;
  const section = region.id.match(/^R_S(\d+)_L(\d+)_(CREST|ECO|RIVER)$/);
  if (section) {
    const row = section[3] === 'CREST' ? '滩顶' : section[3] === 'ECO' ? '生态' : '亲水';
    return `S${section[1]} ${row}`;
  }
  return region.name.length > 7 ? `${region.name.slice(0, 6)}…` : region.name;
}

/** 出口标签只保留闸口编号，完整名称在悬浮提示里。 */
function mapExitLabel(id: string): string {
  const gate = id.match(/GATE_\d+_(G\d+)/);
  return gate ? gate[1] : id;
}

interface RouteGroup {
  key: string;
  fromRegionId: string;
  exitId: string;
  persons: number;
  points: Array<{ x: number; y: number }>;
  earliestMinute: number;
  latestMinute: number;
}

function groupRoutes(
  plan: EvacuationPlan | null,
  regions: SafetyRegion[],
  exits: SafetyStatus['exits'],
): RouteGroup[] {
  if (!plan) return [];
  const regionById = new Map(regions.map(region => [region.id, region]));
  const exitById = new Map(exits.map(exit => [exit.id, exit]));
  const groups = new Map<string, RouteGroup>();

  for (const route of plan.routes as EvacuationRoute[]) {
    const key = `${route.from_region_id}->${route.exit_id}`;
    const existing = groups.get(key);
    const points = buildRoutePoints(route, regionById, exitById);
    if (existing) {
      existing.persons += route.persons;
      existing.earliestMinute = Math.min(existing.earliestMinute, route.depart_minute);
      existing.latestMinute = Math.max(existing.latestMinute, route.arrive_minute);
      continue;
    }
    groups.set(key, {
      key,
      fromRegionId: route.from_region_id,
      exitId: route.exit_id,
      persons: route.persons,
      points,
      earliestMinute: route.depart_minute,
      latestMinute: route.arrive_minute,
    });
  }
  return [...groups.values()];
}

function buildRoutePoints(
  route: EvacuationRoute,
  regionById: Map<string, SafetyRegion>,
  exitById: Map<string, SafetyStatus['exits'][number]>,
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const origin = regionById.get(route.from_region_id);
  if (origin) points.push(centreOf(origin));
  for (const step of route.steps) {
    const region = regionById.get(step.to_region_id);
    if (region) points.push(centreOf(region));
  }
  const exit = exitById.get(route.exit_id);
  if (exit) {
    const region = regionById.get(exit.region_id);
    if (region) {
      points.push({
        x: region.geometry.x + region.geometry.width,
        y: region.geometry.y + region.geometry.height / 2,
      });
    }
  }
  return points;
}

function NetworkMap({ map, status, selectedRegion, onSelectRegion, allowRoutes, zoom, setZoom, center, setCenter, showBackdrop, layers }: { map?: ScenarioMap; allowRoutes: boolean; status: SafetyStatus; selectedRegion: string | null; onSelectRegion: (id: string) => void; zoom: number; setZoom: (value: number) => void; center: {x:number; y:number} | null; setCenter: (value: {x:number; y:number}) => void; showBackdrop: boolean; layers: {landmarks:boolean; regions:boolean; risks:boolean; corridors:boolean; validated:boolean; candidate:boolean; incidents:boolean} }) {
  const dragging = useRef<{x:number; y:number; centerX:number; centerY:number; scaleX:number; scaleY:number; pointerId:number; moved:boolean; captured:boolean} | null>(null);
  const mapRef = useRef<SVGSVGElement | null>(null);
  const suppressClick = useRef(false);
  const plan = status.plan;
  const candidate = status.candidate_plan;
  const showValidated = allowRoutes && Boolean(plan) && status.state.state !== 'REJECT' && status.state.validated_route_display_allowed;
  const showCandidate = allowRoutes && !showValidated && Boolean(candidate) && status.state.candidate_route_display_allowed;
  const activePlan = showValidated ? plan : showCandidate ? candidate : null;

  const bounds = useMemo(() => {
    let maxX = 0;
    let maxY = 0;
    for (const region of status.regions) {
      maxX = Math.max(maxX, region.geometry.x + region.geometry.width);
      maxY = Math.max(maxY, region.geometry.y + region.geometry.height);
    }
    return { width: maxX + 40, height: maxY + 40 };
  }, [status.regions]);

  const routes = useMemo(
    () => groupRoutes(activePlan, status.regions, status.exits),
    [activePlan, status.regions, status.exits],
  );

  const regionById = new Map(status.regions.map(region => [region.id, region]));

  // 把路线经过的通道高亮出来
  const highlighted = new Set<string>();
  for (const route of activePlan?.routes ?? []) {
    for (const step of route.steps) highlighted.add(step.corridor_id);
  }

  const clampCenter = (point: { x: number; y: number }, level: number) => {
    const halfWidth = bounds.width / (2 * level);
    const halfHeight = bounds.height / (2 * level);
    return {
      x: Math.min(Math.max(point.x, halfWidth), bounds.width - halfWidth),
      y: Math.min(Math.max(point.y, halfHeight), bounds.height - halfHeight),
    };
  };

  // React 的 onWheel 以 passive 方式挂载，无法阻止页面滚动，因此改用原生非 passive 监听。
  const viewRef = useRef({ bounds, center, zoom });
  viewRef.current = { bounds, center, zoom };
  useEffect(() => {
    const element = mapRef.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      const { bounds: currentBounds, center: currentCenter, zoom: currentZoom } = viewRef.current;
      const factor = event.deltaY < 0 ? MAP_WHEEL_FACTOR : 1 / MAP_WHEEL_FACTOR;
      const next = Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, currentZoom * factor));
      // 到达缩放边界时不再拦截滚动，避免地图区域变成“滚动黑洞”。
      if (next === currentZoom) return;
      event.preventDefault();
      const matrix = element.getScreenCTM();
      if (!matrix) return;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      const origin = currentCenter ?? { x: currentBounds.width / 2, y: currentBounds.height / 2 };
      const halfWidth = currentBounds.width / (2 * next);
      const halfHeight = currentBounds.height / (2 * next);
      setCenter({
        x: Math.min(Math.max(point.x + (origin.x - point.x) * currentZoom / next, halfWidth), currentBounds.width - halfWidth),
        y: Math.min(Math.max(point.y + (origin.y - point.y) * currentZoom / next, halfHeight), currentBounds.height - halfHeight),
      });
      setZoom(next);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [setCenter, setZoom]);

  return (
    <svg
      ref={mapRef}
      className="cc-map"
      style={{ touchAction: zoom > MAP_MIN_ZOOM ? 'none' : 'pan-y' }}
      viewBox={`${(center?.x ?? bounds.width / 2) - bounds.width / zoom / 2} ${(center?.y ?? bounds.height / 2) - bounds.height / zoom / 2} ${bounds.width / zoom} ${bounds.height / zoom}`}
      onPointerDown={event => {
        if (event.button !== 0) return;
        const matrix = event.currentTarget.getScreenCTM();
        if (!matrix) return;
        suppressClick.current = false;
        dragging.current = {
          x: event.clientX,
          y: event.clientY,
          centerX: center?.x ?? bounds.width / 2,
          centerY: center?.y ?? bounds.height / 2,
          scaleX: matrix.a,
          scaleY: matrix.d,
          pointerId: event.pointerId,
          moved: false,
          captured: false,
        };
      }}
      onPointerMove={event => {
        const drag = dragging.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (event.pointerType === 'mouse' && event.buttons === 0) {
          dragging.current = null;
          return;
        }
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.moved && (Math.abs(dx) > MAP_DRAG_CLICK_THRESHOLD_PX || Math.abs(dy) > MAP_DRAG_CLICK_THRESHOLD_PX)) {
          drag.moved = true;
          // 仅在真正开始拖动后捕获指针，避免把普通点击重定向到 SVG 而丢失区域选择。
          if (typeof event.currentTarget.setPointerCapture === 'function') {
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.captured = true;
            } catch {
              drag.captured = false;
            }
          }
        }
        setCenter(clampCenter({ x: drag.centerX - dx / drag.scaleX, y: drag.centerY - dy / drag.scaleY }, zoom));
      }}
      onPointerUp={event => {
        const drag = dragging.current;
        if (!drag) return;
        if (drag.captured) {
          try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* capture already released */ }
        }
        if (drag.moved) {
          // 拖动结束后浏览器仍会派发 click，短暂抑制以免误选区域。
          suppressClick.current = true;
          window.setTimeout(() => { suppressClick.current = false; }, 250);
        }
        dragging.current = null;
      }}
      onPointerCancel={event => {
        const drag = dragging.current;
        if (drag?.captured) {
          try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* capture already released */ }
        }
        dragging.current = null;
      }}
      onLostPointerCapture={() => { dragging.current = null; }}
      role="group"
      aria-label="区域态势与疏散路线示意图"
      aria-describedby="map-help"
    >
      <desc id="map-help">拖拽平移地图，滚轮缩放；使用 Tab 聚焦区域，按回车查看详情。</desc>
      <defs>
        <marker id="route-arrow-valid" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#43e0a0" /></marker>
        <marker id="route-arrow-candidate" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#ff9b57" /></marker>
        <pattern id="map-grid" width="44" height="44" patternUnits="userSpaceOnUse"><path d="M 44 0 L 0 0 0 44" className="map-grid-line" /></pattern>
      </defs>
      <rect x={0} y={0} width={bounds.width} height={bounds.height} className="map-bg" />
      <rect x={0} y={0} width={bounds.width} height={bounds.height} className="map-grid-bg" fill="url(#map-grid)" aria-hidden="true" />
      <g className="map-corner" aria-hidden="true"><path d={`M 8 30 V 8 H 30`} /><path d={`M ${bounds.width - 30} 8 H ${bounds.width - 8} V 30`} /><path d={`M 8 ${bounds.height - 30} V ${bounds.height - 8} H 30`} /><path d={`M ${bounds.width - 30} ${bounds.height - 8} H ${bounds.width - 8} V ${bounds.height - 30}`} /></g>
      {showBackdrop && map?.backdrop ? <><image href={map.backdrop} x={0} y={0} width={bounds.width} height={bounds.height} preserveAspectRatio="xMidYMid slice" /><rect x={0} y={0} width={bounds.width} height={bounds.height} fill="#091310" opacity={map.backdrop_opacity ?? 0.48} /></> : null}

      {layers.landmarks && (map?.landmarks?.length ?? 0) > 0 ? <g className="map-landmarks" aria-label="场景地标，未空间标定">{(map?.landmarks ?? []).map(landmark => <g key={landmark.name}><circle cx={landmark.x * bounds.width} cy={landmark.y * bounds.height} r="3" /><text x={landmark.x * bounds.width + 7} y={landmark.y * bounds.height - 5}>{landmark.name}</text></g>)}</g> : null}
      {layers.corridors && status.corridors.map(corridor => {
        const from = regionById.get(corridor.from_region_id);
        const to = regionById.get(corridor.to_region_id);
        if (!from || !to) return null;
        const start = centreOf(from);
        const end = centreOf(to);
        const className =
          corridor.effective_status === 'closed' || !corridor.usable
            ? 'map-corridor map-corridor-closed'
            : corridor.effective_status === 'unknown'
              ? 'map-corridor map-corridor-unknown'
              : highlighted.has(corridor.id)
                ? 'map-corridor map-corridor-active'
                : 'map-corridor';
        return (
          <g key={corridor.id}>
            <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} className={`${className} ${selectedRegion && (corridor.from_region_id === selectedRegion || corridor.to_region_id === selectedRegion) ? 'map-related' : ''}`} />
            <title>
              {corridor.name} · 状态 {corridor.effective_status} · 容量 {corridor.capacity_per_min ?? '未知'} 人/分 ·{' '}
              {corridor.status_reason}
            </title>
            {selectedRegion && (corridor.from_region_id === selectedRegion || corridor.to_region_id === selectedRegion) ? <text x={(start.x + end.x) / 2} y={(start.y + end.y) / 2 - 4} className="map-label">{corridor.id}</text> : null}
          </g>
        );
      })}

      {layers.regions && status.regions.map(region => {
        const risk = status.risks.find(item => item.regionId === region.id);
        const geometry = region.geometry;
        return (
          <g key={region.id} role="button" tabIndex={0} aria-label={`查看${region.name}详情`} onClick={() => { if (suppressClick.current) return; onSelectRegion(region.id); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectRegion(region.id); } }} className={selectedRegion === region.id ? 'map-selected' : selectedRegion ? 'map-dimmed' : ''}>
            <rect
              x={geometry.x}
              y={geometry.y}
              width={geometry.width}
              height={geometry.height}
              rx={10}
              className={`map-region risk-${layers.risks ? risk?.level ?? 'unknown' : 'unknown'}`}
            />
            <circle cx={centreOf(region).x} cy={centreOf(region).y} r={5} className={`map-node risk-${risk?.level ?? 'unknown'}`} />
            <text x={geometry.x + geometry.width / 2} y={geometry.y + geometry.height / 2 + 9} textAnchor="middle" className="map-region-name">
              {mapRegionLabel(region)}
            </text>
            <title>
              {region.name} · {risk?.count ?? '无数据'} 人 · 密度 {risk?.density?.toFixed(2) ?? '无数据'} · 置信度 {risk?.confidence ?? '无数据'} · 时间 {formatSince(risk?.observedAt)} · 面积 {region.area_m2} m² ({region.area_provenance}) · 摄像机标定{' '}
              {region.camera.calibration_status}
            </title>
          </g>
        );
      })}

      {layers.corridors && status.exits.map((exit, index) => {
        const region = regionById.get(exit.region_id);
        if (!region) return null;
        const stacked = status.exits.slice(0, index).filter(item => item.region_id === exit.region_id).length;
        const y = region.geometry.y + region.geometry.height / 2 + stacked * 30;
        const x = region.geometry.x + region.geometry.width;
        const label = mapExitLabel(exit.id);
        const labelWidth = Math.max(44, label.length * 9 + 16);
        return (
          <g key={exit.id}>
            <rect
              x={x - 4}
              y={y - 14}
              width={labelWidth}
              height={28}
              rx={7}
              className={`map-exit ${exit.effective_status === 'open' && exit.usable ? 'map-exit-open' : 'map-exit-closed'}`}
            />
            <text x={x - 4 + labelWidth / 2} y={y + 5} textAnchor="middle" className="map-exit-label">
              {label}
            </text>
            <title>
              出口 {exit.name} · {exit.effective_status} · 容量 {exit.capacity_per_min ?? '未知'} 人/分
            </title>
          </g>
        );
      })}

      {layers.incidents && status.incidents.filter(incident => incident.status === 'confirmed' || incident.status === 'reported').map(incident => { const id = incident.affected.region_ids[0] ?? status.corridors.find(c => incident.affected.corridor_ids.includes(c.id))?.from_region_id ?? status.exits.find(e => incident.affected.exit_ids.includes(e.id))?.region_id; const region = status.regions.find(item => item.id === id); if (!region) return null; const point = centreOf(region); return <g key={incident.id}><circle cx={point.x+12} cy={point.y-12} r="6" className="map-incident" /><title>{incident.type} · {incident.description}</title></g>; })}
      {((showValidated && layers.validated) || (showCandidate && layers.candidate)) && routes.map(route => (
        <g key={route.key}>
          <polyline
            points={route.points.map(point => `${point.x},${point.y}`).join(' ')}
            className={showValidated ? 'map-route map-route-validated' : 'map-route map-route-candidate'}
            fill="none" markerEnd={showValidated ? 'url(#route-arrow-valid)' : 'url(#route-arrow-candidate)'}
          />
          <title>
            {route.fromRegionId} → {route.exitId} · {route.persons} 人 · t{route.earliestMinute}–{route.latestMinute} 分钟 ·{' '}
            {showValidated ? '已通过独立校验' : '候选方案，未通过校验'}
          </title>
        </g>
      ))}

      {routes.length > 0 && ((showValidated && layers.validated) || (showCandidate && layers.candidate))
        ? routes.map(route => {
            const last = route.points[route.points.length - 1];
            return (
              <text key={`${route.key}-label`} x={last.x - 46} y={last.y - 8} className="map-route-label">
                {route.persons}人
              </text>
            );
          })
        : null}
    </svg>
  );
}

export default NetworkMap;
