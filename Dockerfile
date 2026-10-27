# MiniForces: Node server + judge with g++, Python 3 and Java in one image.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ python3 openjdk-17-jdk-headless ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .

# The server runs as root inside the container only so the judge can run student
# programs as an unprivileged user (uid 65000+). Secrets live in /app/data (mode 700).
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DATA_DIR=/app/data JUDGE_DIR=/tmp/miniforces-judge
EXPOSE 3000
CMD ["node", "--no-warnings=ExperimentalWarning", "server.js"]
