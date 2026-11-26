# Smart Calendar – single container, no native dependencies (built-in node:sqlite)
FROM node:24-alpine
RUN apk add --no-cache tzdata su-exec
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data TZ=Europe/Berlin
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
