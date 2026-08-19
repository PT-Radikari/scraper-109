# This Dockerfile sets up a container environment for running a Node.js application with Playwright.
#
# PAIRING RULE: the image tag version MUST equal the `playwright` version pinned
# in package-lock.json. The image ships browsers only for its own Playwright
# release, so a floating tag (e.g. `:jammy`) eventually resolves to a newer
# image whose browsers the npm-installed library cannot find, and every
# `chromium.launch()` fails with "Executable doesn't exist". When bumping
# `playwright` in package.json, bump this tag in the same commit —
# tests/dockerfile-playwright.test.ts enforces the match.
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

# Set the working directory inside the container
WORKDIR /app

# Add the node_modules/.bin directory to the PATH environment variable
ENV PATH /app/node_modules/.bin:$PATH

# Copy the application files to the container
COPY . ./

# Install the application dependencies (node_modules is not committed)
RUN npm ci

# Build the application using npm
RUN npm run build

# Install additional dependencies required by Playwright
RUN apt-get update && \
    apt-get -y install libnss3 libatk-bridge2.0-0 libdrm-dev libxkbcommon-dev \
    libgbm-dev libasound-dev libatspi2.0-0 libxshmfence-dev