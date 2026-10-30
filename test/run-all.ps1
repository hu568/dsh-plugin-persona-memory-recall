# 一次跑完所有测试：先测仓库源码，再测 profile 里**已安装**的那份。
#
# 纯 node 的用例直接跑；需要宿主包的用例（cordis）用 Harness 的 Electron node 跑，
# 并把结果写进临时文件再回读 —— Electron 以 ELECTRON_RUN_AS_NODE 运行时 stdout
# 会被吞掉（与父插件 test/run-all.ps1 同款做法）。
#
# 跑法：pwsh -File test/run-all.ps1

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$harness = 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$installed = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\@dsh-external\dsh-persona-memory-recall'

$node = $env:DSH_NODE
if (-not $node) {
    $candidate = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
    $node = if (Test-Path $candidate) { $candidate } else { 'node' }
}

$failures = @()

# 用 Harness 的 node 跑一个 .mjs，结果经临时文件回读。
function Invoke-HarnessMjs {
    param([string]$Script, [string]$Entry)

    $result = Join-Path $env:TEMP ('pmr-test-' + [guid]::NewGuid().ToString('N') + '.txt')
    $env:ELECTRON_RUN_AS_NODE = '1'
    if ($Entry) { $env:PERSONA_MEMORY_RECALL_ENTRY = $Entry }
    else { Remove-Item Env:PERSONA_MEMORY_RECALL_ENTRY -ErrorAction SilentlyContinue }

    $scriptUrl = 'file:///' + ($Script -replace '\\', '/')
    $js = "const fs=require('fs');import('$scriptUrl').then(()=>fs.appendFileSync(process.env.PMR_OUT,'PASS')).catch(e=>fs.appendFileSync(process.env.PMR_OUT,'FAIL: '+(e&&e.stack||e)))"
    $env:PMR_OUT = $result

    & $harness -e $js | Out-Null
    for ($i = 0; $i -lt 150 -and -not (Test-Path $result); $i++) { Start-Sleep -Milliseconds 200 }
    if (-not (Test-Path $result)) { throw "测试未产出结果：$Script" }
    Start-Sleep -Milliseconds 300
    $text = Get-Content $result -Raw
    Remove-Item $result -ErrorAction SilentlyContinue
    return $text
}

function Invoke-Pure {
    param([string]$Name, [string]$Entry)

    if ($Entry) { $env:PERSONA_MEMORY_RECALL_ENTRY = $Entry }
    else { Remove-Item Env:PERSONA_MEMORY_RECALL_ENTRY -ErrorAction SilentlyContinue }

    & $node (Join-Path $repo "test\$Name.test.mjs")
    if ($LASTEXITCODE -ne 0) { $script:failures += "$Name.test.mjs" }
}

$pure = @('tokenize', 'chunk', 'bm25', 'journal-cache', 'select', 'query', 'inject', 'settings')
$index = 0
foreach ($name in $pure) {
    $index += 1
    Write-Host "=== $index/$($pure.Count + 3) $name.test.mjs（仓库源码，纯 node）" -ForegroundColor Cyan
    Invoke-Pure -Name $name
}

$total = $pure.Count + 3
Write-Host "=== $($pure.Count + 1)/$total cordis-integration.test.mjs（仓库源码，真实 cordis）" -ForegroundColor Cyan
if (-not (Test-Path $harness)) {
    Write-Host "跳过：找不到 Harness（$harness）" -ForegroundColor Yellow
} else {
    $result = Invoke-HarnessMjs -Script (Join-Path $repo 'test\cordis-integration.test.mjs')
    Write-Host $result
    if ($result -notmatch 'PASS') { $failures += 'cordis-integration.test.mjs (repo)' }
}

Write-Host "=== $($pure.Count + 2)/$total real-data.test.mjs（只读真实日志）" -ForegroundColor Cyan
& $node (Join-Path $repo 'test\real-data.test.mjs')
if ($LASTEXITCODE -ne 0) { $failures += 'real-data.test.mjs (repo)' }

Write-Host "=== $($pure.Count + 3)/$total 同样几项跑 profile 里已安装的那份" -ForegroundColor Cyan
if (-not (Test-Path $installed)) {
    Write-Host "跳过：未安装 $installed" -ForegroundColor Yellow
} else {
    $entry = 'file:///' + (($installed -replace '\\', '/') + '/lib/index.js')

    Write-Host '--- inject（已安装）' -ForegroundColor Cyan
    Invoke-Pure -Name 'inject' -Entry $entry

    if (Test-Path $harness) {
        Write-Host '--- cordis-integration（已安装）' -ForegroundColor Cyan
        $result = Invoke-HarnessMjs -Script (Join-Path $repo 'test\cordis-integration.test.mjs') -Entry $entry
        Write-Host $result
        if ($result -notmatch 'PASS') { $failures += 'cordis-integration.test.mjs (installed)' }
    }
}

Write-Host ''
if ($failures.Count -gt 0) {
    Write-Host ('✗ 失败：' + ($failures -join '、')) -ForegroundColor Red
    exit 1
}
Write-Host '✓ 全部通过' -ForegroundColor Green
