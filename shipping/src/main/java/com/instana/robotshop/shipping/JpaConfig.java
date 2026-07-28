package com.instana.robotshop.shipping;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import javax.sql.DataSource;
import org.springframework.boot.jdbc.DataSourceBuilder;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Bean;

@Configuration
public class JpaConfig {
    private static final Logger logger = LoggerFactory.getLogger(JpaConfig.class);

    @Bean
    public DataSource getDataSource() {
        String dbHost = System.getenv("DB_HOST") == null ? "mysql" : System.getenv("DB_HOST");
        String dbUser = System.getenv("DB_USER") == null ? "shipping" : System.getenv("DB_USER");
        String dbPassword = System.getenv("DB_PASSWORD") == null ? "RoboShop@1" : System.getenv("DB_PASSWORD");
        String JDBC_URL = String.format(
            "jdbc:mysql://%s/cities?useSSL=false&allowPublicKeyRetrieval=true&autoReconnect=true&serverTimezone=UTC",
            dbHost
        );

        logger.info("jdbc url {}", JDBC_URL);

        DataSourceBuilder bob = DataSourceBuilder.create();

        bob.driverClassName("com.mysql.cj.jdbc.Driver");
        bob.url(JDBC_URL);
        bob.username(dbUser);
        bob.password(dbPassword);

        return bob.build();
    }
}
