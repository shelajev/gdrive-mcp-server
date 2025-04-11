#!/bin/sh

# Start the auth handler in the background
echo "Starting auth handler..."
node /app/auth-handler.cjs &

# Ensure the token file exists before the main app tries to watch it
touch /tmp/auth_token.txt

# Start the main application
echo "Starting supergateway..."
supergateway --stdio "node dist/index.js" --port 8000 