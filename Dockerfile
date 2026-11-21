FROM docker:28-cli AS docker-cli
FROM node:22-alpine
WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8001 LAB_CONTAINER=1 DATA_DIR=/data LAB_INTERNAL_ENDPOINT=http://console:8001
EXPOSE 8001
CMD ["node", "index.js"]
