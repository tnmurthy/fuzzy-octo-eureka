# =============================================================================
# arunachala-dashboard — Node.js application
# Base: docker.io/tnmurthy/default:latest
# =============================================================================

FROM docker.io/tnmurthy/default:latest

USER root

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

USER appuser

COPY --chown=appuser:appgroup package*.json ./
RUN npm ci --omit=dev

COPY --chown=appuser:appgroup . .

EXPOSE 3000
CMD ["node", "index.js"]
