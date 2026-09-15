FROM node@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96 AS build
WORKDIR /build
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci
COPY server/package.json server/package-lock.json ./server/
RUN npm --prefix server ci
COPY . .
RUN npm run build && npm --prefix server run build

FROM node@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96 AS api
ENV NODE_ENV=production
WORKDIR /opt/mop/server
COPY --from=build /build/server/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/server/dist ./dist
COPY --from=build /build/packages/platform-sdk /opt/mop/packages/platform-sdk
RUN mkdir -p /opt/mop/node_modules/@metro && ln -s /opt/mop/packages/platform-sdk /opt/mop/node_modules/@metro/platform-sdk
COPY deploy/entrypoint.mjs /opt/mop/entrypoint.mjs
COPY deploy/probe.mjs ./probe.mjs
USER node
ENTRYPOINT ["node", "/opt/mop/entrypoint.mjs"]
CMD ["dist/server.js"]

FROM caddy@sha256:98eb57d882ccd5213d1688764db10c1ca2c58a1ca3a6717a3411ad798f7a423a AS web
COPY --from=build /build/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
