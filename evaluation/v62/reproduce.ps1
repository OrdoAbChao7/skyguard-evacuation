# SkyGuard V6.2 复现脚本（PowerShell）
# 注意：不要覆盖 evaluation/v61 冻结数据；V6.1 复跑输出到临时目录。
$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path "$PSScriptRoot\..\..")

npm run test --prefix backend
npm test --prefix frontend
npx tsc --noEmit --project backend
npx tsc --noEmit --project frontend
npm run build
npm run demo
npm run demo:mvp
npm run benchmark:competition --prefix backend
npm run benchmark:v6 --prefix backend
npm run benchmark:v62 --prefix backend

$replay = Join-Path $env:TEMP "skyguard-v61-replay"
$env:V61_OUT_DIR = $replay
$env:V61_REPORT_PATH = Join-Path $replay "V6_1_REPORT.md"
npm run benchmark:v61 --prefix backend

npm run verify:evidence --prefix backend
npm run manifest:evidence --prefix backend
npx tsx backend/scripts/evidence-manifest.ts --verify
