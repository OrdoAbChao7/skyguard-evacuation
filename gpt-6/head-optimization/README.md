# SkyGuard 固定摄像头人头检测优化

本工作区记录单类 YOLOv8s-Head 的两轮微调，以及白天、夜间各三个密度档的计数评测。基于上游 `skyguard-evacuation` 的 `780b8ec`，维护于 `vision/cchead-head-optimization` 分支。

- [数据卡、样例与许可](datasets/README.md)
- [模型二和原始权重](models/MODEL_CARD.md)
- [工作清单和局限](WORKLOG.md)
- [两轮微调与复跑入口](docs/TRAINING.md)
- [三套监控数据适配与回放](docs/DATASET_ADAPTATION.md)
- [精度汇总](docs/results/six_scene_accuracy.csv) · [速度汇总](docs/results/six_scene_speed.csv)

五轮留出抽样中，A～E 的平均人数 MAE 从模型二全图的 17.15 降至按场景推理的 9.08 人/张。F 暗光高人数本地计数仍为 169.46 人/张。附带样例用于查看开发数据格式。正式评测所需原始数据、冻结协议和本地权重见对应文档。

## RPEE-Heads 数据准备

本目录的 G1 脚本读取官方 RPEE-Heads ZIP。数据根目录在 Git 仓库外，包含 `archives/`、`raw/RPEE-Heads/` 和 `audit/`。逐图审计依赖 Python 3.12 和 Pillow。

~~~powershell
python -u data_prep/rpee_fetch.py --data-root D:/datasets/SkyGuard-Datasets
python -u data_prep/rpee_audit.py --data-root D:/datasets/SkyGuard-Datasets
~~~

`rpee_recordings.csv` 保存来源片段的场景和昼夜审阅依据。室内、黄昏及无法核对的片段保留为 `unknown`。官方划分用于复现发布方协议，跨视频实验另按来源和机位留出。

