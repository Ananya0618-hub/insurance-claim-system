# Stage 1: build the React UI
FROM node:22-alpine AS ui
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: API server that also serves the built UI
FROM node:22-alpine
WORKDIR /app
COPY backend/package*.json backend/
RUN cd backend && npm ci --omit=dev
COPY backend/ backend/
COPY --from=ui /app/frontend/dist frontend/dist
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
CMD ["node", "backend/src/server.js"]
