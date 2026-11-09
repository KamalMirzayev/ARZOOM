FROM node:22-alpine
WORKDIR /app
# Income documents are read on the server itself: PDF text (poppler) and OCR for scans and photos (Azerbaijani, Russian, English).
RUN apk add --no-cache poppler-utils tesseract-ocr tesseract-ocr-data-aze tesseract-ocr-data-rus tesseract-ocr-data-eng
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js reset-password.js ./
COPY lib ./lib
COPY db ./db
COPY public ./public
RUN mkdir -p /app/uploads && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
