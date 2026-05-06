FROM mcr.microsoft.com/playwright:v1.43.0-jammy

WORKDIR /app

RUN npm install -g playwright@1.43.0

EXPOSE 3000

CMD ["npx", "playwright", "run-server", "--port", "3000", "--host", "0.0.0.0"]
