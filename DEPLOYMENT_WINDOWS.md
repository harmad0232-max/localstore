# Windows EC2 Deployment Instructions

Follow these steps to host your `localstore` app on a Windows EC2 instance.

## 1. Setup Windows EC2 Instance
- Launch a new EC2 instance with **Windows Server 2022** or later.
- **Security Group Settings**:
  - Allow RDP (Port 3389).
  - Allow HTTP (Port 80) and HTTPS (Port 443).
  - Allow Port 3000 (if you want direct access).

## 2. Connect to EC2 via RDP
Use an RDP client (like Remote Desktop Connection on Windows or Microsoft Remote Desktop on macOS) to connect to your instance using the public IP and administrator password.

## 3. Run Setup Script
Open **PowerShell** (Run as Administrator) on the EC2 instance and execute the setup script.
If you have the script locally, copy it over. Otherwise, you can manually install the following:
1. **Node.js**: [Download here](https://nodejs.org/en/download/) (Choose the LTS version).
2. **Git**: [Download here](https://git-scm.com/download/win).
3. **PM2**: Run `npm install pm2 -g` in PowerShell.

Alternatively, use the provided `windows-ec2-setup.ps1` script:
```powershell
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
.\windows-ec2-setup.ps1
```

## 4. Clone and Install
In PowerShell:
```powershell
mkdir C:\apps
cd C:\apps
git clone https://github.com/harmad0232-max/localstore.git
cd localstore
npm install
```

## 5. Configure Environment
Create a `.env` file in `C:\apps\localstore`:
```powershell
notepad .env
```
Add your variables:
```env
PORT=3000
SESSION_SECRET=your_secret
# Add AWS/Stripe/Google keys as needed
GOOGLE_CALLBACK_URL=http://your-ec2-ip.nip.io/auth/google/callback
```

## 6. Start Application
Use PM2 to start the application:
```powershell
pm2 start ecosystem.config.js
```

### **Keep PM2 Running on Reboot (Windows Service)**
To ensure your app starts automatically when Windows reboots:
```powershell
npm install pm2-windows-startup -g
pm2-startup install
pm2 save
```

## 7. Setup IIS as Reverse Proxy (Optional)
If you want to use Port 80, it's recommended to use **IIS (Internet Information Services)** with **URL Rewrite** and **Application Request Routing (ARR)** modules.

1. Install **IIS** via Server Manager.
2. Install **Application Request Routing (ARR)** and **URL Rewrite** modules.
3. In IIS Manager, enable Proxy in Application Request Routing.
4. Create a web site or use the default one and add a **Reverse Proxy** rule to point to `http://localhost:3000`.

Alternatively, you can just change your `.env` to `PORT=80` (requires no other web server running on Port 80).
