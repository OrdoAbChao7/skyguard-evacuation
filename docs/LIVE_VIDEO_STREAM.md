# 实时视频流接入（V7.6 软件适配器）

> **状态**：软件链路已实现，并用本机 HTTP 网络流（真实生成的视频）完成测试；
> **真实 RTSP 摄像头尚未验证**。本页只描述已经做到的事，不把 HTTP 测试说成摄像头实测。
>
> 关联：[MVP_LIMITATIONS.md](MVP_LIMITATIONS.md)、[REAL_WORLD_VALIDATION_ROADMAP.md](REAL_WORLD_VALIDATION_ROADMAP.md)、
> [VENUE_CALIBRATION_V72.md](VENUE_CALIBRATION_V72.md)、[research/CLAIMS.md](../research/CLAIMS.md)。

## 1. 能力与边界

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| RTSP/RTMP/HTTP(S) 网络流打开 | 已实现 | OpenCV 的 FFmpeg 后端；本机 OpenCV 构建含 `FFMPEG: YES` |
| 短窗口人群计数 | 已实现 | 默认 30 个分析帧 / 20 秒，按 `sample_every` 采样 |
| 断流重连与明确失败 | 已实现 | 默认重连 2 次；仍失败返回 503，不返回 0 人冒充安全 |
| 观测写回 | 已实现 | `source=live_video`，进入现有可信度/时效/独立校验链路 |
| 标定门控 | 已实现 | 未标定摄像机置信度上限 0.35；估算标定上限 0.65 |
| 浏览器直接播放 RTSP | **不支持** | 需要 HLS/WebRTC 网关或服务端快照；当前前端只显示适配器状态 |
| 真实摄像头精度 | **未验证** | CPU MOG2 是运动前景计数，不是专用人群计数模型 |
| 昇腾 NPU 推理 | **未接入本路径** | 本路径是 CPU OpenCV；昇腾是独立 provider |

## 2. 服务端配置

实时流地址**只保存在服务端**，不通过 HTTP API 接收，也不返回给前端。

推荐使用独立 JSON 文件 `data/streams.json`（`data/*.json` 已被 `.gitignore` 忽略）：

```json
{
  "streams": [
    {
      "id": "gate-02",
      "label": "2 号门",
      "region_id": "R_GATE_02_PLAZA",
      "url": "rtsp://camera.example.local:554/Streaming/Channels/101",
      "roi": [0.08, 0.18, 0.84, 0.66],
      "enabled": true,
      "max_frames": 30,
      "sample_every": 5,
      "max_seconds": 20
    }
  ]
}
```

也可以使用环境变量：

- `SKYGUARD_STREAMS_FILE=data/streams.json`：指向独立文件；相对路径先按仓库根解析，文件不存在时再按 `DATA_ROOT` 解析；
- `SKYGUARD_STREAMS=[{...}]`：内联 JSON（适合容器 Secret 注入）。

**不要**把真实地址、用户名、密码、token 提交到仓库或写进演示材料。
`data/streams.json` 只应存在于部署机，并限制文件权限。
摄像头需要认证时，把 `用户名:密码` 写进本地 URL 的 userinfo 部分；API 与证据只返回脱敏后的地址。

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | API 使用的 `stream_id`，只能包含字母、数字、下划线、连字符 |
| `label` | 否 | 展示名称，默认等于 `id` |
| `region_id` | 是 | 必须存在于当前场景；一路流绑定一个区域，API 不能改绑 |
| `url` | 是 | 仅允许 `rtsp/rtsps/rtmp/rtmps/http/https`；拒绝 `file/gopher/data` 等 |
| `roi` | 否 | 归一化 `[x,y,w,h]` 或 `{x,y,w,h}`，必须在 0~1 内且不越界；缺省用场景摄像机 ROI |
| `enabled` | 否 | 默认 `true`；禁用后 API 返回 409 |
| `max_frames` | 否 | 最多分析帧数，默认 30，最大 600 |
| `sample_every` | 否 | 每 N 帧取一帧，默认 5，最大 60 |
| `max_seconds` | 否 | 墙钟上限，默认 20 秒，最大 120 秒 |

**Fail-closed**：任意一条配置非法（协议、重复 id、ROI 越界、JSON 错误），整份配置作废，
API 返回 `STREAM_CONFIG_INVALID`，不会静默跳过某一路摄像头。

## 3. HTTP API

### 3.1 查看配置元数据

```http
GET /api/v1/safety/streams
```

只返回 `id`、`label`、`region_id`、`region_name`、`enabled`、`roi`、`calibration_version`，
**不返回完整 URL 或凭据**。

### 3.2 查看 provider 状态

```http
GET /api/v1/safety/providers
```

`live_video` provider 的字段含义：

- `available`：本机 Python + OpenCV + FFmpeg 后端可用；
- `verified_on_this_host`：**本进程内**是否成功读取过至少一路网络流；
- `checks`：`python`、`opencv`、`ffmpeg_backend`。

### 3.3 触发一次实时流观测

```http
POST /api/v1/safety/observations/stream
Authorization: Bearer <admin-or-safety_operator-jwt>
Content-Type: application/json

{ "stream_id": "gate-02", "recompute": true }
```

可选覆盖：`max_frames`、`sample_every`、`max_seconds`。

成功返回 `201`：

- `observation.source = "live_video"`；
- `observation.region_id` 来自服务端绑定的 `region_id`；
- `inference.evidence` 含 `stream_id`、`stream_url_redacted`、`frames_analyzed`、`reconnects`、
  `elapsed_ms`、`effective_fps`、`limitations`；
- 默认触发重算；`recompute=false` 时只写入观测。

错误语义：

