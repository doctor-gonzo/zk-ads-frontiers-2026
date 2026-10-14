# syntax=docker/dockerfile:1.7
# ZKAds render service: the Phala dstack (TEE) container, also run locally.
# Node, ffmpeg, Chromium and open fonts standing in for the macOS card
# typefaces. Build from the zkads folder: docker build -f enclave/Dockerfile .
FROM node:22-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates chromium ffmpeg fontconfig tini \
      fonts-dejavu-core fonts-jetbrains-mono fonts-lato fonts-liberation fonts-noto-color-emoji fonts-roboto-slab \
 && rm -rf /var/lib/apt/lists/*

# Look-alikes for Didot, Bodoni, Baskerville, Copperplate, Futura, American
# Typewriter and Avenir (see TYPEFACES in lib/concept.mjs), pinned by checksum.
ARG FONTS=https://raw.githubusercontent.com/google/fonts/bd8f81ddb5c74d5c8897b36ad88b440266245103/ofl
ARG DEST=/usr/share/fonts/truetype/zkads
ADD --checksum=sha256:c40f2293766a503bc70cce9e512ef844a4ccb7cbcde792fe2ea31d191917d8d6 ${FONTS}/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf ${DEST}/PlayfairDisplay.ttf
ADD --checksum=sha256:a5e26dc5e2e77fb2803a0bf02fd4f81ee136ec8dea863ccdb0c59a263b21378b ${FONTS}/playfairdisplay/PlayfairDisplay-Italic%5Bwght%5D.ttf ${DEST}/PlayfairDisplay-Italic.ttf
ADD --checksum=sha256:0d543665bd869819ffd7d46608804e245497ba835960832d44be89e561b0c717 ${FONTS}/librebodoni/LibreBodoni%5Bwght%5D.ttf ${DEST}/LibreBodoni.ttf
ADD --checksum=sha256:6a9b0c88764dcf6c094653e3c28da045fcebca48734254afdcbfec46b9ab4fcd ${FONTS}/librebodoni/LibreBodoni-Italic%5Bwght%5D.ttf ${DEST}/LibreBodoni-Italic.ttf
ADD --checksum=sha256:05a95421961341c5b2556285e8415df9db27dab4f4abe22b446b3c6a8b916c5d ${FONTS}/librebaskerville/LibreBaskerville%5Bwght%5D.ttf ${DEST}/LibreBaskerville.ttf
ADD --checksum=sha256:223959683dc73ec4437bd61fabaa4b3f22209e22855ffd3aee36ba61a5116e97 ${FONTS}/librebaskerville/LibreBaskerville-Italic%5Bwght%5D.ttf ${DEST}/LibreBaskerville-Italic.ttf
ADD --checksum=sha256:f4d83d34d1f6c741193e4acf4b3dff9531e5a67b6aa65228d00a7db72a4e0f34 ${FONTS}/cinzel/Cinzel%5Bwght%5D.ttf ${DEST}/Cinzel.ttf
ADD --checksum=sha256:6343b70971000b04c5d401c96ae08ce371086135e999d5e1e1413039c0213076 ${FONTS}/jost/Jost%5Bwght%5D.ttf ${DEST}/Jost.ttf
ADD --checksum=sha256:15a6f7e3e11f9e8e338a583a6fe03e8f6b1d9ce877efa3fe579282b6c1cb15fe ${FONTS}/jost/Jost-Italic%5Bwght%5D.ttf ${DEST}/Jost-Italic.ttf
ADD --checksum=sha256:72f793376f8e2841656bf21d77a5de010f2929bd6956a22ee848ad0c7eb978af ${FONTS}/courierprime/CourierPrime-Regular.ttf ${DEST}/CourierPrime-Regular.ttf
ADD --checksum=sha256:ff1f38786c849d1c41fa8e447960abdb2bd75fdfb0cfcdeb524fad65a5af3638 ${FONTS}/courierprime/CourierPrime-Bold.ttf ${DEST}/CourierPrime-Bold.ttf
ADD --checksum=sha256:f1b9a5829789f7e56432a9f3bc7665ef4531dbba1c112639e48bef39621a006b ${FONTS}/courierprime/CourierPrime-Italic.ttf ${DEST}/CourierPrime-Italic.ttf
ADD --checksum=sha256:f934d7142fb4784bf828da485b7dcbd90c0c80d514e9d49a5da0ed3a1ae2491d ${FONTS}/nunitosans/NunitoSans%5BYTLC%2Copsz%2Cwdth%2Cwght%5D.ttf ${DEST}/NunitoSans.ttf
ADD --checksum=sha256:d9d5db18f3c11221a4fbb553cbc709391c1179964c7eaa4466ef43c78aa4492f ${FONTS}/nunitosans/NunitoSans-Italic%5BYTLC%2Copsz%2Cwdth%2Cwght%5D.ttf ${DEST}/NunitoSans-Italic.ttf
RUN chmod 644 ${DEST}/*.ttf && fc-cache -f

WORKDIR /app
# Only the service code: .dockerignore admits nothing else (no keys, runs or private data).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY lib ./lib
COPY enclave/server.mjs ./enclave/
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8788 DATA_DIR=/data CHROME_PATH=/usr/bin/chromium CHROME_NO_SANDBOX=1
EXPOSE 8788
# tini as PID 1 forwards stop signals and reaps Chrome's helper processes.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "enclave/server.mjs"]