[数据发布页](https://doi.org/10.34735/ped.2024.2) · [基准论文](https://doi.org/10.1109/ACCESS.2025.3563311)



## 本地完整性和 A～F 候选矩阵

从本工作区运行以下命令。脚本读取仓库外的作者数据，保留官方划分。候选矩阵的项目划分由负责人另行提供。

~~~powershell
$root = 'D:/datasets/SkyGuard-Datasets'
python -u data_prep/cchead_verify.py 'D:/datasets/cchead' "$root/audit/cchead_integrity.json"
python -u data_prep/rgbt_audit.py $root
python -u data_prep/dataset_matrix.py "$root/audit"
~~~

RGBT 验收使用 `archives/RGBT-CC-CVPR2021.zip`。矩阵还使用已有 RPEE 审计的 `rpee_image_manifest.csv`。完整性与分组报告在数据目录的 `audit/dataset_readiness_report.md`，RGBT 暗光候选用人员点标注。


## 人头计数实验划分 head-count-v1

正式划分位于 `D:/datasets/SkyGuard-Datasets/gpt-6/splits/head-count-v1`，以 `split_protocol.json` 记录清单 SHA-256、输入索引和校验结果。已有版本作为历史证据保留，修订使用新的版本目录。

- 第一轮训练只读 `development/train_round1.csv` 的 Cchead 样本。
- 第二轮训练只读 `development/train_round2.csv` 的 Cchead 和 RPEE 音乐会入口样本。
- `development/validation.csv` 用于开发验证和选择模型，来自 Cchead 校园路同机位的另一段。
- `sealed/final_rpee_station.csv` 用于固定所有模型和推理参数后的最终评测。`sealed/pending_rgbt_dark.csv` 保留待核实许可的暗光点标注候选。
- 训练和开发流程只接收相应 `development/` 清单。增强样本继承原图角色。若根据最终测试结果改模型或参数，为后续正式比较另外准备留出数据。

用以下命令生成新版本的同口径清单。OpenCV、NumPy 和 Pillow 可复用现有模型隔离环境。

~~~powershell
$python = 'D:/models/SkyGuard/envs/yolov8s-head/Scripts/python.exe'
& $python -I -B -u data_prep/freeze_head_count_split.py 'D:/datasets/SkyGuard-Datasets' 'D:/datasets/cchead' 'D:/datasets/SkyGuard-Datasets/gpt-6/splits/head-count-v1-repro-check'
~~~


## 当前划分 head-count-v2

使用 `D:/datasets/SkyGuard-Datasets/gpt-6/splits/head-count-v2`。head-count-v1 留作版本历史。

- `development/` 保存两轮训练清单与开发验证清单。后续训练入口先调用 `verify_fit_inputs`，只使用它返回的两份开发清单，增强数据继承原图角色。
- `test/A/` 至 `test/F/` 各含一份测试清单。图片与原标注按 `ready/`、`pending_license/` 放在独立子目录。
- B 组固定使用 Cchead 正俯视街道 `street_train` 的 1,888 个中人数样本。该作者序列名留作追溯，本项目角色为最终测试。整个街道序列从训练和开发验证排除。
- RGBT-CC 的 385 个暗光样本存入 `pending_license/`。F 组 84 个样本均在该状态，使用许可另行确认。
- 最终评测在确认模型、阈值和推理配置后读取测试子目录。开发报告使用开发验证数据。

~~~powershell
$python = 'D:/models/SkyGuard/envs/yolov8s-head/Scripts/python.exe'
$split = 'D:/datasets/SkyGuard-Datasets/gpt-6/splits/head-count-v2'
& $python -E -s -B data_prep/partition_head_count_v2.py check-fit $split 1
& $python -E -s -B data_prep/partition_head_count_v2.py check-fit $split 2
~~~

`split_protocol.json` 固定开发与测试清单的 SHA-256，并记录来源隔离和交叉重复筛查。


## 开发验证基线

`evaluation/head_count_baseline.py` 经开发入口校验后逐图运行锁定的 Cchead 开发验证清单。原版权重、划分、配置和脚本哈希保存在输出目录的 `run_protocol.json`。每批保存可续跑的检查点。同一运行目录仅在协议哈希一致时续跑。

~~~powershell
$python = 'D:/models/SkyGuard/envs/yolov8s-head/Scripts/python.exe'
$split = 'D:/datasets/SkyGuard-Datasets/gpt-6/splits/head-count-v2'
$weights = 'D:/models/SkyGuard/yolov8s-head/wesjos/v8s-head.pt'
$output = 'D:/datasets/SkyGuard-Datasets/gpt-6/evaluations/head-count-v2/baseline-v1'
& $python -I -B -u evaluation/head_count_baseline.py $split $weights $output
~~~

加 `--smoke` 时使用单独输出目录。开发基线的 5,472 张来自同一机位的校园路另一段。冻结测试走单独的阶段与入口。


## 第一轮 Cchead 微调与配对复测

训练入口使用 head-count-v2 的第一轮清单及开发验证清单。转换后的资料、训练检查点和评测记录均保存在独立数据目录。构造的 YOLO 配置只列开发阶段的 train 和 val。流程先用单独的运行目录执行 `--smoke`，再启动正式的两 epoch 微调；后者每 epoch 产出一个恢复点，配对复测固定最后 epoch 的 EMA 权重。

~~~powershell
$python = 'D:/models/SkyGuard/envs/yolov8s-head/Scripts/python.exe'
$split = 'D:/datasets/SkyGuard-Datasets/gpt-6/splits/head-count-v2'
$weights = 'D:/models/SkyGuard/yolov8s-head/wesjos/v8s-head.pt'
$baseline = 'D:/datasets/SkyGuard-Datasets/gpt-6/evaluations/head-count-v2/baseline-v1'
$run = 'D:/datasets/SkyGuard-Datasets/gpt-6/experiments/head-count-v2/round1-v1-repro-check'
& $python -I -B -u training/round1_head_finetune.py $split $weights $run
& $python -I -B -u evaluation/compare_round1_head_count.py $split $run $baseline
~~~

已经有未完成训练的同协议运行，可显式加 `--resume` 从完整 epoch 检查点恢复。复测核对原版协议、模型、逐图验证清单和完整训练回执，比较相同图片和固定的推理参数。


## 第二轮 Cchead 与 RPEE 混合微调

训练入口固定使用 head-count-v2 的第二轮训练清单和同一开发验证清单。原版为两轮共同起点。每个 epoch 按冻结顺序抽取 3,396 张 Cchead 和 607 张 RPEE，两次轮换覆盖全部 4,719 张独立图像。训练与首轮采用相同批量、更新次数和推理配置。每个 epoch 的实际曝光顺序与训练计划核对。

~~~powershell
$python = 'D:/models/SkyGuard/envs/yolov8s-head/Scripts/python.exe'
$split = 'D:/datasets/SkyGuard-Datasets/gpt-6/splits/head-count-v2'
$weights = 'D:/models/SkyGuard/yolov8s-head/wesjos/v8s-head.pt'
$reference = 'D:/datasets/SkyGuard-Datasets/gpt-6/evaluations/head-count-v2/baseline-v1'
$round1 = 'D:/datasets/SkyGuard-Datasets/gpt-6/experiments/head-count-v2/round1-v1'
$round2 = 'D:/datasets/SkyGuard-Datasets/gpt-6/experiments/head-count-v2/round2-v1-repro-check'
& $python -I -B -u training/round2_head_finetune.py $split $weights $round1 $round2
& $python -I -B -u evaluation/compare_round1_head_count.py $split $round2 $reference
~~~

两轮共用同一个配对评测入口。按运行目录和训练回执识别权重版本。输出仍使用同一批开发图，最终测试单独执行。


## A～F 小样场景诊断

`evaluation/scene_probe.py` 运行三版权重与两个推理参数探针，`evaluation/probe_dense_heads.py` 在同一批已曝光 C/F 样本检验切块和暗部增强。源数据和报告保留于独立数据目录，本轮结果用于开发诊断。RGBT 只在本地 RGB 暗光计数探针使用，正式许可继续核实。详见 `D:/datasets/SkyGuard-Datasets/gpt-6/evaluations/head-count-v2/scene-probe-v1/report.md`。
