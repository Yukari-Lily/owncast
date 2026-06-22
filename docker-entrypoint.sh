#!/bin/sh
# Fix data directory permissions on startup
chown -R owncast:owncast /app/data 2>/dev/null || true
# Drop to owncast user and run the server
exec su-exec owncast /app/owncast "$@"
