# V6.2 复现说明

```powershell
powershell -ExecutionPolicy Bypass -File evaluation/v62/reproduce.ps1
```

- 固定种子：`20261105..20261134`（30 个）。
- V6.1 原始数据已冻结（`evaluation/v61/FREEZE.sha256`）；V6.1 复跑输出到 `%TEMP%/skyguard-v61-replay`，不覆盖冻结数据。
- 所有数字可由 `verify:evidence` 从 raw JSON 复算。
- 全部为合成数据；不代表真实场地/平台/硬件。
