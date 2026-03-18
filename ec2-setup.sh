#!/bin/bash

# Update system
sudo apt-get update -y
sudo apt-get upgrade -y

# Install Node.js (v20)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Git
sudo apt-get install -y git

# Install PM2 globally
sudo npm install pm2 -g

# Setup directories
mkdir -p ~/apps
cd ~/apps

echo "Setup complete. You can now clone your repository and start the server using PM2."
