# Build the site first: pnpm build --filter @ecmaos/kernel
# Then, from the repository root: docker build -f hosting/Dockerfile -t ecmaos .
FROM nginx:alpine
COPY hosting/nginx.conf /etc/nginx/conf.d/default.conf
COPY core/kernel/dist /usr/share/nginx/html
