# Stage 1: build the React dashboard (client/) -- needs its devDependencies
# (vite, @vitejs/plugin-react) to build, which the final image never needs.
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# Stage 2: build the rider PWA (rider-pwa/) -- delivery add-on (own_riders
# mode) only, but built unconditionally into every image regardless of
# whether this business has it switched on, per the addon spec's "code
# present and inert, not absent" rule for an off-by-default capability.
FROM node:20-alpine AS rider-pwa-build
WORKDIR /app/rider-pwa
COPY rider-pwa/package.json ./
RUN npm install
COPY rider-pwa/ ./
RUN npm run build

# Stage 3: the actual server -- only its own runtime deps plus both built
# static bundles, nothing from either build stage's node_modules or source.
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
COPY --from=client-build /app/client/dist ./client/dist
COPY --from=rider-pwa-build /app/rider-pwa/dist ./rider-pwa/dist
EXPOSE 3000
CMD ["node", "server.js"]
