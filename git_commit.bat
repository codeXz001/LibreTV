@echo off
chcp 65001 >nul
cd /d "F:\app\my\LibreTV"
echo ============================================
echo  LibreTV - Git commit helper
echo ============================================
echo.
echo [1/3] git add -A
git add -A
if errorlevel 1 goto :fail

rem Exclude the helper files themselves from the commit
git reset -q -- commit_message.txt git_commit.bat

echo.
echo [2/3] git commit -F commit_message.txt
git commit -F commit_message.txt
if errorlevel 1 goto :fail

echo.
echo [3/3] Show status
git status --porcelain
echo.
echo Commit done.
echo.
echo Optional: push with:  git push origin <branch>
pause
exit /b 0

:fail
echo.
echo [ERROR] Commit failed. Check git status / conflict above.
pause
exit /b 1
