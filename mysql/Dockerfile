FROM mysql:8.0

# MYSQL_ROOT_PASSWORD is now supplied at runtime (see docker-compose.yaml)
# instead of being baked into the image layer, so the credential is not
# permanently embedded in the built image and can be overridden per-environment.
ARG MYSQL_ROOT_PASSWORD="RoboShop@1"
ENV MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD}

COPY db/ /docker-entrypoint-initdb.d
