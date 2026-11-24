# 监控数据适配和场景策略

## 输入和标注

- Cchead 提供实拍 RGB 视频帧、人头框和跟踪 ID。校园路样本用于训练与同机位开发验证，独立的正俯视街道序列用于 B 组留出。
- RPEE-Heads 提供站台和活动入口等 RGB 图像与头框。保留发布方划分，用录像及站点划分项目训练和测试。第二轮混入活动入口训练图；站台与其他留出样本用于分场景评测。
- RGBT-CC 提供配对 RGB、热成像和人数点。本项目本地暗光探针读取 RGB 和点数，按图像计数误差评估。头框精确率和召回率只在提供可信头框的样本上统计。该数据许可仍待核，逐图资产留在本地。

## 推理配置

- A、D、E、F 采用模型二全图 640、置信度 0.25。A 的计数区域和更大输入针对四个录像视角做过开发对照，默认参数沿用全图。
- B 采用 2×2 重叠切块，把检测框映射回全图后合并去重。保留置信度 0.15 的全图推理作为低成本对照。
- C 采用 2×2 切块结果，再从全图补足遗漏的大头。按全图缩放至 640 的等效头框短边筛选，候选最短 16 像素，并与切块框排重。开发对照含跨块代表框筛选失败的记录。
- F 的暗光高密度仍严重少计。六组留出结果仅覆盖已有来源与抽样口径。

## 回放与测速

在工作区根目录运行。训练与划分见 [训练过程](TRAINING.md) 和 [数据卡](../datasets/README.md)。`$project` 指数据集项目根目录，`$cchead` 指当初建立冻结划分时的 Cchead 项目根目录。一些入口要求上游实验结果使用固定目录名，路径依赖使得复跑需要本地原始资源和对应协议。汇总表足以查看本轮结果。

~~~powershell
$python = 'D:/models/SkyGuard/envs/yolov8s-head/Scripts/python.exe'
$project = 'D:/datasets/SkyGuard-Datasets'
$cchead = 'D:/datasets/cchead'
$weights = 'D:/models/SkyGuard/yolov8s-head/wesjos/v8s-head.pt'
$ev = Join-Path $project 'gpt-6/evaluations/head-count-v2'
$probe = Join-Path $ev 'scene-probe-v1'
$dedup = Join-Path $ev 'c-tile-dedup-v2'
$fusion = Join-Path $ev 'c-tile-fusion-v1'
$b = Join-Path $ev 'b-replay-speed-v1'
$holdout = Join-Path $ev 'holdout-five-draws-v1'
$school = Join-Path $ev 'schoolpath-video-smoke-v1'
$speed = Join-Path $ev 'six-scene-speed-v1'

& $python -I -B -u evaluation/scene_probe.py $project $weights $probe
& $python -I -B -u evaluation/probe_c_tile_dedup.py $project $probe $dedup
& $python -I -B -u evaluation/probe_c_tile_fusion.py $project $probe $dedup $fusion
& $python -I -B -u evaluation/benchmark_b_paths.py $project $probe $b
& $python -I -B -u evaluation/replay_six_holdouts.py $project $b $weights $holdout
& $python -I -B -u evaluation/run_schoolpath_video.py $project $cchead $school
& $python -I -B -u evaluation/bench_six_scene_speed.py $project $cchead $speed
~~~

五轮每轮 78 张，每组在轮内无放回，跨轮可重复，总计 231 张不同原图。B 的留出来自同一街道后段，RPEE 图像可共享站点或录像。速度测在 RTX 4060 Laptop，包含读取、解码、推理和后处理；带框速度还包含编码。B 有连续源帧测速，C 只测原尺寸抽帧。现场摄像机、板端和江滩回放接入尚待验证。

[五轮抽样结果](results/six_scene_accuracy.csv) · [测速汇总](results/six_scene_speed.csv)
