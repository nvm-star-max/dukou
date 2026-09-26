FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
RUN mkdir /data && chown node:node /data
USER node
ENV PORT=8787 TRANSFER_SERVER_DATA=/data
EXPOSE 8787
CMD ["node", "src/server.mjs"]
