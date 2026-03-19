FROM node:24-slim

ENV CHROME_BIN=/usr/bin/google-chrome-stable \
    FORCE_COLOR=0

RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable libxshmfence-dev --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /code

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

CMD ["npm", "test"]
