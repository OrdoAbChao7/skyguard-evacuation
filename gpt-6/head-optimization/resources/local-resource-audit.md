# SkyGuard 本地视觉资源验收

2026-11-22。G0～G4 的本地资源验收通过。使用指定人头权重和 OpenCV Farneback。实验数据与划分由老板另行提供。

## YOLOv8s-Head

- 来源为 [wesjos/YOLO-head-detection](https://huggingface.co/wesjos/YOLO-head-detection)，发布许可 AGPL-3.0。
- [Hugging Face 固定版本直链](https://huggingface.co/wesjos/YOLO-head-detection/resolve/563f0f1fe4b3020fb109ced1648e5bbf6f7a554b/v8s-head.pt?download=true) 返回 HTTP 200，实际大小为 22,513,507 字节。
- 本地路径为 `D:/models/SkyGuard/yolov8s-head/wesjos/v8s-head.pt`。SHA-256 为 `1467b10e30a05be6a05950190e5efe30b50681270cb7baf6115ec96806b25964`，与发布端相同。363 个 ZIP 成员的 CRC 全部通过。已排除 Git LFS 指针，临时下载文件已清理。
- 模型通过 `torch_safe_load(safe_only=True)` 加载，进程强制 `TORCH_FORCE_WEIGHTS_ONLY_LOAD=1`。先在 CPU 重建，再将全部参数迁入 RTX 4060 Laptop 的 `cuda:0`，完成设备同步。
- 实际模型为 `DetectionModel`，检测头为 `Detect`，深度系数 0.33、宽度系数 0.5、参数 11,135,987，检测步长为 8、16、32。RGB 输入为 3 通道。640 像素输入尺寸检查通过，训练元数据同样记录 640。
- 检测类别数为 1。内置名称表实际为 `{0: "0"}`，发布者说明类别 0 对应 `head`。
- 通过加载的模型权重可作为后续微调初始化。检查点 `epoch=-1` 且无优化器状态，不能按原训练进度完整续跑。训练能力尚未通过实际训练验证。

## 独立环境与 Farneback

- 环境位于 `D:/models/SkyGuard/envs/yolov8s-head`，Python 3.12.7，Ultralytics 8.4.216，PyTorch `2.12.1+cu130`，Torchvision `0.27.1+cu130`。CUDA 13.0 构建，RTX 4060 Laptop GPU 可用。
- 从现有安装离线复用 PyTorch、Torchvision，按安装记录验证文件后重新装入隔离环境。其余依赖为官方 PyPI wheel。Torch、Torchvision、Ultralytics、OpenCV、NumPy 已核对均从隔离环境导入。该环境的 `pip check` 返回 `No broken requirements found.`
- 只有 `opencv-python 4.10.0.84` 提供 `cv2`，运行时 OpenCV 4.10.0，NumPy 2.3.5。以种子 20261122 生成两张 128×160 灰度图，第二张移动 `(4, -3)` 像素。
- Farneback 返回形状为 `(128, 160, 2)` 的 `float32` 光流场，数值全部有限。纹理内部区域的中位位移为 `(3.99971, -2.99981)` 像素/帧，接口自检通过。该结果覆盖合成平移。
- A～F 数据、模型推理、训练和实际人流速度评估留到后续获批阶段。

## 复跑 G2

从 `gpt-6/head-optimization` 运行。脚本检查发布权重哈希，强制受限加载，输出结构和设备结果。

~~~powershell
$python = 'D:/models/SkyGuard/envs/yolov8s-head/Scripts/python.exe'
& $python -I -B resources/model_g2_smoke.py 'D:/models/SkyGuard/yolov8s-head/wesjos/v8s-head.pt'
& $python -I -B -m pip check
~~~

完整安装清单位于隔离环境的 `runtime-install-report.json`。 [Ultralytics 固定版加载源码](https://github.com/ultralytics/ultralytics/blob/v8.4.216/ultralytics/nn/tasks.py)
