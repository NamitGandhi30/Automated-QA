FROM node:20-slim

# ──────────────────────────────────────────────────────────────────────────
# Universal, batteries-included test runner.
# Every language toolchain the extension supports is baked in here so tests
# run identically in ANY user environment with nothing installed locally.
# ──────────────────────────────────────────────────────────────────────────

ENV DEBIAN_FRONTEND=noninteractive

# System toolchains: Python, C/C++ (gcc/g++), Java (JDK), Go, Rust.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates curl \
      python3 python3-pip python3-venv \
      build-essential \
      default-jdk \
      golang-go \
      rustc cargo && \
    rm -rf /var/lib/apt/lists/*

# Python test framework
RUN pip3 install --break-system-packages pytest

# Node test frameworks (global — resolvable from any sandbox via NODE_PATH)
RUN npm install -g jest vitest ts-jest @types/jest typescript

# JUnit 5 standalone console launcher (Java)
RUN mkdir -p /opt/junit && \
    curl -fsSL -o /opt/junit/junit-platform-console-standalone.jar \
      https://repo1.maven.org/maven2/org/junit/platform/junit-platform-console-standalone/1.10.2/junit-platform-console-standalone-1.10.2.jar

# Single-header C / C++ unit-test frameworks
RUN mkdir -p /opt/qa-headers && \
    curl -fsSL -o /opt/qa-headers/utest.h \
      https://raw.githubusercontent.com/sheredom/utest.h/master/utest.h && \
    curl -fsSL -o /opt/qa-headers/doctest.h \
      https://raw.githubusercontent.com/doctest/doctest/v2.4.11/doctest/doctest.h

# Make global node modules resolvable from sandbox test files (e.g. @jest/globals)
ENV NODE_PATH=/usr/local/lib/node_modules
# Writable, hermetic caches for the compiled toolchains
ENV GOCACHE=/tmp/go-build \
    GOPATH=/tmp/go \
    GOFLAGS=-mod=mod \
    GOPROXY=off \
    CARGO_HOME=/tmp/cargo \
    JUNIT_JAR=/opt/junit/junit-platform-console-standalone.jar \
    QA_HEADERS=/opt/qa-headers

WORKDIR /app

# Sandbox dirs for ephemeral, isolated test runs (never the mounted workspace)
RUN mkdir -p /app/sandbox

# Copy test runner agent server
COPY server.js /app/server.js

EXPOSE 5000

CMD ["node", "/app/server.js"]