| 状态 | code | 场景 |
| --- | --- | --- |
| 401/403 | — | 未登录或非 `admin`/`safety_operator` |
| 404 | `UNKNOWN_STREAM` | `stream_id` 不在注册表 |
| 409 | `STREAM_DISABLED` | 该路流被禁用 |
| 503 | `STREAM_NOT_CONFIGURED` | 尚未配置任何流 |
| 503 | `STREAM_CONFIG_INVALID` | 配置解析失败，整份配置已作废 |
| 503 | `PROVIDER_UNAVAILABLE` | 本机缺少 OpenCV/FFmpeg，或流不可读/超时 |

**不会**在失败时写入 0 人观测。这是与“假装安全”的关键区别。

## 4. 安全设计

1. **API 只接收 `stream_id`**：URL 从服务端注册表解析，调用方不能传入任意地址，避免 SSRF。
2. **协议白名单**：只允许网络流协议；`file://` 等本地协议直接拒绝。
3. **凭据脱敏**：用户名、密码、query、fragment 不会进入证据、审计、错误详情或日志；
   OpenCV/FFmpeg 的 stderr 也会经过 URL 脱敏后再返回。
4. **配置 fail-closed**：任何一条配置错误都会让整份配置不可用，而不是“少一路也能跑”。
5. **权限**：写观测需要 JWT + `admin`/`safety_operator`；Agent 不能启动流、审批或派发。
6. **不绕过安全内核**：实时流观测仍走 90 秒时效、最低置信度 0.6、标定门控、独立校验和四态状态机；
   流可用不等于数据可信。
7. **短窗口**：每次请求只读一小段，不是后台持续拉流；不会把“读了一帧”包装成“连续监测”。
8. **进程参数**：流 URL 作为 Python 子进程参数传入，运行瞬间可能出现在本机进程列表。
   生产环境应使用短时令牌/专用服务账号，并限制主机登录与进程查看权限。

## 5. 运行与验收

前置：本机 `python` 可执行，已安装 `opencv-python`/`numpy`，且 OpenCV 构建含 FFmpeg。
可用 `SKYGUARD_PYTHON` 指定 Python 路径。

```bash
npx tsx --test backend/tests/safety/streams.test.ts
npx tsx --test backend/tests/safety/live-video-provider.test.ts
npx tsx --test backend/tests/safety/safety-api-stream.test.ts
npm test --prefix backend
npm run build
```

### 5.1 本机已经验证的内容

- 用 Python 生成一段真实 AVI，通过本机 HTTP 服务暴露为网络流；
- provider 通过 OpenCV/FFmpeg 打开该 URL，真实解码并输出人数 > 0；
- 证据含 `stream_id`、脱敏 URL、帧数、重连次数、耗时；query token 不出现在响应中；
- HTTP API 写入 `live_video` 观测，未标定摄像机置信度被压低；
- 不可达 RTSP 地址返回明确失败，而不是 0 人；
- 未配置/禁用/未知/配置错误分别返回 503/409/404/503；
- 非运维角色 403，匿名 401。

### 5.2 尚未验证的内容

- **真实 RTSP 摄像头**（没有设备/地址）；
- 真实网络抖动、丢包、H.265、夜间/逆光、镜头脏污；
- 端到端延迟（没有源时间戳，`elapsed_ms` 只是处理耗时）；
- 浏览器直接播放（RTSP 不支持）；
- 精度/MAE（没有逐帧真值）；
- 昇腾 NPU 路径（本路径是 CPU）。

### 5.3 真实摄像头验收清单

1. 摄像头固定、焦距锁定、背景稳定；RTSP 地址从部署机可达。
2. 用 `ffplay` 或 OpenCV 先确认能打开；凭据只放本机配置/环境变量。
3. 配置 `region_id`、`roi`、`area_m2`、`calibration_version`；ROI 不包含区域外通道。
4. `GET /api/v1/safety/providers`：`live_video.available=true`；首次成功推理后
   `verified_on_this_host=true`。
5. `POST /api/v1/safety/observations/stream`：201，观测 `source=live_video`；
   未标定时置信度 ≤ 0.35。
6. 拔掉摄像头/改错地址：请求 503，`inference_health` 变为异常，状态进入 `DEGRADED`；
   不得出现“0 人、正常”的假安全。
7. 检查审计与日志：没有完整 URL、用户名、密码、token。
8. 保存证据：时间、摄像头型号、脱敏 URL、帧数、人数、置信度、重连次数、耗时；
   精度评测必须另做带标注片段，不能用本次运行报 MAE。

## 6. 已知限制

- CPU MOG2 统计运动前景连通域；高密度人群粘连时计数偏低，只能视为下界。
- 会把行李箱、车辆、飘动织物等运动物体计入。
- 只读短窗口，不建模事件突变、镜头移动、光照剧变。
- `confidence` 只反映帧间稳定性，不是绝对准确率。
- 浏览器不能直接播放 RTSP；当前前端只显示“适配器可用/已跑通”，不显示视频画面。
- 多机位融合、跨摄像头去重、摄像头心跳/脏污检测尚未接入本路径。
- 昇腾 NPU 推理是独立 provider，本路径未使用 NPU。

## 7. 后续工作

1. HLS/WebRTC 网关或服务端 JPEG 快照，让前端能看到真实画面（仍需标注“非实时/有延迟”）。
2. 摄像头心跳、最后成功帧时间、断流告警，接入 `inference_health`。
3. 现场标定：区域面积、ROI、镜头内外参、人群速度/出口服务率样本。
4. 带标注片段的精度评测；没有真值就不报 MAE。
5. 多机位融合与跨摄像头去重。
6. 若上昇腾：把解码后的帧送入 Ascend provider，单独记录 NPU 延迟/吞吐。
