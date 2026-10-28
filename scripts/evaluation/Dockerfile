FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 libseccomp2 git ca-certificates build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.28.1

WORKDIR /app
# Explicit copies exclude .git, .env, local configuration, and any host wallet.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/cli/package.json packages/cli/tsconfig.json ./packages/cli/
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY packages/cli/src ./packages/cli/src
COPY scripts/evaluation ./scripts/evaluation
RUN pnpm run typecheck \
    && pnpm exec tsc --project scripts/evaluation/tsconfig.json \
    && pnpm run build

USER node
CMD ["python3", "scripts/evaluation/run-offline.py", "/usr/local/bin/node", "node_modules/vitest/vitest.mjs", "run", "--config", "scripts/evaluation/vitest.config.ts"]
