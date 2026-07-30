package com.crucible.conformance;

import static org.junit.jupiter.api.Assertions.assertAll;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

@SpringBootTest
@Testcontainers
class ContainerReadinessTest {
    @Container
    static final GenericContainer<?> dependency =
            new GenericContainer<>(DockerImageName.parse("testcontainers/helloworld:1.2.0"))
                    .withExposedPorts(8080);

    @Autowired
    private ReadyState readyState;

    @Test
    void containerBackedContextIsReady() {
        assertAll(
                "the integration boundary is ready",
                () -> assertTrue(dependency.isRunning(), "dependency container must be running"),
                () -> assertTrue(readyState.isReady(), "Spring context must publish readiness"));
    }
}
