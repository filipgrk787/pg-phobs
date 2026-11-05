FROM node:22-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm i tsx typescript

FROM base AS dev
RUN npm install
COPY . .

FROM base AS prod
COPY . .
