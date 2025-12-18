FROM node:20-bookworm-slim

WORKDIR /app

# sqlite3 native module may need build tools depending on platform
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./server.js
COPY server ./server
COPY public ./public
COPY populate-sample-data.js ./populate-sample-data.js
COPY sample-data.js ./sample-data.js
COPY garmin-parser.js ./garmin-parser.js

# Ensure runtime directories exist (volumes may overwrite, but this helps first boot)
RUN mkdir -p /app/uploads/tmp /app/uploads/photos

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]

