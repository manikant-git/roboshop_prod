# syntax=docker/dockerfile:1

FROM maven:3.9.9-eclipse-temurin-21 AS builder
WORKDIR /app
COPY pom.xml .
RUN mvn -B dependency:go-offline
COPY src ./src
RUN mvn -B clean package -DskipTests && \
    mv target/shipping-2.0.jar shipping.jar

FROM eclipse-temurin:21-jre-alpine
EXPOSE 8080
WORKDIR /app
RUN apk add --no-cache curl && \
    addgroup -S roboshop && adduser -S roboshop -G roboshop && \
    chown -R roboshop:roboshop /app
COPY --from=builder /app/shipping.jar .
USER roboshop
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -f http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["java", "-jar", "shipping.jar"]
