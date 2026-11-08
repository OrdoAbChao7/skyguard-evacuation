# SkyGuard MVP — multi-stage build
FROM node:24-bookworm AS build
WORKDIR /app
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/
RUN npm ci --prefix backend && npm ci --prefix frontend
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8010 \
    SAFETY_SCENARIO_FILE=stadium-evacuation.json \
    MVP_STATE_FILE=/app/data/mvp-state.json
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/package*.json ./backend/
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/frontend/dist ./frontend/dist
COPY data ./data
RUN mkdir -p /app/data/audit && chown -R node:node /app/data
VOLUME ["/app/data"]
EXPOSE 8010
USER node
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8010/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "backend/dist/index.js"]
