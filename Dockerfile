FROM node:24-alpine

# Install the server
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/index.js ./

# Install the React App
COPY ./build /srv

EXPOSE 80
CMD ["node", "index.js"]
