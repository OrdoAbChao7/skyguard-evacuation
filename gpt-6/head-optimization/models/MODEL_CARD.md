# SkyGuard YOLOv8s-Head 模型二

- 任务为固定摄像头 RGB 单帧人头检测及计数。标签类别索引为 `0`，语义为 `head`。
- 初始化来自 wesjos 的 [YOLO-head-detection](https://huggingface.co/wesjos/YOLO-head-detection)，使用发布版本 `563f0f1fe4b3020fb109ced1648e5bbf6f7a554b` 的 [v8s-head.pt](https://huggingface.co/wesjos/YOLO-head-detection/resolve/563f0f1fe4b3020fb109ced1648e5bbf6f7a554b/v8s-head.pt?download=true)。原始权重 SHA-256 为 `1467b10e30a05be6a05950190e5efe30b50681270cb7baf6115ec96806b25964`。
- 本项目的模型二以原始权重初始化，在 Cchead 与 RPEE-Heads 上训练 2 个 epoch。评测使用 `round2-v1/trained/weights/last.pt` 的最后 epoch EMA，文件为 **111,758,567 字节**。
- 模型二 SHA-256 为 `48e20da23a4c645bf29d47e4da1ae0ec52b9e0220e610d96fbc8c5336ddc6e7e`。
- **模型二公开下载状态**：待核实分发条件。计划的 Release 附件名为 `skyguard-yolov8s-head-round2.pt`。上方的基础权重链接用于获得训练起点。
- 原始权重声明 AGPL-3.0。模型二公开分发需核对适用的许可证通知、完整对应源码和数据使用范围。[Ultralytics 发布指导](https://docs.ultralytics.com/help/contributing/#licensing-and-open-source-obligations)
- 本地复测环境为 Windows、Python 3.12.7、Ultralytics 8.4.216、PyTorch 2.12.1+cu130、OpenCV 4.10.0、RTX 4060 Laptop。

默认输入 640，置信度 0.25。B 组使用重叠切块，C 组采用切块加全图大头补检。F 的本地暗光高人数抽测仍有显著漏计。适用条件见 [数据适配](../docs/DATASET_ADAPTATION.md) 和 [精度结果](../docs/results/six_scene_accuracy.csv)。
