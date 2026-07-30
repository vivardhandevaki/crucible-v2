package com.crucible.hello;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest
class GreetingApplicationTest {
    @Autowired
    private GreetingService greetingService;

    @Test
    void greetsWorldFromSpringContext() {
        assertEquals("Hello, world!", greetingService.greet());
    }
}
