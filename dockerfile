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

# SECOND PAIRING RULE: the image tag above pins the browsers, but the v1.44.0
# image also bundles the Node 20.x of its May 2024 build (< 20.16), which is
# too old for pdf-parse@2 / pdfjs-dist (they need process.getBuiltinModule,
# Node >= 20.16 / >= 22.3) — the bundled Node crashed production at module
# load with "ReferenceError: DOMMatrix is not defined". The browsers do not
# care which Node runs the scraper, so we overlay a pinned modern Node LTS
# over /usr/local (which precedes the image's /usr/bin/node on PATH) before
# installing dependencies, so native modules build against it.
# tests/dockerfile-playwright.test.ts asserts this version satisfies every
# dependency's engines.node range in package-lock.json.
ARG NODE_VERSION=22.17.0
RUN ARCH="$(dpkg --print-architecture)" && \
    case "$ARCH" in \
      amd64) NODE_ARCH="x64" ;; \
      arm64) NODE_ARCH="arm64" ;; \
      *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" -o /tmp/node.tar.gz && \
    tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 && \
    rm /tmp/node.tar.gz && \
    [ "$(node --version)" = "v${NODE_VERSION}" ]

# The overlaid Node has no prebuilt sqlite3 binding (its prebuild-install
# resolves no binary for this runtime), so `npm ci` must compile sqlite3 from
# source — build-essential provides the make/g++ toolchain the base image
# lacks. Installed before `npm ci`, together with the runtime libraries
# Playwright's browsers need, in one lean apt layer.
RUN apt-get update && \
    apt-get -y install --no-install-recommends build-essential \
    libnss3 libatk-bridge2.0-0 libdrm-dev libxkbcommon-dev \
    libgbm-dev libasound-dev libatspi2.0-0 libxshmfence-dev && \
    rm -rf /var/lib/apt/lists/*

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