# This Dockerfile sets up a container environment for running a Node.js application with Playwright.
FROM node:20

# Use the Playwright image from Microsoft's container registry
FROM mcr.microsoft.com/playwright:jammy

# Set the working directory inside the container
WORKDIR /app

# Add the node_modules/.bin directory to the PATH environment variable
ENV PATH /app/node_modules/.bin:$PATH

# Copy the application files to the container
COPY . ./

# Install the application dependencies (node_modules is not committed)
RUN npm install

# Build the application using npm
RUN npm run build

# Install additional dependencies required by Playwright
RUN apt-get update && \
    apt-get -y install libnss3 libatk-bridge2.0-0 libdrm-dev libxkbcommon-dev \
    libgbm-dev libasound-dev libatspi2.0-0 libxshmfence-dev