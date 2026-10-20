FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_FILE=/data/captions.sqlite
COPY package.json server.mjs captions.html client.mjs audio.mjs media.mjs adaptive-video.mjs hls-variants.mjs ./
COPY lib ./lib
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.mjs"]
