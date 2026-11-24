# A～F 场景数据卡

A～F 是人数统计的六种工况。A/B/C 对应日间低、中、高人数，D/E/F 对应夜间或暗光低、中、高人数。检测器使用单一 head 类别。

| 组 | 冻结测试来源 | 清单样本数 | 仓库示例 |
| --- | --- | ---: | --- |
| A | RPEE-Heads | 16 | Cchead 校园路开发图 |
| B | Cchead 正俯视街道 | 1,888 | Cchead 校园路、RPEE 活动入口开发图 |
| C | RPEE-Heads | 48 | RPEE 日间高人数开发图 |
| D | RPEE-Heads 12、RGBT-CC 97 | 109 | 现有开发划分无样例 |
| E | RPEE-Heads 35、RGBT-CC 204 | 239 | RPEE 夜间中人数开发图 |
| F | RGBT-CC | 84 | RPEE 夜间高人数开发图 |

测试清单的 2,384 条含 385 条许可待核的 RGBT-CC 条目。测试素材及逐图标注保存在仓库外。示例源于本项目第二轮的训练清单，同时均为各发布方原始 train 图，供查看样例和检查读取格式。示例图和标签按原文件保留，未转码或改标。同一字节的图像哈希在冻结测试清单中无匹配。F 的示例对应 RPEE，F 的测试汇总对应 RGBT-CC 暗光 RGB。

## 来源和署名

- **Cchead v10**，Kailai Sun，Kaggle 发布账号 `sunkailai`，CC BY-NC 4.0。图为原始 RGB 帧，标注含人头框和序列内跟踪 ID。转载须署名并遵守非商业条款。[作者仓库](https://github.com/kailaisun/Cchead) · [发布页](https://www.kaggle.com/datasets/sunkailai/cchead) · [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)
- **RPEE-Heads**，M. Abubaker 等，CC BY-SA 4.0。附作者的原始 RGB 图与标注，后续改编按许可署名、标注修改、同许可分发。[数据 DOI](https://doi.org/10.34735/ped.2024.2) · [作者论文](https://doi.org/10.1109/ACCESS.2025.3563311) · [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
- **RGBT-CC**，Lingbo Liu 等。RGB 与热成像配对，GT 为人数点。项目本地诊断采用暗光列表里的 RGB 图。再分发许可尚未核实，工作区只收录来源、数量及汇总结果。[作者项目](https://lingboliu.com/RGBT_Crowd_Counting.html) · [作者仓库](https://github.com/chen-judge/RGBTCrowdCounting)

[samples/manifest.csv](samples/manifest.csv) 记录示例文件的相对路径、许可和字节级校验。[scene_catalog.csv](scene_catalog.csv) 记录冻结数据统计。[数据适配](../docs/DATASET_ADAPTATION.md) 说明标注读取与评测方法。
