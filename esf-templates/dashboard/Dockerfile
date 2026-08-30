# Stage 1: build the React dashboard (client/) -- needs its devDependencies
# (vite, @vitejs/plugin-react) to build, which the final image never needs.
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# Stage 2: the actual server -- only its own runtime deps plus the client's
# built static files, nothing from stage 1's node_modules or source.
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
COPY --from=client-build /app/client/dist ./client/dist
EXPOSE 3000
CMD ["node", "server.js"]
