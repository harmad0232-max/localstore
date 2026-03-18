# Windows EC2 Setup Script

# Install Node.js (v20) using Winget
Write-Host "Installing Node.js..." -ForegroundColor Cyan
winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements

# Refresh environment variables
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# Install Git
Write-Host "Installing Git..." -ForegroundColor Cyan
winget install Git.Git --silent --accept-package-agreements --accept-source-agreements

# Refresh environment variables again
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# Install PM2 globally
Write-Host "Installing PM2..." -ForegroundColor Cyan
npm install pm2 -g

# Install PM2 Windows Service (to keep it running on reboot)
Write-Host "Installing PM2 Windows Service..." -ForegroundColor Cyan
npm install pm2-windows-service -g

Write-Host "Setup complete! Please restart your PowerShell session to use the newly installed tools." -ForegroundColor Green
