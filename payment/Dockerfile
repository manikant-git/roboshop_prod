# syntax=docker/dockerfile:1

FROM python:3.12-alpine AS builder
WORKDIR /app
RUN apk add --no-cache build-base linux-headers pcre-dev
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-alpine
EXPOSE 8080
WORKDIR /app
RUN apk add --no-cache pcre curl
RUN addgroup -S roboshop && adduser -S roboshop -G roboshop
COPY --from=builder /install /usr/local
COPY --chown=roboshop:roboshop payment.ini rabbitmq.py payment.py requirements.txt .
RUN chown -R roboshop:roboshop /app
USER roboshop
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://127.0.0.1:8080/health || exit 1
CMD ["uwsgi", "--ini", "payment.ini"]
