# EC2 Deployment Instructions

Follow these steps to host your `localstore` app on an AWS EC2 instance.

## 1. Setup EC2 Instance
- Launch a new EC2 instance (Ubuntu 22.04+ recommended).
- **Security Group Settings**:
  - Allow SSH (Port 22).
  - Allow HTTP (Port 80) and HTTPS (Port 443).
  - Allow Port 3000 (if you want direct access, otherwise use a reverse proxy).

## 2. Connect to EC2
```bash
ssh -i "your-key.pem" ubuntu@your-ec2-public-ip
```

## 3. Run Setup Script
Copy `ec2-setup.sh` to your EC2 instance and run it:
```bash
chmod +x ec2-setup.sh
./ec2-setup.sh
```
This script installs:
- Node.js v20
- Git
- PM2 (Process Manager)

## 4. Clone and Install
```bash
cd ~/apps
git clone https://github.com/harmad0232-max/localstore.git
cd localstore
npm install
```

## 5. Configure Environment
Create a `.env` file with your production settings:
```bash
nano .env
```
Add your variables:
```
PORT=3000
SESSION_SECRET=your_secret
# Add AWS/Stripe/Google keys as needed
```

## 6. Start Application
Use PM2 to start the application and keep it running:
```bash
pm2 start ecosystem.config.js
```

## 7. Setup Reverse Proxy (Optional but Recommended)
Install Nginx to forward Port 80 to Port 3000:
```bash
sudo apt install nginx -y
sudo nano /etc/nginx/sites-available/default
```
Update the `location /` block:
```nginx
location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
}
```
Restart Nginx:
```bash
sudo systemctl restart nginx
```
