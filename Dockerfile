# Node 24 is needed for the built-in SQLite. Everything else has no dependencies, so there is no install step.
FROM node:24-alpine
WORKDIR /app
COPY . .
RUN mkdir -p /app/data
ENV HOST=0.0.0.0 BOOKING_DATA=/app/data TRUST_PROXY=1 COOKIE_SECURE=1
CMD ["node", "server.mjs"]
