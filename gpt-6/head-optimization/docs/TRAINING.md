# 原版基线与两轮微调

两轮训练均使用同一个 wesjos v8s-head 初始化，将源头框转换为单类别 YOLO 格式。数据清单版本为 `head-count-v2`。训练和验证分别通过冻结清单输入。封存测试另行加载。

- 第一轮为 4,003 张 Cchead 校园路图。第二轮训练池为同样的 Cchead 4,003 张和 RPEE 活动入口 716 张，每个 epoch 固定读取 3,396 张 Cchead 与 607 张 RPEE，两轮轮换覆盖全部 4,719 张。
- 每轮微调都是 2 个 epoch、8,006 次图像读取、1,063 次优化器更新。输入 640、批量 4、AdamW、初始学习率 0.001、FP32、种子 20261123。每个 epoch 保存恢复点，最后一个 epoch 的 EMA 用来比较计数。
- 配对复测都使用同机位另一个片段的 5,472 张图像、输入 640、置信度 0.25、NMS IoU 0.50、max_det 1000、批量 8、FP32。头框匹配用置信度顺序和 IoU ≥ 0.50。整体人数 MAE 依次为原版 14.78、模型一 2.51、模型二 3.16 人/张。
- 第一轮小批发现训练回调错误，修正后 16 张训练、16 张验证完成短测，再从原版启动正式运行。第二轮也以短测确认标签转换、数据轮换与检查点加载。

## 运行入口

在工作区根目录运行。下面变量按实际数据根、原始权重和隔离环境设置。完整实验依赖通过作者入口取得的原数据、冻结划分及其校验记录。现有入口还会核验历史运行目录、输入路径和文件哈希，复跑应沿用一致的路径布局和运行协议。

~~~powershell
$python = 'D:/models/SkyGuard/envs/yolov8s-head/Scripts/python.exe'
$project = 'D:/datasets/SkyGuard-Datasets'
$split = Join-Path $project 'gpt-6/splits/head-count-v2'
$original = 'D:/models/SkyGuard/yolov8s-head/wesjos/v8s-head.pt'
$baseline = Join-Path $project 'gpt-6/evaluations/head-count-v2/baseline-v1'
$round1 = Join-Path $project 'gpt-6/experiments/head-count-v2/round1-v1'
$round2 = Join-Path $project 'gpt-6/experiments/head-count-v2/round2-v1'

& $python -I -B -u evaluation/head_count_baseline.py $split $original $baseline
& $python -I -B -u training/round1_head_finetune.py $split $original $round1
& $python -I -B -u evaluation/compare_round1_head_count.py $split $round1 $baseline
& $python -I -B -u training/round2_head_finetune.py $split $original $round1 $round2
& $python -I -B -u evaluation/compare_round1_head_count.py $split $round2 $baseline
~~~

先通过单独输出目录的 `--smoke` 验证。正式训练应使用空的运行目录；若明确恢复同协议未完成训练，使用入口的 `--resume`。模型、框架版本、实际权重哈希见 [模型卡](../models/MODEL_CARD.md)。同机位开发复测汇总见 [training_metrics.csv](results/training_metrics.csv)。
