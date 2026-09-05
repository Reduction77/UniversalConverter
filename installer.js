function batchQuote(value) {
  return `"${String(value).replace(/%/g, '%%')}"`;
}

function buildWingetBatch(keys, engineDefs, wingetPath) {
  const packages = keys.map(key => engineDefs[key]).filter(Boolean);
  const winget = batchQuote(wingetPath);
  const calls = packages.map(def => `call :install ${batchQuote(def.label)} ${batchQuote(def.winget)}`);
  return [
    '@echo off',
    'setlocal EnableExtensions DisableDelayedExpansion',
    'chcp 65001 >nul',
    'title 万能文件转换器 - 管理员安装',
    'set "UC_FAILED=0"',
    'type nul > "%~dp0results.txt"',
    'echo ==============================================',
    'echo   万能文件转换器 - 最新版转换引擎安装',
    'echo ==============================================',
    'echo.',
    'echo [1/2] 正在更新 winget 软件源...',
    `${winget} source update`,
    'if not "%errorlevel%"=="0" (',
    '  echo source^|failed^|%errorlevel%>> "%~dp0results.txt"',
    '  echo 软件源更新失败，无法确认最新版本。按任意键关闭。',
    '  pause >nul',
    '  exit /b 1',
    ')',
    'echo.',
    'echo [2/2] 正在升级或安装转换引擎...',
    ...calls,
    'echo.',
    'if "%UC_FAILED%"=="0" (',
    '  echo ==============================================',
    '  echo   安装或更新检查已完成，请返回程序查看检测结果',
    '  echo ==============================================',
    '  echo 此窗口将在 4 秒后自动关闭...',
    '  timeout /t 4 /nobreak >nul',
    '  exit /b 0',
    ') else (',
    '  echo ==============================================',
    '  echo   部分引擎安装失败，请查看上方错误信息',
    '  echo ==============================================',
    '  echo 按任意键关闭窗口...',
    '  pause >nul',
    '  exit /b 1',
    ')',
    '',
    ':install',
    'echo.',
    'echo ----------------------------------------------',
    'echo 正在处理：%~1',
    'echo ----------------------------------------------',
    `${winget} install --id "%~2" -e --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity --silent`,
    'set "UC_CODE=%errorlevel%"',
    'if "%UC_CODE%"=="0" goto installed',
    'if "%UC_CODE%"=="-1978335189" goto current',
    'if "%UC_CODE%"=="2316632107" goto current',
    'echo %~2^|failed^|%UC_CODE%>> "%~dp0results.txt"',
    'echo [失败] %~1，退出代码 %UC_CODE%',
    'set "UC_FAILED=1"',
    'exit /b 0',
    ':installed',
    'echo %~2^|installed^|0>> "%~dp0results.txt"',
    'echo [完成] %~1 已安装或更新',
    'exit /b 0',
    ':current',
    'echo %~2^|current^|%UC_CODE%>> "%~dp0results.txt"',
    'echo [无需更新] %~1 在当前软件源中没有适用更新',
    'exit /b 0',
    '',
  ].join('\r\n');
}

function buildElevationLauncher() {
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "$cmdLine = '/d /s /c \"\"' + $env:UC_INSTALL_SCRIPT + '\"\"'",
    "$process = Start-Process -FilePath $env:ComSpec -ArgumentList $cmdLine -Verb RunAs -Wait -PassThru",
    'exit $process.ExitCode',
    '} catch {',
    '  if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }',
    '  Write-Error $_',
    '  exit 1',
    '}',
    '',
  ].join('\r\n');
}

module.exports = { buildWingetBatch, buildElevationLauncher };
