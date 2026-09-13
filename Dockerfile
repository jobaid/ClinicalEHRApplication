# Frontend image: builds the Vite bundle, then serves it from nginx.
#   docker build -t <user>/medbill-web .
#
# The build stage is where secrets leak in a frontend image, so note what is NOT here: no .env is
# copied in (see .dockerignore), and the only build-time variable is the API base URL, which is a
# public address by definition. Vite inlines every VITE_* variable into the shipped JavaScript —
# anything secret passed here would be readable by every visitor. Put secrets in the API, never
# in this build.

FROM node:24-alpine AS build

WORKDIR /app

# npm ci installs exactly what package-lock.json pins and fails if the two disagree — the
# reproducible choice for an image build, where `npm install` could quietly resolve new versions.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Empty means "same origin": nginx below proxies /api to the API container, so the browser makes
# no cross-origin request and CORS never enters the picture. Override at build time to point the
# bundle at an API on a different host:
#   docker build --build-arg VITE_API_BASE=https://api.example.com -t <user>/medbill-web .
ARG VITE_API_BASE=""
ENV VITE_API_BASE=$VITE_API_BASE

# Demo credentials stay out of the image unless explicitly asked for. See SHOW_DEMO_LOGINS in
# src/app.jsx — with this unset, the passwords are absent from the bundle, not just hidden.
ARG VITE_SHOW_DEMO_LOGINS=""
ENV VITE_SHOW_DEMO_LOGINS=$VITE_SHOW_DEMO_LOGINS

RUN npm run build


FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
