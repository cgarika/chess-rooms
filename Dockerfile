# GameNest chess server: the production image (2026-11-15, GameNest 2.0 on needasix.com).
# BASE is GameNest's shared base image, built by the box kit (gamenest-box: docker/base.Dockerfile): Node 26.5.0, onnxruntime-node and the
# chat filter's model. Built on its own, this file uses plain Node 26.5.0 (then the chat filter keeps its word list and the Maia bots need
# onnxruntime-node from package.json, which npm ci installs).
ARG BASE=node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb

# Stage 1: engine/maia2_rapid.onnx (85 MB, kept out of git), made from the official Maia-2 rapid checkpoint, which Hugging Face mirrors at a
# pinned revision; sha256-checked. If the export itself fails, the image is still built without it and the free bots play the old negamax
# (the box kit prints a WARNING); a failed download stops the build.
FROM python:3.11-slim-bookworm@sha256:a83ba18aef0f865b1a4a611c2cf460fe446f2795673bbb9fe43be570439e3b39 AS maia
ARG MAIA_REPO=shermansiu/maia2-rapid
ARG MAIA_REV=76c5d88b6d3606b06a69a5b0896e9a45caca6b97
ARG MAIA_PATH=original/model.pt
ARG MAIA_SHA256=65aae8465eed5e65df66a24ea7370715579f9e5435098d06fe18bdb1e267e997
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /maia
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.8.0 \
 && pip install maia2==0.11.0 onnx==1.23.2 onnxruntime==1.31.0 chess==1.11.2
COPY tools/fetch_maia_ckpt.py tools/maia_export.py engine/maia2_moves.json ./
RUN python -I fetch_maia_ckpt.py "$MAIA_REPO" "$MAIA_REV" "$MAIA_PATH" "$MAIA_SHA256" /maia/models/rapid_model.pt
RUN mkdir -p /out && (python -I maia_export.py /maia /out/maia2_rapid.onnx /maia/maia2_moves.json \
     || (rm -f /out/maia2_rapid.onnx && echo "WARNING: the Maia-2 export failed; this image has no engine/maia2_rapid.onnx"))

# Stage 2: the server.
FROM ${BASE}
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force \
 && if node -e "require.resolve('/opt/ort/node_modules/onnxruntime-node')" 2>/dev/null; then rm -rf node_modules/onnxruntime-node node_modules/onnxruntime-common; fi
COPY . .
COPY --from=maia /out/ ./engine/
USER node
EXPOSE 3000
CMD ["node", "server.js"]
