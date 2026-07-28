package com.instana.robotshop.shipping;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class CartHelper {
    private static final Logger logger = LoggerFactory.getLogger(CartHelper.class);

    private final String baseUrl;
    private final HttpClient httpClient;

    public CartHelper(String baseUrl) {
        this.baseUrl = baseUrl;
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();
    }

    public String addToCart(String id, String data) {
        logger.info("add shipping to cart {}", id);

        try {
            HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + id))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(5))
                .POST(HttpRequest.BodyPublishers.ofString(data))
                .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() == 200) {
                return response.body();
            } else {
                logger.warn("Failed with code {}", response.statusCode());
            }
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            logger.warn("http client exception", e);
        }

        // this will be empty on error
        return "";
    }
}
