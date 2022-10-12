ARG NODE_VERSION=16

# 1. Create an image to build n8n
FROM n8nio/base:${NODE_VERSION} as builder

RUN npm install -g run-script-os turbo@1.5.5
RUN corepack enable && corepack prepare pnpm@7.13.4 --activate

COPY .npmrc turbo.json package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY patches ./patches

RUN chown -R node:node .
USER node

RUN pnpm install --frozen-lockfile
RUN pnpm postinstall
RUN pnpm build
RUN rm -rf node_modules
RUN NODE_ENV=production pnpm install --prod --no-optional
# TODO: removing dev dependecies is deleting `bn.js`, which breaks the Snowflake node
# RUN pnpm i --omit=dev bn.js
RUN find . -type f -name "*.ts" -o -name "*.js.map" -o -name "*.vue" -o -name "tsconfig.json" -o -name "*.tsbuildinfo" | xargs rm
RUN rm -rf patches .npmrc *.yaml node_modules/.cache packages/**/node_modules/.cache packages/**/.turbo .config .cache .local .node /tmp/*


# 2. Start with a new clean image with just the code that is needed to run n8n
FROM n8nio/base:${NODE_VERSION}
COPY --from=builder /home/node ./
COPY docker/images/n8n-custom/docker-entrypoint.sh ./

RUN \
	mkdir .n8n && \
	chown node:node .n8n
USER node
ENV NODE_ENV=production
ENTRYPOINT ["tini", "--", "./docker-entrypoint.sh"]
