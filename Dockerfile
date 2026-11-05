FROM node:22-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm i tsx typescript

FROM base AS dev
RUN npm ci
COPY . .

FROM base AS prod
COPY . .
