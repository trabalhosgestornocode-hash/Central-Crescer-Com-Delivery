# =====================================================================
# Gateway WhatsApp — Baileys
# =====================================================================
# Roda SEPARADO do backend principal, como Private Service (Checkpoint C0
# — não provisionado ainda). Ao contrário do worker-martinbrower, não usa
# Chromium/Playwright: Baileys fala com o WhatsApp direto por WebSocket, sem
# navegador. Imagem base comum do Node basta.
# =====================================================================
FROM node:20-slim

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

# Dependências em camada própria: mudar código não reinstala tudo.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts

# Usuário sem privilégio — a imagem base já provê "node".
USER node

EXPOSE 8080

CMD ["node", "src/server.js"]
