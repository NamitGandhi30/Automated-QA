FROM node:20-slim

# Install Python for pytest support
RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install test frameworks globally
RUN npm install -g jest vitest ts-jest @types/jest typescript && \
    pip3 install --break-system-packages pytest

# Create a working directory for test execution
RUN mkdir -p /app/tests

# Copy test runner agent server
COPY server.js /app/server.js

EXPOSE 5000

# Start the test runner agent server
CMD ["node", "/app/server.js"]
