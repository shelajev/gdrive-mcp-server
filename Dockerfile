FROM node:22.12-alpine AS builder

# Must be entire project because `prepare` script is run during `npm install` and requires all files.
COPY . /app
COPY tsconfig.json /tsconfig.json

WORKDIR /app

RUN --mount=type=cache,target=/root/.npm npm install

RUN --mount=type=cache,target=/root/.npm-production npm ci --ignore-scripts --omit-dev

FROM node:22-alpine AS release

COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/package-lock.json /app/package-lock.json
# Copy the new scripts
COPY auth-handler.cjs /app/auth-handler.cjs
COPY entrypoint.sh /app/entrypoint.sh

ENV NODE_ENV=production

WORKDIR /app

RUN npm ci --ignore-scripts --omit-dev

#install supergateway
RUN npm install -g supergateway

# Make the entrypoint script executable
RUN chmod +x /app/entrypoint.sh

# Expose port for SSE and the new auth handler
EXPOSE 8000
EXPOSE 8001

ENV GOOGLE_CLIENT_ID=
ENV GOOGLE_CLIENT_SECRET=

# Set the entrypoint to the new script
ENTRYPOINT ["/app/entrypoint.sh"]