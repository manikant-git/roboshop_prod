# Stan's Robot Shop - frontend
# Static AngularJS SPA served by nginx, running unprivileged on port 8080 so
# the pod can use a restricted securityContext behind the AWS ALB.
FROM nginx:1.27-alpine

RUN rm -f /etc/nginx/nginx.conf /etc/nginx/conf.d/default.conf /usr/share/nginx/html/index.html

RUN mkdir -p /var/cache/nginx/client_temp /var/cache/nginx/proxy_temp \
             /var/cache/nginx/fastcgi_temp /var/cache/nginx/uwsgi_temp \
             /var/cache/nginx/scgi_temp /etc/nginx/default.d && \
    touch /run/nginx.pid && \
    chown -R nginx:nginx /var/cache/nginx /etc/nginx /var/log/nginx /run/nginx.pid && \
    chmod -R 755 /etc/nginx

COPY nginx.conf /etc/nginx/nginx.conf
COPY proxy_params.conf /etc/nginx/proxy_params.conf
COPY static /usr/share/nginx/html/

RUN nginx -t -c /etc/nginx/nginx.conf

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1

STOPSIGNAL SIGQUIT
CMD ["nginx", "-g", "daemon off;"]
